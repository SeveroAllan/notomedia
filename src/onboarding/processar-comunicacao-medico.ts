import {afirmaFatoDaAgendaSemFerramenta,consultaNaoIdentificada,normalizarBaloesSemPontoEVirgula} from './conversador-medico.js';
import { ERRO_CONVERSA, periodoDecisao, faltasIntroducaoLink, validarAcaoConversa, type ConversadorMedico, type DecisaoConversa, type FatosConversa } from './conversador-medico.js';
import { FALA_CONCLUSAO_AGENDA_CONECTADA, FALA_CONCLUSAO_AGENDA_FALHA_ACESSO, FALA_CONCLUSAO_AGENDA_FALHA_INSTAVEL, FALA_PEDIDO_CONEXAO_AGENDA, FALA_PROTECAO_CREDENCIAL_AGENDA, FALA_SEGURANCA_LINK_AGENDA } from './falas.js';
import { contemCredencialAgenda } from '../cofre/links.js';
import { sanitizarErroFiscal } from '../observabilidade/erros.js';
import { sanitizarTextoMedico } from './contexto-conversa-medico.js';
import { orquestrarComunicacao } from './orquestrar-comunicacao.js';
import { montarPerguntaComunicacao } from './regras/decidir-proxima-acao.js';
import type { HistoricoComunicacaoRepositorio } from './historico-comunicacao-repositorio.js';
import type { ProximaAcaoNoto, ExtratorRespostaMedico } from './regras/decidir-proxima-acao.js';
import type { MemoriaConversa, PostgresMemoriaConversaMedico } from './memoria-conversa.js';
import type { ReacaoMedico } from '../whatsapp/reagir-mensagem.js';
import { CATALOGO_FERRAMENTAS } from './ferramentas-conversa.js';
import { planejarPorSemantica, reconciliarInterpretacaoSemantica, type InterpretacaoSemantica, type InterpretadorSemantico } from './interpretador-semantico.js';

type EntradaLegada = Parameters<typeof orquestrarComunicacao>[0];
export function escopoMemoriaPorOrigem(m:{papel?:'medico'|'noto';origemOperador?:'medico'|'secretaria'|'conta'|null}):'medico'|'conta'|null {
  if(m.papel==='noto')return null;
  if(m.origemOperador==='conta'||m.origemOperador==='secretaria')return 'conta';
  if(m.origemOperador===undefined||m.origemOperador===null||m.origemOperador==='medico')return 'medico';
  return null;
}
export function origemPodeVirarMemoriaMedico(m:{papel?:'medico'|'noto';origemOperador?:'medico'|'secretaria'|'conta'|null}):boolean {
  return escopoMemoriaPorOrigem(m)==='medico';
}

export type EstadoComunicacaoMedico = Pick<EntradaLegada,'nomeMedico'|'estado'>;
export interface ResultadoAcaoConversa {
  dados?: unknown; jaRespondida?: boolean; falaAssinada?: string[]; falaMemoria?: string[];
}
export interface ContextoAcaoConversa {
  medicoId: string; conversa: string; chave: string; texto: string; agora: Date; chavePergunta?: string; mensagemEm?: Date; contatoOperador?: string;
  fatos: FatosConversa; narrar: (dados: unknown) => Promise<string[]>;
}
export interface FerramentasConversa {
  lerFatos: (medicoId:string, agora:Date) => Promise<FatosConversa>;
  permitidas: (fatos:FatosConversa) => readonly string[];
  guardarPeriodo: (medicoId:string, desde:string) => Promise<void>;
  executar: (decisao:DecisaoConversa, contexto:ContextoAcaoConversa) => Promise<ResultadoAcaoConversa>;
}
interface Dependencias {
  ativo:boolean; conversaLivreAtiva?:boolean; orcamentoChamadas?:number; memoriaPersistida?:PostgresMemoriaConversaMedico;
  conversador?:Pick<ConversadorMedico,'responder'|'resumir'> & Partial<Pick<ConversadorMedico,'compactar'>>; ferramentas?:FerramentasConversa; interpretadorSemantico?:Pick<InterpretadorSemantico,'interpretar'>;
  aoReagir?:(reacao:ReacaoMedico)=>Promise<void>; aoConversar?:(fala:string[],chave:string,falaMemoria?:string[])=>Promise<void>;
  memoriaConversa?:MemoriaConversa; extratorResposta?:ExtratorRespostaMedico; historico:HistoricoComunicacaoRepositorio;
  lerEstado:(medicoId:string,agora:Date)=>Promise<EstadoComunicacaoMedico|null>;
  tratarCofre?:(medicoId:string,texto:string,contatoOperador?:string)=>Promise<boolean>;
  aoDecidir?:(acao:ProximaAcaoNoto,chave:string,contexto?:{nomeMedico?:string})=>Promise<void>;
  log:(nivel:'info'|'erro',mensagem:string)=>void;
}
// Mensagem que é só um CPF válido, telefone, data ou valor (modo sem agenda digital) não é credencial.
export function dadoCadastralIsolado(texto:string):boolean {
  const t=texto.trim();
  const cpf=t.match(/^(\d{3})\.?(\d{3})\.?(\d{3})-?(\d{2})$/);
  if(cpf) {
    const d=(cpf[1]+cpf[2]+cpf[3]+cpf[4]).split('').map(Number);
    const dv=(n:number)=>{const r=d.slice(0,n).reduce((a,x,i)=>a+x*(n+1-i),0)*10%11;return r===10?0:r;};
    if(!d.every(n=>n===d[0]) && dv(9)===d[9] && dv(10)===d[10]) return true;
  }
  return /^(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}-?\d{4}$/.test(t) || /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(t) || /^R\$\s?\d[\d.]*(?:,\d{2})?$/.test(t);
}
const falaSemMarcaLegada=(t:string)=>t!=='O link seguro já foi solicitado nesta conversa. Aguardo a conexão. Isso não confirma envio.';
const processamentos = new Map<string,Promise<ProximaAcaoNoto>>();
export async function processarComunicacaoMedico(
  entrada:Pick<EntradaLegada,'medicoId'|'chaveProcessamento'|'respostaMedico'> & {agora:Date;chaveConversa?:string;chavePergunta?:string;contatoOperador?:string;origemOperador?:'conta'|'medico'|'secretaria';eventoAgenda?:{agenda:'tribemd'|'amplimed';conectado:boolean;falhaAcesso?:boolean}}, deps:Dependencias
):Promise<ProximaAcaoNoto> {
  if(!deps.ativo) return {tipo:'nenhuma'};
  const executar = async ():Promise<ProximaAcaoNoto> => {
    const {medicoId,chaveProcessamento:chave,chaveConversa:conversa,agora}=entrada;
    const memoria=deps.memoriaPersistida;
    const enviar = async (fala:string[], falaMemoria?:string[], sufixo='') => {
      const chaveEnvio=chave+sufixo;
      const falaVisivel=normalizarBaloesSemPontoEVirgula(fala);
      const falaPersistida=falaMemoria?normalizarBaloesSemPontoEVirgula(falaMemoria):falaVisivel;
      if(!falaVisivel.length) return;
      if(falaMemoria) await deps.aoConversar?.(falaVisivel,chaveEnvio,falaPersistida);
      else await deps.aoConversar?.(falaVisivel,chaveEnvio);
      if(conversa && memoria) { try {await memoria.registrarFala(medicoId,conversa,`noto:${chaveEnvio}`,falaPersistida.join('\n'),'noto');} catch {deps.log('erro','CONVERSA_MEMORIA_FALHOU');} }
    };
    try {
      if(!deps.conversaLivreAtiva || !entrada.respostaMedico && !entrada.eventoAgenda) {
        if(entrada.respostaMedico && await deps.tratarCofre?.(medicoId,entrada.respostaMedico.texto,entrada.contatoOperador)) return {tipo:'nenhuma'};
        if(entrada.respostaMedico && /\b(senha|password|token|secret|segredo|api[_ -]?key)\b/i.test(entrada.respostaMedico.texto)) return {tipo:'nenhuma'};
        const estado=await deps.lerEstado(medicoId,agora);
        if(!estado) return {tipo:'nenhuma'};
        const respostaMedico=entrada.respostaMedico?{...entrada.respostaMedico,texto:sanitizarTextoMedico(entrada.respostaMedico.texto),
          ultimaFalaNoto:undefined,mensagensSeguras:conversa&&deps.memoriaConversa?await deps.memoriaConversa.ler(medicoId,conversa):entrada.respostaMedico.mensagensSeguras}:undefined;
        const acao=await orquestrarComunicacao({...entrada,...estado,respostaMedico},{historico:deps.historico,log:deps.log,extratorResposta:deps.extratorResposta});
        await deps.aoDecidir?.(acao,chave,{nomeMedico:estado.nomeMedico});
        if(conversa && deps.memoriaConversa) {
          if(entrada.respostaMedico) {
            try { await deps.memoriaConversa.registrar(medicoId,conversa,`medico:${chave}`,sanitizarTextoMedico(entrada.respostaMedico.texto),'medico',entrada.origemOperador??'medico'); }
            catch { deps.log('erro','CONVERSA_MEMORIA_FALHOU'); }
          }
          const pergunta=montarPerguntaComunicacao(acao);
          if(pergunta) await deps.memoriaConversa.registrar(medicoId,conversa,`noto:${chave}`,pergunta,'noto');
        }
        return acao;
      }
      // Conserva as chaves e o consumo da reserva existentes, antes de qualquer efeito ou IA.
      const reserva=entrada.eventoAgenda ? `agenda:conclusao:${chave}` : `conversa:agenda:${chave}`;
      if(!await deps.historico.reservar(medicoId,'simulado',reserva)) return {tipo:'nenhuma'};
      await deps.historico.liberar(medicoId,'simulado',reserva);
      if(entrada.respostaMedico && contemCredencialAgenda(entrada.respostaMedico.texto) && !dadoCadastralIsolado(entrada.respostaMedico.texto)) {
        deps.log('erro','COMUNICACAO_ENTRADA_PROTEGIDA');
        await enviar([FALA_PROTECAO_CREDENCIAL_AGENDA]); return {tipo:'nenhuma'};
      }
      if(entrada.eventoAgenda && !['tribemd','amplimed'].includes(entrada.eventoAgenda.agenda)) throw Error('AGENDA_NAO_SUPORTADA');
      if(!conversa || !memoria || !deps.conversador || !deps.ferramentas) throw Error('CONVERSA_NAO_CONFIGURADA');
      const texto=sanitizarTextoMedico(entrada.respostaMedico?.texto??'');
      const estado=await deps.lerEstado(medicoId,agora);
      if (!estado) throw Error('COMUNICACAO_ESTADO_AUSENTE');
      if(estado.nomeMedico && estado.estado.fiscal.certificado==='ok' && estado.estado.fiscal.dadosFiscais==='ok' && !await memoria.temBoasVindas(medicoId,conversa)) {
        const historico=await deps.historico.ler(medicoId,'simulado');
        if(!historico.boasVindasComunicadas) {
          const acao=await orquestrarComunicacao({...entrada,...estado,respostaMedico:undefined},{historico:deps.historico,log:deps.log});
          await deps.aoDecidir?.(acao,chave,{nomeMedico:estado.nomeMedico});
          if(entrada.respostaMedico) {
            try { await memoria.registrarFala(medicoId,conversa,`medico:${chave}`,texto,'medico',entrada.origemOperador??'medico'); }
            catch { deps.log('erro','CONVERSA_MEMORIA_FALHOU'); }
          }
          if(acao.tipo==='boas_vindas') return acao;
        }
      }
      const contexto=await memoria.lerContextoParaModelo(medicoId,conversa);
      const fatos=await deps.ferramentas.lerFatos(medicoId,agora);
      if(fatos.ambiente!=='homologacao') {
        deps.log('info','CONVERSA_AMBIENTE_NAO_HABILITADO');
        if(fatos.ambiente==null) await enviar(['Não consegui continuar a configuração deste profissional com segurança. O ambiente de operação ainda não está habilitado. Não associei a agenda nem emiti nada.']);
        return {tipo:'nenhuma'};
      }
      fatos.semAgendaDigital=contexto.marcas.semAgendaDigital && !fatos.agenda.conectada;
      fatos.entregasRecentes=contexto.entregasRecentes;
      if(entrada.eventoAgenda) fatos.eventoAgenda=entrada.eventoAgenda;
      fatos.falasRecentesNoto=(await memoria.lerUltimasFalasNoto(medicoId,conversa)).filter(falaSemMarcaLegada);
      fatos.listaRecente=(fatos.falasRecentesNoto as string[]).slice(-6).some(t=>/^\d+ consultas? sem nota desde \d{2}\/\d{2}\/\d{4}/i.test(t));
      fatos.tarefaEmCurso=['confirmado','processando'].includes(fatos.lote?.estado??'');
      fatos.propostaPendente=fatos.lote?.estado==='aguardando_confirmacao_lote'?{tipo:'lote',pergunta:fatos.lote.pergunta??null}:null;
      fatos.homologacaoInformada=[...contexto.historicoRecente,contexto.resumo?.resumo??'',...(fatos.falasRecentesNoto as string[])]
        .some(t=>/homologa[cç][aã]o|[eé] teste/i.test(t));
      fatos.avisarHomologacao=!!entrada.eventoAgenda?.conectado&&!fatos.homologacaoInformada;
      const mensagens=contexto.historicoRecente.filter(falaSemMarcaLegada);
      const linhaDoTempo=(contexto.linhaDoTempo??[]).map(c=>c.resumo);
      const memoriasSemanticas=(contexto.memoriasSemanticas??[]).map(({escopo,chave,categoria,valor})=>({escopo,chave,categoria,valor}));
      let chamadas=0; const orcamento=deps.orcamentoChamadas??2;
      const reservaPosFerramenta=orcamento>=5?2:0;
      const podeCorrigir=()=>chamadas<orcamento-reservaPosFerramenta;
      let planoAtual=contexto.plano??null;
      const planoMedicosEmCurso=()=>planoAtual?.objetivo==='configurar:medicos'&&planoAtual.etapa!=='concluido';
      let interpretacaoSemantica:InterpretacaoSemantica|null=null;
      const decidir = async (acoesPermitidas:readonly string[], resultadoFerramenta?:unknown,correcao?:{motivo:string;faltou:string[]},podeAgirAposFerramenta=false) => {
        if(++chamadas>orcamento) throw Error('ORCAMENTO_CONVERSA_EXCEDIDO');
        const resposta=await deps.conversador!.responder({texto,mensagens,resumo:contexto.resumo?.resumo??null,linhaDoTempo,memoriasSemanticas,plano:planoAtual,fatos,agora,acoesPermitidas,resultadoFerramenta,podeAgirAposFerramenta,correcao,interpretacaoSemantica});
        if(resposta.plano) {
          planoAtual=resposta.plano;
          await memoria.registrarPlano(medicoId,conversa,planoAtual);
        }
        return resposta;
      };
      const narrar=async (resultado:unknown) => chamadas>=orcamento ? [ERRO_CONVERSA] : (await decidir([],resultado)).fala;
      let permitidas=deps.ferramentas.permitidas(fatos);
      if(deps.interpretadorSemantico&&entrada.respostaMedico) {
        if(++chamadas>orcamento) throw Error('ORCAMENTO_CONVERSA_EXCEDIDO');
        interpretacaoSemantica=await deps.interpretadorSemantico.interpretar({texto,mensagens,resumo:contexto.resumo?.resumo??null,linhaDoTempo,memoriasSemanticas,plano:contexto.plano??null,fatos,agora});
        if(interpretacaoSemantica)interpretacaoSemantica=reconciliarInterpretacaoSemantica(interpretacaoSemantica,fatos);
        if(interpretacaoSemantica&&interpretacaoSemantica.confianca<.8)interpretacaoSemantica=null;
      }
      if(deps.interpretadorSemantico){
        const escolhaNecessaria=!!interpretacaoSemantica?.permissaoNecessaria&&interpretacaoSemantica.faltando.includes('permissao');
        if(!escolhaNecessaria)permitidas=permitidas.filter(a=>a!=='pedir_link_permissoes');
      }
      let decisao=interpretacaoSemantica?planejarPorSemantica(interpretacaoSemantica,fatos,permitidas):null;
      // Resposta à pergunta de agenda retoma o médico já guardado no plano; não volta ao certificado nem pede o nome de novo.
      if(planoMedicosEmCurso()&&planoAtual?.etapa==='escolher_agenda'&&interpretacaoSemantica?.agendaAlvo&&planoAtual.medicos?.length===1){
        const agenda=interpretacaoSemantica.agendaAlvo;
        const conectada=fatos.agendas?.[agenda]?.conectada ?? (fatos.agenda.conectada&&fatos.agenda.nome?.toLowerCase()===agenda);
        if(conectada&&permitidas.includes('associar_medico_agenda')){
          decisao={fala:[`Vou associar ${planoAtual.medicos[0]} à ${agenda==='tribemd'?'TribeMD':'Amplimed'} e conferir se as consultas identificam esse profissional.`],acao:'associar_medico_agenda',parametros:{agenda,medicos:[planoAtual.medicos[0]]}};
        }else if(!conectada&&permitidas.includes('pedir_link_agenda')){
          decisao={fala:[`Vou conectar a ${agenda==='tribemd'?'TribeMD':'Amplimed'} somente para leitura da agenda e depois retomo a associação de ${planoAtual.medicos[0]}.`,'Login e senha ficam apenas no link seguro. Conectar a agenda não envia mensagem a pacientes. Aqui está o link seguro:'],acao:'pedir_link_agenda',parametros:{agenda}};
        }
      }
      if(interpretacaoSemantica&&interpretacaoSemantica.confianca>=.8) {
        const interrupcaoConversacional=planoMedicosEmCurso() &&
          !(interpretacaoSemantica.objetivo==='configurar'&&interpretacaoSemantica.objeto==='medicos') &&
          (interpretacaoSemantica.dominio==='conversa'||interpretacaoSemantica.dominio==='outro'||
           ['responder','conversar','desconhecido'].includes(interpretacaoSemantica.objetivo));
        if(!interrupcaoConversacional){
          const configuraMedicos=interpretacaoSemantica.objetivo==='configurar'&&interpretacaoSemantica.objeto==='medicos';
          const medicosPlano=configuraMedicos
            ? [...new Set([...(interpretacaoSemantica.medico?.trim()?[interpretacaoSemantica.medico.trim()]:[]),...(planoAtual?.medicos??[])])].slice(0,12)
            : [];
          const agendaPlano=configuraMedicos ? (interpretacaoSemantica.agendaAlvo??planoAtual?.agenda??null) : null;
          planoAtual=configuraMedicos ? {
            objetivo:'configurar:medicos',
            etapa:decisao?.acao==='pedir_link_certificado'?'aguardando_certificado':decisao?.acao==='pedir_link_agenda'?'conectar_agenda':decisao?.acao==='associar_medico_agenda'?'associar_agenda':interpretacaoSemantica.faltando.length?'resolver_faltantes':'continuar',
            faltando:decisao?.acao==='pedir_link_certificado'?['certificado']:[...interpretacaoSemantica.faltando],
            proximosPassos:decisao?.acao==='pedir_link_certificado'?['validar_certificado','definir_agenda','associar_medico_agenda']:decisao?.acao?[decisao.acao]:[],
            aguardando:decisao?.acao==='pedir_link_certificado'?'validacao do certificado':interpretacaoSemantica.faltando[0]??null,
            ...(medicosPlano.length?{medicos:medicosPlano}:{}),
            ...(agendaPlano?{agenda:agendaPlano}: {})
          } : {
            objetivo:[interpretacaoSemantica.objetivo,interpretacaoSemantica.objeto].filter(Boolean).join(':'),
            etapa:decisao?.acao?'executar_capacidade':'resolver_faltantes',
            faltando:[...interpretacaoSemantica.faltando],
            proximosPassos:decisao?.acao?[decisao.acao]:[],
            aguardando:interpretacaoSemantica.faltando[0]??null
          };
          await memoria.registrarPlano(medicoId,conversa,planoAtual);
        }
      }
      if(!decisao&&entrada.eventoAgenda?.conectado&&planoMedicosEmCurso()&&planoAtual?.medicos?.length===1&&permitidas.includes('associar_medico_agenda')){
        const agenda=entrada.eventoAgenda.agenda==='amplimed'?'amplimed':'tribemd';
        decisao={fala:[`A ${agenda==='tribemd'?'TribeMD':'Amplimed'} conectou. Vou retomar a configuração de ${planoAtual.medicos[0]} e verificar a associação.`],acao:'associar_medico_agenda',parametros:{agenda,medicos:[planoAtual.medicos[0]]}};
      }
      if(!decisao) decisao=await decidir(permitidas);
      if(entrada.respostaMedico) {
        try { await memoria.registrarFala(medicoId,conversa,`medico:${chave}`,texto,'medico',entrada.origemOperador??'medico'); }
        catch { deps.log('erro','CONVERSA_MEMORIA_FALHOU'); }
      }
      // Pedido explícito de novo dia/período substitui a proposta pendente (o iniciar a abandona):
      // não é resposta à pergunta, então não força parametros.confirmacao.
      const trocaEscopo=decisao.acao==='iniciar_lote'&&permitidas.includes('iniciar_lote')
        &&!!(decisao.parametros?.dia||decisao.parametros?.desde||decisao.parametros?.periodo);
      if(entrada.respostaMedico && fatos.lote?.estado==='aguardando_confirmacao_lote' && !decisao.parametros?.confirmacao && !trocaEscopo) {
        deps.log('info','CONVERSA_CONFIRMACAO_CORRIGIR');
        decisao=await decidir(permitidas,undefined,{motivo:'preencha parametros.confirmacao sobre a pergunta pendente',faltou:[]});
        if(!decisao.parametros?.confirmacao) {
          deps.log('info','CONVERSA_CONFIRMACAO_AUSENTE');
          await enviar([fatos.lote.pergunta??ERRO_CONVERSA]);
          return {tipo:'nenhuma'};
        }
      }
      if(podeCorrigir() && afirmaFatoDaAgendaSemFerramenta(texto,decisao,fatos,permitidas)) {
        deps.log('info','CONVERSA_FATO_SEM_FERRAMENTA');
        decisao=await decidir(permitidas,undefined,{motivo:'a resposta afirma fatos da agenda sem consultar: para conferir use listar_pendencias; para preparar total/proposta use iniciar_lote (exige confirmação antes de emitir). Anuncie a ação ou não afirme quantidade, ausência nem bloqueio',faltou:[]});
        if(afirmaFatoDaAgendaSemFerramenta(texto,decisao,fatos,permitidas)) {
          deps.log('erro','CONVERSA_FATO_SEM_FERRAMENTA_PERSISTE');
          await enviar(['Não vou chutar: preciso consultar a agenda para te responder isso. Pode repetir o pedido?']);
          return {tipo:'nenhuma'};
        }
      }
      let motivo=validarAcaoConversa(decisao,fatos,permitidas,texto,agora);
      if(podeCorrigir() && motivo==='LEITURA_ATUAL_SEM_ACAO') {
        decisao=await decidir(permitidas,undefined,{motivo:'o pedido atual é conferir consultas, não uma pergunta de funcionamento. Use listar_pendencias com o recorte atual; se faltar identificação, pergunte só o dado necessário. Não repita oferta futura.',faltou:[]});
        motivo=validarAcaoConversa(decisao,fatos,permitidas,texto,agora);
      }
      if(podeCorrigir() && motivo==='PACIENTE_NECESSARIO') {
        decisao=await decidir([],undefined,{motivo:'o paciente e a consulta ainda não foram identificados; pergunte nome e data/horário, sem herdar o período anterior nem listar todos',faltou:['paciente','consulta']});
        motivo=validarAcaoConversa(decisao,fatos,[],texto,agora);
      }
      if(podeCorrigir() && motivo==='anuncie a acao com suas palavras') {
        deps.log('info','CONVERSA_ANUNCIO_CORRIGIR');
        decisao=await decidir(permitidas,undefined,{motivo,faltou:[]});
        motivo=validarAcaoConversa(decisao,fatos,permitidas,texto,agora);
      }
      if(podeCorrigir() && motivo==='LISTA_EM_VEZ_DE_LOTE' && permitidas.includes('iniciar_lote')) {
        // Lote anterior terminou com erro: listar de novo não destrava; a releitura ao vivo vem do iniciar_lote (o médico confirma antes).
        deps.log('info','CONVERSA_LISTA_EM_VEZ_DE_LOTE');
        decisao=await decidir(permitidas.filter(a=>a!=='listar_pendencias'),undefined,{motivo:'The last batch ended with an error. If the doctor wants to try again, use iniciar_lote and announce the action. Otherwise use acao=null.',faltou:[]});
        motivo=validarAcaoConversa(decisao,fatos,permitidas,texto,agora);
      }
      if(podeCorrigir() && (motivo==='ENVIO_SEM_ACAO'||motivo==='PEDIDO_REENVIO_AUSENTE')) {
        decisao=await decidir(permitidas,undefined,{motivo:'Não existe envio em andamento. Pedido claro de PDF: use reenviar_nota_medico com dia e evidencia literal; se faltar data, pergunte. Não prometa tarefa sem ação.',faltou:[]});
        motivo=validarAcaoConversa(decisao,fatos,permitidas,texto,agora);
      }
      if(podeCorrigir() && motivo==='PERIODO_NECESSARIO') {
        deps.log('info','CONVERSA_PERIODO_CORRIGIR');
        decisao=await decidir(permitidas,undefined,{motivo:'a acao precisa de parametros.desde ISO (use calendario com o periodo que o medico disse)',faltou:['parametros.desde']});
        motivo=validarAcaoConversa(decisao,fatos,permitidas,texto,agora);
      }
      if(podeCorrigir() && motivo==='CONCLUSAO_SEM_ACAO') {
        deps.log('info','CONVERSA_CONCLUSAO_SEM_ACAO');
        decisao=await decidir([],undefined,{motivo:'o turno de conclusão só anuncia o resultado: conectado → avise que conectou e proponha o próximo passo; falha → explique o impedimento real e ofereça novo link; acao null',faltou:[]});
        motivo=validarAcaoConversa(decisao,fatos,permitidas,texto,agora);
      }
      if (motivo==='CONCLUSAO_SEM_ACAO' && fatos.eventoAgenda) {
        // Recusa persistente no turno de conclusão: texto determinístico no lugar de ação ou erro genérico.
        const ev=fatos.eventoAgenda, nome=ev.agenda==='amplimed'?'Amplimed':'TribeMD';
        deps.log('info','CONVERSA_CONCLUSAO_TEMPLATE');
        decisao={fala:[ev.conectado?FALA_CONCLUSAO_AGENDA_CONECTADA(nome):ev.falhaAcesso?FALA_CONCLUSAO_AGENDA_FALHA_ACESSO(nome):FALA_CONCLUSAO_AGENDA_FALHA_INSTAVEL(nome)],acao:null};
        motivo=null;
      }
      if(podeCorrigir() && motivo==='CONEXAO_EM_VERIFICACAO') {
        deps.log('info','CONVERSA_CONEXAO_EM_VERIFICACAO');
        decisao=await decidir(permitidas.filter(a=>a!=='pedir_link_agenda'&&a!=='pedir_link_permissoes'),undefined,{motivo:'o acesso da agenda está em verificação; confirme em 1 frase que você avisa assim que concluir, sem nova ação nem novo link',faltou:[]});
        motivo=validarAcaoConversa(decisao,fatos,permitidas,texto,agora);
      }
      const corrigirIntroducao=podeCorrigir() && decisao.acao==='pedir_link_agenda' && ['INTRODUCAO_INCOMPLETA','BALOES_LINK_EXCEDIDOS'].includes(motivo??'');
      if(corrigirIntroducao) {
        deps.log('info',`CONVERSA_INTRODUCAO_CORRIGIR ${motivo}`);
        decisao=await decidir(['pedir_link_agenda'],undefined,{motivo:motivo!,faltou:faltasIntroducaoLink(decisao.fala)});
        const permissaoInventada=/n[aã]o (?:tenho|temos|possuo|h[aá])[^.!?]*permiss[aã]o/i.test(decisao.fala.join(' '));
        motivo=decisao.acao==='pedir_link_agenda' && !permissaoInventada ? validarAcaoConversa(decisao,fatos,permitidas,texto,agora) : 'INTRODUCAO_NAO_CORRIGIDA';
      }
      // Fallback determinístico: introdução recusada após a correção usa o template verificado;
      // os demais gates (conexão, agenda, evidência, permissão) são revalidados antes de executar.
      const motivoIntroducao = motivo==='INTRODUCAO_INCOMPLETA' || motivo==='BALOES_LINK_EXCEDIDOS';
      if (motivoIntroducao && decisao.acao==='pedir_link_agenda') {
        const comTemplate: DecisaoConversa = { ...decisao, fala: [FALA_PEDIDO_CONEXAO_AGENDA, FALA_SEGURANCA_LINK_AGENDA] };
        const motivoRestante = validarAcaoConversa(comTemplate, fatos, permitidas, texto, agora, { introducaoVerificada: true });
        if (!motivoRestante) { deps.log('info', `CONVERSA_INTRODUCAO_TEMPLATE ${motivo}`); decisao = comTemplate; motivo = null; }
      }
      // A correção pode trocar ação por fala: revalide o contrato completo antes de qualquer saída.
      if(!motivo&&afirmaFatoDaAgendaSemFerramenta(texto,decisao,fatos,permitidas))motivo='FATO_AGENDA_NAO_VERIFICADO';
      let fala=decisao.fala, falaMemoria:string[]|undefined, ferramentasExecutadas=0;
      if(motivo) {
        deps.log('erro',`CONVERSA_ACAO_RECUSADA ${motivo}`);
        if(decisao.acao&&decisao.acao!=='nenhuma') {
          try { await memoria.registrarEventoTrabalho(medicoId,conversa,chave,decisao.acao,'recusada',{motivo}); } catch { /* Enriquecimento opcional em rolling deploy. */ }
        }
        fala=motivo==='PACIENTE_NECESSARIO'?['Qual é o nome do paciente e a data ou horário da consulta que você quer escolher? Não preparei nem emiti nada.']:motivo==='LEITURA_ATUAL_SEM_ACAO'?['Não consegui iniciar a conferência desse pedido. Não preparei nem emiti nada.']:motivo==='FATO_AGENDA_NAO_VERIFICADO' ? [consultaNaoIdentificada(texto)?'Qual é o nome do paciente e a data ou horário da consulta que você quer escolher? Não preparei nem emiti nada.':'Preciso consultar a agenda antes de afirmar o estado dessa consulta. Não preparei nem emiti nada.'] : motivo==='PEDIDO_REENVIO_AUSENTE'||motivo==='ENVIO_SEM_ACAO'?['Não fiz nenhum envio. Qual é a data da consulta cujo PDF você quer receber?']:corrigirIntroducao ? [ERRO_CONVERSA] : await narrar({ok:false,motivo,executada:false});
      } else {
        const desde=periodoDecisao(decisao,agora,texto);
        if(desde) { await deps.ferramentas.guardarPeriodo(medicoId,desde); fatos.periodo={desde,origem:'resposta_atual'}; }
        if(decisao.acao==='registrar_modo_sem_agenda') {
          await memoria.registrarMarca(medicoId,conversa,'sem_agenda_digital');
        } else if(decisao.acao && decisao.acao!=='nenhuma' || fatos.lote?.estado==='aguardando_confirmacao_lote' && decisao.parametros?.confirmacao) {
          const executarFerramenta=async (atual:DecisaoConversa,sufixo:string) => {
            if(atual.acao==='consultar_agenda'&&interpretacaoSemantica?.medida) atual={...atual,parametros:{...atual.parametros,medida:interpretacaoSemantica.medida}};
            const limiteBaloes=atual.acao==='pedir_link_agenda'?2:3;
            atual={...atual,fala:normalizarBaloesSemPontoEVirgula(atual.fala,limiteBaloes)};
            if(['consultar_agenda','listar_pendencias','iniciar_lote'].includes(atual.acao??'')) await enviar(atual.fala.slice(0,1),undefined,sufixo);
            ferramentasExecutadas++;
            const ferramenta=atual.acao??'nenhuma';
            const parametros=atual.parametros??{};
            const metaEntrada=Object.fromEntries(Object.entries({
              agenda:parametros.agenda,medida:parametros.medida,desde:parametros.desde,ate:parametros.ate,dia:parametros.dia,permissao:parametros.permissao
            }).filter(([,v])=>v!==undefined));
            try { await memoria.registrarEventoTrabalho(medicoId,conversa,chave,ferramenta,'iniciada',metaEntrada); } catch { /* Enriquecimento opcional. */ }
            try {
              const resultado=await deps.ferramentas!.executar(atual,{medicoId,conversa,chave,texto,agora,chavePergunta:entrada.chavePergunta,mensagemEm:entrada.respostaMedico?.enviadaEm ? new Date(entrada.respostaMedico.enviadaEm) : new Date(NaN),contatoOperador:entrada.contatoOperador,fatos,narrar});
              const dados=resultado.dados as {ok?:boolean;motivo?:string;modo?:string;profissionais?:unknown[];aguardandoCertificado?:boolean;linksAtivos?:unknown[];prontos?:unknown[];identificacao?:string;agenda?:string}|undefined;
              if(ferramenta==='descobrir_medicos_agenda'&&dados?.ok===true&&dados.modo==='descoberta_medicos'&&Array.isArray(dados.profissionais)){
                planoAtual={objetivo:'configurar:medicos',etapa:'selecionar_medicos',faltando:['medicos'],proximosPassos:['pedir_link_certificado'],aguardando:'medicos',...(planoAtual?.agenda?{agenda:planoAtual.agenda}:{})};
                await memoria.registrarPlano(medicoId,conversa,planoAtual);
              }else if(ferramenta==='pedir_link_certificado'&&dados?.ok===true){
                const medicos=atual.parametros?.medicos??planoAtual?.medicos??[];
                const aguardando=dados.aguardandoCertificado===true;
                planoAtual={objetivo:'configurar:medicos',etapa:aguardando?'aguardando_certificado':'escolher_agenda',
                  faltando:[aguardando?'certificado':'agenda'],proximosPassos:aguardando?['validar_certificado','definir_agenda','associar_medico_agenda']:['definir_agenda','associar_medico_agenda'],
                  aguardando:aguardando?'validacao do certificado':'agenda',...(medicos.length?{medicos:[...medicos]}:{}),...(atual.parametros?.agenda?{agenda:atual.parametros.agenda as 'tribemd'|'amplimed'}:planoAtual?.agenda?{agenda:planoAtual.agenda}:{})};
                await memoria.registrarPlano(medicoId,conversa,planoAtual);
              }else if(ferramenta==='associar_medico_agenda'&&dados?.ok===true){
                const observado=dados.identificacao==='observada';
                planoAtual={objetivo:'configurar:medicos',etapa:observado?'concluido':'aguardando_identificacao_consultas',
                  faltando:observado?[]:['identificacao_consultas'],proximosPassos:observado?[]:['verificar_identificacao_consultas'],
                  aguardando:observado?null:'identificacao segura das consultas',...(planoAtual?.medicos?.length?{medicos:planoAtual.medicos}:{}),
                  ...((dados.agenda==='tribemd'||dados.agenda==='amplimed')?{agenda:dados.agenda}:planoAtual?.agenda?{agenda:planoAtual.agenda}:{})};
                await memoria.registrarPlano(medicoId,conversa,planoAtual);
              }
              try { await memoria.registrarEventoTrabalho(medicoId,conversa,chave,ferramenta,'concluida',{...metaEntrada,...(typeof dados?.ok==='boolean'?{ok:dados.ok}:{}),...(dados?.motivo?{motivo:sanitizarTextoMedico(dados.motivo)}:{})}); } catch { /* Enriquecimento opcional. */ }
              return resultado;
            } catch(erro) {
              try { await memoria.registrarEventoTrabalho(medicoId,conversa,chave,ferramenta,'falhou',metaEntrada); } catch { /* Enriquecimento opcional. */ }
              throw erro;
            }
          };
          const decisaoExecutada=decisao;
          const r=await executarFerramenta(decisaoExecutada,':anuncio');
          if(r.jaRespondida) fala=[];
          else {
            const tipo=CATALOGO_FERRAMENTAS.find(f=>f.nome===decisaoExecutada.acao)?.tipo;
            const podeReplanejar=orcamento>2 && tipo==='leitura' && decisaoExecutada.acao!=='descobrir_medicos_agenda' && r.dados!==undefined && chamadas<orcamento && ferramentasExecutadas<2;
            if(podeReplanejar) {
              if(r.falaAssinada) {
                await enviar([...r.falaAssinada],[...(r.falaMemoria??r.falaAssinada)],':observacao:1');
              }
              const objetivoConsulta=interpretacaoSemantica?.objetivo==='consultar';
              const podePrepararAposLeitura=!interpretacaoSemantica||
                (['preparar','emitir'].includes(interpretacaoSemantica.objetivo)&&!interpretacaoSemantica.restricoes.naoEmitir&&!interpretacaoSemantica.restricoes.somenteLeitura);
              const permitidasAposLeitura=deps.ferramentas.permitidas(fatos).filter(a=>{
                if(a===decisaoExecutada.acao) return false;
                if(objetivoConsulta)return a==='nenhuma';
                const ferramenta=CATALOGO_FERRAMENTAS.find(f=>f.nome===a);
                return a==='nenhuma'||(a==='iniciar_lote'&&podePrepararAposLeitura)||ferramenta?.tipo==='leitura';
              });
              const proxima=await decidir(permitidasAposLeitura,r.dados,undefined,true);
              let motivoProxima=validarAcaoConversa(proxima,fatos,permitidasAposLeitura,texto,agora);
              if(!motivoProxima&&afirmaFatoDaAgendaSemFerramenta(texto,proxima,fatos,permitidasAposLeitura)) motivoProxima='FATO_AGENDA_NAO_VERIFICADO';
              decisao=proxima;
              if(motivoProxima) {
                deps.log('erro',`CONVERSA_REPLANEJAMENTO_RECUSADO ${motivoProxima}`);
                fala=r.falaAssinada?[]:await narrar({ok:false,motivo:motivoProxima,executada:false});
              } else if(proxima.acao && proxima.acao!=='nenhuma') {
                const r2=await executarFerramenta(proxima,':anuncio:2');
                if(r2.jaRespondida) fala=[];
                else {
                  fala=await narrar(r2.dados??{ok:true});
                  if(r2.falaAssinada) {
                    const moldura=fala[0]&&fala[0]!==ERRO_CONVERSA&&!/\d|n[aã]o h[aá]|nenhum|zero|sem pend[eê]ncias|n[aã]o encontrei|bloquead|travad|tentativa anterior|s[oó] h[aá] (?:uma?|duas?|tr[eê]s)/i.test(fala[0])?fala[0]:'';
                    fala=[...r2.falaAssinada]; falaMemoria=[...(r2.falaMemoria??r2.falaAssinada)];
                    if(moldura && moldura.length+fala[0].length+1<=500) {fala[0]=moldura+'\n'+fala[0];falaMemoria[0]=moldura+'\n'+falaMemoria[0];}
                  }
                }
              } else {
                fala=r.falaAssinada?[]:proxima.fala;
              }
            } else if(decisaoExecutada.acao==='descobrir_medicos_agenda'&&r.falaAssinada) {
              fala=[...r.falaAssinada]; falaMemoria=[...(r.falaMemoria??r.falaAssinada)];
            } else {
              fala=await narrar(r.dados??{ok:true});
              if(r.falaAssinada) {
                // Contexto de acesso/cortesia pode acompanhar a lista; contagem e status só no texto assinado.
                const moldura=fala[0]&&fala[0]!==ERRO_CONVERSA&&!/\d|n[aã]o h[aá]|nenhum|zero|sem pend[eê]ncias|n[aã]o encontrei|bloquead|travad|tentativa anterior|s[oó] h[aá] (?:uma?|duas?|tr[eê]s)/i.test(fala[0])?fala[0]:'';
                fala=[...r.falaAssinada]; falaMemoria=[...(r.falaMemoria??r.falaAssinada)];
                if(moldura && moldura.length+fala[0].length+1<=500) {fala[0]=moldura+'\n'+fala[0];falaMemoria[0]=moldura+'\n'+falaMemoria[0];}
              }
            }
          }
        }
      }
      if(decisao.reacao) { try {await deps.aoReagir?.(decisao.reacao);} catch {deps.log('erro','CONVERSA_REACAO_FALHOU');} }
      await enviar(fala,falaMemoria);
      try {
        const anterior=await memoria.lerResumo(medicoId,conversa);
        const antigas=await memoria.lerAntigas(medicoId,conversa,anterior?.ateId??'0');
        if(antigas.length>20) {
          const temCompactacao=typeof deps.conversador.compactar==='function';
          const compactacao=temCompactacao ? await deps.conversador.compactar!({resumo:anterior?.resumo??null,mensagens:antigas}) : null;
          const resumo=temCompactacao ? compactacao?.resumo??null : await deps.conversador.resumir({resumo:anterior?.resumo??null,mensagens:antigas.map(m=>m.texto)});
          if(resumo!==null) {
            const inicioId=antigas[0]!.id,fimId=antigas.at(-1)!.id;
            await memoria.registrarResumo(medicoId,conversa,resumo,fimId);
            try {
              await memoria.registrarChunk(medicoId,conversa,0,inicioId,fimId,compactacao?.chunk??resumo);
              if(compactacao) {
                const escopoPorFonte=new Map(antigas.flatMap(m=>{
                  const escopo=escopoMemoriaPorOrigem(m);
                  return escopo?[[m.id,escopo] as const]:[];
                }));
                for(const m of compactacao.memorias) {
                  const escopo=escopoPorFonte.get(m.origemId);
                  if(escopo) await memoria.registrarMemoriaSemantica(medicoId,{escopo,chave:m.chave,categoria:m.categoria,valor:m.valor,origemConversa:conversa,origemMensagemId:m.origemId,confianca:m.confianca});
                }
              }
              // Compactação fractal: no máximo um merge por turno para limitar custo.
              for(let nivel=0;nivel<8;nivel++) {
                const candidatos=await memoria.lerChunksParaConsolidar(medicoId,conversa,nivel,4);
                if(candidatos.length<4) continue;
                const consolidado=await deps.conversador.resumir({resumo:null,mensagens:candidatos.map(c=>c.resumo)});
                if(consolidado) await memoria.registrarChunk(medicoId,conversa,nivel+1,candidatos[0]!.inicioId,candidatos.at(-1)!.fimId,consolidado,candidatos.map(c=>c.id));
                break;
              }
            } catch { deps.log('erro','CONVERSA_MEMORIA_LONGA_FALHOU'); }
          }
        }
      } catch {deps.log('erro','CONVERSA_RESUMO_FALHOU');}
      deps.log('info',`CONVERSA_CHAMADAS ${chamadas}`);
      // Observação (passo 4): só metadados, sem texto do médico, para achar padrões de erro depois. Não altera a resposta.
      deps.log('info','CONVERSA_OBSERVACAO '+JSON.stringify({chamadas,ferramentasExecutadas,acao:decisao.acao??'nenhuma',recusa:motivo??null,loteEstado:fatos.lote?.estado??null,listaRecente:fatos.listaRecente===true,tarefaEmCurso:fatos.tarefaEmCurso===true,semantica:interpretacaoSemantica?{dominio:interpretacaoSemantica.dominio,objetivo:interpretacaoSemantica.objetivo,objeto:interpretacaoSemantica.objeto,granularidade:interpretacaoSemantica.granularidade,confianca:interpretacaoSemantica.confianca,faltando:interpretacaoSemantica.faltando}:null}));
      return {tipo:'nenhuma'};
    } catch (erro) {
      if(!deps.conversaLivreAtiva) {deps.log('erro','COMUNICACAO_ESTADO_FALHOU');return {tipo:'nenhuma'};}
      const identificadores=[entrada.respostaMedico?.texto];
      const nome=erro instanceof Error && /^(?:Error|TypeError|RangeError|SyntaxError|ReferenceError|URIError|AggregateError)$/.test(erro.name)?erro.name:'Error';
      const mensagem=sanitizarErroFiscal(erro instanceof Error?erro.message:erro,identificadores).replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi,'[OCULTO]');
      deps.log('erro','CONVERSA_FALHA_TECNICA '+JSON.stringify({nome,mensagem}));
      if(entrada.respostaMedico && conversa && memoria) {
        try {await memoria.registrarFala(medicoId,conversa,`medico:${chave}`,sanitizarTextoMedico(entrada.respostaMedico.texto),'medico',entrada.origemOperador??'medico');} catch { /* Best effort. */ }
      }
      try {await enviar([ERRO_CONVERSA]);} catch {deps.log('erro','CONVERSA_FALLBACK_FALHOU');}
      return {tipo:'nenhuma'};
    }
  };
  const anterior=processamentos.get(entrada.medicoId);
  const processamento=(anterior?anterior.catch(()=>{}):Promise.resolve()).then(executar);
  processamentos.set(entrada.medicoId,processamento);
  try {return await processamento;} finally {if(processamentos.get(entrada.medicoId)===processamento) processamentos.delete(entrada.medicoId);}
}
