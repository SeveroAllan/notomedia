import {afirmaFatoDaAgendaSemFerramenta} from './conversador-medico.js';
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

type EntradaLegada = Parameters<typeof orquestrarComunicacao>[0];
export type EstadoComunicacaoMedico = Pick<EntradaLegada,'nomeMedico'|'estado'>;
export interface ResultadoAcaoConversa {
  dados?: unknown; jaRespondida?: boolean; falaAssinada?: string[]; falaMemoria?: string[];
}
export interface ContextoAcaoConversa {
  medicoId: string; conversa: string; chave: string; texto: string; agora: Date; chavePergunta?: string; mensagemEm?: Date;
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
  conversador?:Pick<ConversadorMedico,'responder'|'resumir'>; ferramentas?:FerramentasConversa;
  aoReagir?:(reacao:ReacaoMedico)=>Promise<void>; aoConversar?:(fala:string[],chave:string,falaMemoria?:string[])=>Promise<void>;
  memoriaConversa?:MemoriaConversa; extratorResposta?:ExtratorRespostaMedico; historico:HistoricoComunicacaoRepositorio;
  lerEstado:(medicoId:string,agora:Date)=>Promise<EstadoComunicacaoMedico|null>;
  tratarCofre?:(medicoId:string,texto:string)=>Promise<boolean>;
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
const falaSemMarcaLegada=(t:string)=>t!=='O link seguro já foi solicitado nesta conversa; aguardo a conexão. Isso não confirma envio.';
const processamentos = new Map<string,Promise<ProximaAcaoNoto>>();
export async function processarComunicacaoMedico(
  entrada:Pick<EntradaLegada,'medicoId'|'chaveProcessamento'|'respostaMedico'> & {agora:Date;chaveConversa?:string;chavePergunta?:string;eventoAgenda?:{agenda:'tribemd'|'amplimed';conectado:boolean;falhaAcesso?:boolean}}, deps:Dependencias
):Promise<ProximaAcaoNoto> {
  if(!deps.ativo) return {tipo:'nenhuma'};
  const executar = async ():Promise<ProximaAcaoNoto> => {
    const {medicoId,chaveProcessamento:chave,chaveConversa:conversa,agora}=entrada;
    const memoria=deps.memoriaPersistida;
    const enviar = async (fala:string[], falaMemoria?:string[], sufixo='') => {
      const chaveEnvio=chave+sufixo;
      if(!fala.length) return;
      if(falaMemoria) await deps.aoConversar?.(fala,chaveEnvio,falaMemoria);
      else await deps.aoConversar?.(fala,chaveEnvio);
      if(conversa && memoria) { try {await memoria.registrarFala(medicoId,conversa,`noto:${chaveEnvio}`,(falaMemoria??fala).join('\n'),'noto');} catch {deps.log('erro','CONVERSA_MEMORIA_FALHOU');} }
    };
    try {
      if(!deps.conversaLivreAtiva || !entrada.respostaMedico && !entrada.eventoAgenda) {
        if(entrada.respostaMedico && await deps.tratarCofre?.(medicoId,entrada.respostaMedico.texto)) return {tipo:'nenhuma'};
        if(entrada.respostaMedico && /\b(senha|password|token|secret|segredo|api[_ -]?key)\b/i.test(entrada.respostaMedico.texto)) return {tipo:'nenhuma'};
        const estado=await deps.lerEstado(medicoId,agora);
        if(!estado) return {tipo:'nenhuma'};
        const respostaMedico=entrada.respostaMedico?{...entrada.respostaMedico,texto:sanitizarTextoMedico(entrada.respostaMedico.texto),
          ultimaFalaNoto:undefined,mensagensSeguras:conversa&&deps.memoriaConversa?await deps.memoriaConversa.ler(medicoId,conversa):entrada.respostaMedico.mensagensSeguras}:undefined;
        const acao=await orquestrarComunicacao({...entrada,...estado,respostaMedico},{historico:deps.historico,log:deps.log,extratorResposta:deps.extratorResposta});
        await deps.aoDecidir?.(acao,chave,{nomeMedico:estado.nomeMedico});
        if(conversa && deps.memoriaConversa) {
          if(entrada.respostaMedico) await deps.memoriaConversa.registrar(medicoId,conversa,`medico:${chave}`,sanitizarTextoMedico(entrada.respostaMedico.texto));
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
      if(estado.nomeMedico && !await memoria.temBoasVindas(medicoId,conversa)) {
        const historico=await deps.historico.ler(medicoId,'simulado');
        if(!historico.boasVindasComunicadas) {
          const acao=await orquestrarComunicacao({...entrada,...estado,respostaMedico:undefined},{historico:deps.historico,log:deps.log});
          await deps.aoDecidir?.(acao,chave,{nomeMedico:estado.nomeMedico});
          if(entrada.respostaMedico) await memoria.registrarFala(medicoId,conversa,`medico:${chave}`,texto);
          if(acao.tipo==='boas_vindas') return acao;
        }
      }
      const contexto=await memoria.lerContextoParaModelo(medicoId,conversa);
      const fatos=await deps.ferramentas.lerFatos(medicoId,agora);
      if(fatos.ambiente!=='homologacao') return {tipo:'nenhuma'};
      fatos.semAgendaDigital=contexto.marcas.semAgendaDigital && !fatos.agenda.conectada;
      if(entrada.eventoAgenda) fatos.eventoAgenda=entrada.eventoAgenda;
      fatos.falasRecentesNoto=(await memoria.lerUltimasFalasNoto(medicoId,conversa)).filter(falaSemMarcaLegada);
      fatos.listaRecente=(fatos.falasRecentesNoto as string[]).slice(-6).some(t=>/^\d+ consultas? sem nota desde \d{2}\/\d{2}\/\d{4}/i.test(t));
      fatos.tarefaEmCurso=['confirmado','processando'].includes(fatos.lote?.estado??'');
      fatos.propostaPendente=fatos.lote?.estado==='aguardando_confirmacao_lote'?{tipo:'lote',pergunta:fatos.lote.pergunta??null}:null;
      fatos.homologacaoInformada=[...contexto.historicoRecente,contexto.resumo?.resumo??'',...(fatos.falasRecentesNoto as string[])]
        .some(t=>/homologa[cç][aã]o|[eé] teste/i.test(t));
      fatos.avisarHomologacao=!!entrada.eventoAgenda?.conectado&&!fatos.homologacaoInformada;
      const mensagens=contexto.historicoRecente.filter(falaSemMarcaLegada);
      let chamadas=0; const orcamento=deps.orcamentoChamadas??2;
      const decidir = async (acoesPermitidas:readonly string[], resultadoFerramenta?:unknown,correcao?:{motivo:string;faltou:string[]}) => {
        if(++chamadas>orcamento) throw Error('ORCAMENTO_CONVERSA_EXCEDIDO');
        return deps.conversador!.responder({texto,mensagens,resumo:contexto.resumo?.resumo??null,fatos,agora,acoesPermitidas,resultadoFerramenta,correcao});
      };
      const narrar=async (resultado:unknown) => chamadas>=orcamento ? [ERRO_CONVERSA] : (await decidir([],resultado)).fala;
      const permitidas=deps.ferramentas.permitidas(fatos);
      let decisao=await decidir(permitidas);
      if(entrada.respostaMedico) await memoria.registrarFala(medicoId,conversa,`medico:${chave}`,texto);
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
      if(chamadas<orcamento && afirmaFatoDaAgendaSemFerramenta(texto,decisao,fatos,permitidas)) {
        deps.log('info','CONVERSA_FATO_SEM_FERRAMENTA');
        decisao=await decidir(permitidas,undefined,{motivo:'a resposta afirma fatos da agenda sem consultar: para conferir use listar_pendencias; para preparar total/proposta use iniciar_lote (exige confirmação antes de emitir). Anuncie a ação ou não afirme quantidade, ausência nem bloqueio',faltou:[]});
        if(afirmaFatoDaAgendaSemFerramenta(texto,decisao,fatos,permitidas)) {
          deps.log('erro','CONVERSA_FATO_SEM_FERRAMENTA_PERSISTE');
          await enviar(['Não vou chutar: preciso consultar a agenda para te responder isso. Pode repetir o pedido?']);
          return {tipo:'nenhuma'};
        }
      }
      let motivo=validarAcaoConversa(decisao,fatos,permitidas,texto,agora);
      if(chamadas<orcamento && motivo==='anuncie a acao com suas palavras') {
        deps.log('info','CONVERSA_ANUNCIO_CORRIGIR');
        decisao=await decidir(permitidas,undefined,{motivo,faltou:[]});
        motivo=validarAcaoConversa(decisao,fatos,permitidas,texto,agora);
      }
      if(chamadas<orcamento && motivo==='LISTA_EM_VEZ_DE_LOTE' && permitidas.includes('iniciar_lote')) {
        // Lote anterior terminou com erro: listar de novo não destrava; a releitura ao vivo vem do iniciar_lote (o médico confirma antes).
        deps.log('info','CONVERSA_LISTA_EM_VEZ_DE_LOTE');
        decisao=await decidir(permitidas.filter(a=>a!=='listar_pendencias'),undefined,{motivo:'o último lote terminou com erro; se o médico quer emitir de novo, use iniciar_lote anunciando; se só conversa, acao null',faltou:[]});
        motivo=validarAcaoConversa(decisao,fatos,permitidas,texto,agora);
      }
      if(chamadas<orcamento && (motivo==='ENVIO_SEM_ACAO'||motivo==='PEDIDO_REENVIO_AUSENTE')) {
        decisao=await decidir(permitidas,undefined,{motivo:'Não existe envio em andamento. Pedido claro de PDF: use reenviar_nota_medico com dia e evidencia literal; se faltar data, pergunte. Não prometa tarefa sem ação.',faltou:[]});
        motivo=validarAcaoConversa(decisao,fatos,permitidas,texto,agora);
      }
      if(chamadas<orcamento && motivo==='PERIODO_NECESSARIO') {
        deps.log('info','CONVERSA_PERIODO_CORRIGIR');
        decisao=await decidir(permitidas,undefined,{motivo:'a acao precisa de parametros.desde ISO (use calendario com o periodo que o medico disse)',faltou:['parametros.desde']});
        motivo=validarAcaoConversa(decisao,fatos,permitidas,texto,agora);
      }
      if(chamadas<orcamento && motivo==='CONCLUSAO_SEM_ACAO') {
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
      if(chamadas<orcamento && motivo==='CONEXAO_EM_VERIFICACAO') {
        deps.log('info','CONVERSA_CONEXAO_EM_VERIFICACAO');
        decisao=await decidir(permitidas.filter(a=>a!=='pedir_link_agenda'&&a!=='pedir_link_permissoes'),undefined,{motivo:'o acesso da agenda está em verificação; confirme em 1 frase que você avisa assim que concluir, sem nova ação nem novo link',faltou:[]});
        motivo=validarAcaoConversa(decisao,fatos,permitidas,texto,agora);
      }
      const corrigirIntroducao=chamadas<orcamento && decisao.acao==='pedir_link_agenda' && ['INTRODUCAO_INCOMPLETA','BALOES_LINK_EXCEDIDOS'].includes(motivo??'');
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
      let fala=decisao.fala, falaMemoria:string[]|undefined;
      if(motivo) {
        deps.log('erro',`CONVERSA_ACAO_RECUSADA ${motivo}`);
        fala=motivo==='PEDIDO_REENVIO_AUSENTE'||motivo==='ENVIO_SEM_ACAO'?['Não fiz nenhum envio. Qual é a data da consulta cujo PDF você quer receber?']:corrigirIntroducao ? [ERRO_CONVERSA] : await narrar({ok:false,motivo,executada:false});
      } else {
        const desde=periodoDecisao(decisao,agora,texto);
        if(desde) { await deps.ferramentas.guardarPeriodo(medicoId,desde); fatos.periodo={desde,origem:'resposta_atual'}; }
        if(decisao.acao==='registrar_modo_sem_agenda') {
          await memoria.registrarMarca(medicoId,conversa,'sem_agenda_digital');
        } else if(decisao.acao && decisao.acao!=='nenhuma' || fatos.lote?.estado==='aguardando_confirmacao_lote' && decisao.parametros?.confirmacao) {
          if(decisao.acao==='listar_pendencias' || decisao.acao==='iniciar_lote') await enviar(decisao.fala.slice(0,1),undefined,':anuncio');
          const r=await deps.ferramentas.executar(decisao,{medicoId,conversa,chave,texto,agora,chavePergunta:entrada.chavePergunta,mensagemEm:entrada.respostaMedico?.enviadaEm ? new Date(entrada.respostaMedico.enviadaEm) : new Date(NaN),fatos,narrar});
          if(r.jaRespondida) fala=[];
          else {
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
      if(decisao.reacao) { try {await deps.aoReagir?.(decisao.reacao);} catch {deps.log('erro','CONVERSA_REACAO_FALHOU');} }
      await enviar(fala,falaMemoria);
      try {
        const anterior=await memoria.lerResumo(medicoId,conversa);
        const antigas=await memoria.lerAntigas(medicoId,conversa,anterior?.ateId??'0');
        if(antigas.length>20) {
          const resumo=await deps.conversador.resumir({resumo:anterior?.resumo??null,mensagens:antigas.map(m=>m.texto)});
          if(resumo!==null) await memoria.registrarResumo(medicoId,conversa,resumo,antigas.at(-1)!.id);
        }
      } catch {deps.log('erro','CONVERSA_RESUMO_FALHOU');}
      deps.log('info',`CONVERSA_CHAMADAS ${chamadas}`);
      // Observação (passo 4): só metadados, sem texto do médico, para achar padrões de erro depois. Não altera a resposta.
      deps.log('info','CONVERSA_OBSERVACAO '+JSON.stringify({chamadas,acao:decisao.acao??'nenhuma',recusa:motivo??null,loteEstado:fatos.lote?.estado??null,listaRecente:fatos.listaRecente===true,tarefaEmCurso:fatos.tarefaEmCurso===true}));
      return {tipo:'nenhuma'};
    } catch (erro) {
      if(!deps.conversaLivreAtiva) {deps.log('erro','COMUNICACAO_ESTADO_FALHOU');return {tipo:'nenhuma'};}
      const identificadores=[entrada.respostaMedico?.texto];
      const nome=erro instanceof Error && /^(?:Error|TypeError|RangeError|SyntaxError|ReferenceError|URIError|AggregateError)$/.test(erro.name)?erro.name:'Error';
      const mensagem=sanitizarErroFiscal(erro instanceof Error?erro.message:erro,identificadores).replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi,'[OCULTO]');
      deps.log('erro','CONVERSA_FALHA_TECNICA '+JSON.stringify({nome,mensagem}));
      if(entrada.respostaMedico && conversa && memoria) {
        try {await memoria.registrarFala(medicoId,conversa,`medico:${chave}`,sanitizarTextoMedico(entrada.respostaMedico.texto));} catch { /* Best effort. */ }
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
