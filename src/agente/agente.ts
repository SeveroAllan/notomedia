import { Agent, OpenAIProvider, Runner, tool, type Model } from '@openai/agents';
import { z } from 'zod';
import { normalizarNomeMedico, linkCertificadoMedico } from '../conta/medicos-conta.js';
import { contemCredencialAgenda } from '../cofre/links.js';
import { semUso, type CodigoFerramenta, type DiagnosticoAgente, type EventoFerramenta, type FerramentaNoto } from './diagnostico.js';
import { INSTRUCOES_NOTO } from './instrucoes.js';
import type { EstadoConversa, AgendaEscolhida } from './estado-conversa.js';

export interface ProfissionalAgente { id: string; nome: string }
export interface EstadoFonte { salvo: boolean; conectada: boolean; indisponivel?: boolean }
export interface StatusFontes { tribemd: EstadoFonte; amplimed: EstadoFonte }

export interface EntradaAgente {
  texto: string;
  profissionais: ProfissionalAgente[];
  semConta?: boolean;
  painelUrl?: string;
  contexto?: readonly string[];
  estadoConversa?: EstadoConversa;
}
export interface DependenciasAgente {
  consultarStatus: (medicoId: string) => Promise<StatusFontes>;
  descobrirProfissionais?: (medicoId: string, agenda: AgendaEscolhida) => Promise<{ ok: boolean; nomes?: string[]; motivo?: string }>;
  confirmarProfissionais?: (medicoBaseId: string, nomes: string[]) => Promise<{ ok: boolean; nomes?: string[]; motivo?: string }>;
  solicitarLinkAgenda?: (medicoId: string, agenda: AgendaEscolhida) => Promise<{ enviado: boolean; motivo?: string }>;
  consultarProntidao?: (medicoId: string) => Promise<{ certificadoValido: boolean; dadosProfissionaisCompletos: boolean; dadosFiscaisConfirmados: boolean; liberadoParaEmitir: boolean }>;
  salvarDadosProfissionais?: (medicoId: string, dados: { nome?: string; crm?: string; rqe?: string }) => Promise<{ ok: boolean; nome?: string; crm?: string | null; rqe?: string | null; motivo?: string }>;
  apiKey?: string;
  modeloNome?: string;
  /** Modelo determinístico para os testes do próprio loop do SDK. */
  modeloTeste?: Model;
  tracesAtivos?: boolean;
  aoDiagnostico?: (registro: DiagnosticoAgente) => void;
  registrarFerramenta?: (evento: EventoFerramenta) => void;
}

function painelSeguro(origem?: string): string {
  if (!origem) return 'pelo painel do Noto';
  try {
    const url = new URL(origem);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      return 'pelo painel do Noto';
    }
    return 'pelo painel do Noto (' + url.origin + ')';
  } catch { return 'pelo painel do Noto'; }
}

function identificar(nome: string | null, profissionais: ProfissionalAgente[]): { encontrados: ProfissionalAgente[]; erro?: string } {
  if (nome === null) return { encontrados: profissionais };
  const chave = normalizarNomeMedico(nome);
  if (!chave) return { encontrados: [], erro: 'Nome não identificado. Pergunte de qual profissional se trata.' };
  const encontrados = profissionais.filter(p => {
    const canonico = normalizarNomeMedico(p.nome);
    return canonico === chave || canonico.split(' ').includes(chave);
  });
  if (!encontrados.length) return { encontrados: [], erro: 'Profissional não localizado na conta autorizada. Não presumir cadastro.' };
  if (encontrados.length > 1) return { encontrados: [], erro: 'Nome ambíguo. Peça o nome completo; não escolha um profissional.' };
  return { encontrados };
}

/** Cria ferramentas somente de leitura para a conta resolvida no webhook.
 * O modelo não recebe identificadores internos nem consegue escolhê-los. */
export function criarAgenteNoto(entrada: EntradaAgente, deps: DependenciasAgente) {
  const profissionais = entrada.profissionais.filter(p => p.id && p.nome.trim()).slice(0, 21);
  const registrar = (nome: FerramentaNoto, codigo: CodigoFerramenta, inicio: number) =>
    deps.registrarFerramenta?.({ nome, codigo, duracaoMs: Math.max(0, Date.now() - inicio) });
  const consultarConta = tool({
    name: 'consultar_contexto_conta',
    description: 'Primeiro passo: verificar se há conta e quais profissionais estão autorizados. Não cria cadastros.',
    parameters: z.object({}),
    async execute() {
      const inicio = Date.now();
      registrar('consultar_contexto_conta', entrada.semConta ? 'CONTA_NAO_ENCONTRADA' : 'CONTA_AUTORIZADA', inicio);
      return {
        contaCadastrada: !entrada.semConta,
        profissionais: entrada.semConta ? [] : profissionais.map(p => p.nome),
        painel: painelSeguro(entrada.painelUrl),
        etapasPossiveis: ['identificar conta', 'identificar profissional', 'escolher agenda', 'conexão em página segura'],
        escolhasJaResolvidas: entrada.estadoConversa ?? {},
        agendasSuportadas: ['TribeMD', 'Amplimed']
      };
    }
  });

  const consultarAgendas = tool({
    name: 'consultar_status_agendas',
    description: 'Verifica o estado REAL das conexões TribeMD e Amplimed do profissional. Não consulta atendimentos nem notas.',
    parameters: z.object({ profissional: z.string().nullable() }),
    async execute({ profissional }) {
      const inicio = Date.now();
      const registrarStatus = (codigo: CodigoFerramenta) => registrar('consultar_status_agendas', codigo, inicio);
      if (entrada.semConta || !profissionais.length) {
        registrarStatus('DEPENDENCIA_CONTA');
        return { ok: false, motivo: 'SEM_CADASTRO_AUTORIZADO' };
      }
      const resolucao = identificar(profissional, profissionais);
      if (resolucao.erro) {
        registrarStatus(resolucao.erro.includes('ambíguo') ? 'PROFISSIONAL_AMBIGUO' : 'PROFISSIONAL_NAO_ENCONTRADO');
        return { ok: false, motivo: resolucao.erro };
      }
      if (resolucao.encontrados.length > 20) {
        registrarStatus('FERRAMENTA_INDISPONIVEL');
        return { ok: false, motivo: 'MUITOS_PROFISSIONAIS' };
      }
      const resultados = await Promise.all(resolucao.encontrados.map(async p => {
        try {
          const s = await deps.consultarStatus(p.id);
          const descrever = (e: EstadoFonte) => e.indisponivel ? 'consulta indisponível' :
            e.conectada ? 'conectada' : e.salvo ? 'acesso salvo, conexão não confirmada' : 'não conectada';
          return {
            profissional: p.nome,
            tribemd: descrever(s.tribemd),
            amplimed: descrever(s.amplimed)
          };
        } catch { return { profissional: p.nome, erro: 'consulta indisponível; não presumir ausência de conexão' }; }
      }));
      const quantosIndisponiveis = resultados.reduce((n, r) => n +
        ('erro' in r ? 2 : Number(r.tribemd === 'consulta indisponível') + Number(r.amplimed === 'consulta indisponível')), 0);
      const codigo = quantosIndisponiveis === resultados.length * 2 ? 'STATUS_INDISPONIVEL' :
        quantosIndisponiveis ? 'STATUS_PARCIAL' :
        resultados.some(r => 'tribemd' in r && (r.tribemd === 'conectada' || r.amplimed === 'conectada')) ?
          'STATUS_CONECTADO' : 'STATUS_NAO_CONECTADO';
      registrarStatus(codigo);
      return { ok: true, codigo, estados: resultados,
        observacao: 'Estado das conexões somente; nenhuma consulta ou nota foi verificada. Se uma fonte estiver indisponível, não peça à pessoa para confirmar o estado técnico; explique a falha e ofereça nova tentativa mais tarde.' };
    }
  });

  const orientarConexao = tool({
    name: 'orientar_conexao_agenda',
    description: 'Após a escolha explícita de TribeMD ou Amplimed, verifica as dependências e orienta o passo seguro. Não envia links nem captura senhas.',
    parameters: z.object({ agenda: z.enum(['tribemd', 'amplimed']), profissional: z.string().nullable() }),
    async execute({ agenda, profissional }) {
      const inicio = Date.now();
      const log = (codigo: CodigoFerramenta) => registrar('orientar_conexao_agenda', codigo, inicio);
      const plataforma = agenda === 'tribemd' ? 'TribeMD' : 'Amplimed';
      const painel = painelSeguro(entrada.painelUrl);
      if (entrada.semConta) {
        log('DEPENDENCIA_CONTA');
        return { pronto: false, proximaEtapa: 'Vincular este WhatsApp a uma conta ' + painel, agendaEscolhida: plataforma };
      }
      if (!profissionais.length) {
        log('DEPENDENCIA_PROFISSIONAL');
        return { pronto: false, proximaEtapa: 'Identificar e cadastrar o profissional ' + painel, agendaEscolhida: plataforma };
      }
      if (profissional === null && entrada.estadoConversa?.profissionalConfirmadoId) {
        profissional = profissionais.find(p => p.id === entrada.estadoConversa?.profissionalConfirmadoId)?.nome ?? null;
      }
      if (profissional === null) {
        log('DEPENDENCIA_PROFISSIONAL');
        return { pronto: false, agendaEscolhida: plataforma, proximaEtapa: 'Perguntar para qual profissional deseja configurar a agenda: ' + profissionais.map(p => p.nome).join(', ') + '. Não presumir que pertence ao único cadastro.' };
      }
      const resolucao = identificar(profissional, profissionais);
      if (resolucao.erro) {
        log(resolucao.erro.includes('ambíguo') ? 'PROFISSIONAL_AMBIGUO' : 'PROFISSIONAL_NAO_ENCONTRADO');
        return { pronto: false, proximaEtapa: resolucao.erro, agendaEscolhida: plataforma };
      }
      if (resolucao.encontrados.length !== 1) {
        log('DEPENDENCIA_PROFISSIONAL');
        return { pronto: false, proximaEtapa: 'Perguntar a qual profissional pertence a agenda: ' + resolucao.encontrados.map(p => p.nome).join(', '), agendaEscolhida: plataforma };
      }
      const p = resolucao.encontrados[0]!;
      // O modelo não pode transformar um nome encontrado na conta em uma escolha
      // do usuário. Exigir menção explícita ou confirmação da última pergunta.
      const palavrasUsuario = normalizarNomeMedico(entrada.texto).split(/[^a-z0-9]+/i);
      const tokensNome = normalizarNomeMedico(p.nome).split(/[^a-z0-9]+/i)
        .filter(t => t.length >= 3 && !['dra', 'dr', 'medico', 'medica'].includes(t));
      const mencionado = tokensNome.some(t => palavrasUsuario.includes(t));
      const ultimaResposta = (entrada.contexto ?? []).at(-1) ?? '';
      const confirmouUltimaPergunta = /^(sim|isso|correto|confirmo|pode ser)[.! ]*$/i.test(entrada.texto.trim()) &&
        ultimaResposta.includes('?') && tokensNome.some(t => normalizarNomeMedico(ultimaResposta).split(/[^a-z0-9]+/i).includes(t));
      const jaConfirmado = entrada.estadoConversa?.profissionalConfirmadoId === p.id;
      if (!mencionado && !confirmouUltimaPergunta && !jaConfirmado) {
        log('DEPENDENCIA_PROFISSIONAL');
        return { pronto: false, agendaEscolhida: plataforma, proximaEtapa:
          'O profissional ainda não foi escolhido explicitamente. Pergunte para qual profissional a agenda será configurada; não presuma pelo cadastro.' };
      }
      try {
        const s = await deps.consultarStatus(p.id);
        const estado = s[agenda];
        if (estado.indisponivel) {
          log('STATUS_INDISPONIVEL');
          return { pronto: false, profissional: p.nome, agendaEscolhida: plataforma, codigo: 'STATUS_INDISPONIVEL',
            proximaEtapa: 'Não foi possível consultar o estado interno do Cofre agora. Não afirmar que a agenda está desconectada nem pedir ao usuário para descobrir o estado técnico. Ofereça tentar verificar novamente mais tarde.' };
        }
        if (estado.conectada) {
          log('CONEXAO_EXISTENTE');
          return { pronto: true, profissional: p.nome, agendaEscolhida: plataforma, orientacao: 'Já conectada. Não reconectar.' };
        }
        log('CONEXAO_PENDENTE');
        return { pronto: false, profissional: p.nome, agendaEscolhida: plataforma,
          proximaEtapa: (estado.salvo ? 'Conferir/reconectar acesso salvo, conexão não confirmada' : 'Conectar agenda') + ' na página segura ' + painel + '. Não pedir senha pelo WhatsApp.' };
      } catch {
        log('STATUS_INDISPONIVEL');
        return { pronto: false, profissional: p.nome, agendaEscolhida: plataforma, codigo: 'STATUS_INDISPONIVEL',
          proximaEtapa: 'A consulta interna falhou. Não presumir conexão ou desconexão nem pedir ao usuário para investigar a falha técnica; ofereça uma nova tentativa mais tarde.' };
      }
    }
  });

  const extras: ReturnType<typeof tool>[] = [];
  if (deps.descobrirProfissionais) extras.push(tool({
    name: 'descobrir_profissionais_agenda',
    description: 'Somente se a conexão da agenda estiver confirmada, lê nomes dos profissionais identificados. Não revela pacientes e não presume correspondência com cadastro.',
    parameters: z.object({ agenda: z.enum(['tribemd','amplimed']), profissional: z.string() }),
    async execute({agenda, profissional}) {
      const inicio=Date.now();
      const r=identificar(profissional, profissionais);
      if (r.erro || r.encontrados.length!==1) {
        registrar('descobrir_profissionais_agenda','PROFISSIONAL_NAO_ENCONTRADO',inicio);
        return {ok:false,motivo:'PROFISSIONAL_NAO_RESOLVIDO'};
      }
      const id=r.encontrados[0]!.id;
      try {
        const status=(await deps.consultarStatus(id))[agenda];
        if (status.indisponivel) {
          registrar('descobrir_profissionais_agenda','STATUS_INDISPONIVEL',inicio);
          return {ok:false,motivo:'CONEXAO_INDISPONIVEL'};
        }
        if (!status.conectada) {
          registrar('descobrir_profissionais_agenda','CONEXAO_PENDENTE',inicio);
          return {ok:false,motivo:status.salvo?'ACESSO_SALVO_SEM_CONEXAO':'AGENDA_NAO_CONECTADA'};
        }
        const resultado=await deps.descobrirProfissionais!(id,agenda);
        registrar('descobrir_profissionais_agenda',resultado.ok?'PROFISSIONAIS_ENCONTRADOS':'STATUS_INDISPONIVEL',inicio);
        return resultado.ok ? {ok:true,nomes:(resultado.nomes??[]).slice(0,20), aviso:'Nomes vistos na fonte, ainda não vinculados à conta.'}
          : {ok:false,motivo:resultado.motivo??'LEITURA_INDISPONIVEL'};
      } catch {
        registrar('descobrir_profissionais_agenda','STATUS_INDISPONIVEL',inicio);
        return {ok:false,motivo:'LEITURA_INDISPONIVEL'};
      }
    }
  }));
  if (deps.confirmarProfissionais && deps.descobrirProfissionais) extras.push(tool({
    name:'confirmar_profissionais_descobertos',
    description:'Somente com nomes verificados na fonte e confirmação explícita da pessoa, vincula profissionais à mesma conta. Não presume que o profissional da agenda já é o cadastrado e não herda dados fiscais ou certificado.',
    parameters:z.object({
      agenda:z.enum(['tribemd','amplimed']),
      profissionalBase:z.string(),
      nomes:z.array(z.string().trim().min(2).max(150)).min(1).max(10)
    }),
    async execute({agenda,profissionalBase,nomes}) {
      const inicio=Date.now();
      const base=identificar(profissionalBase,profissionais);
      if(base.encontrados.length!==1) {
        registrar('confirmar_profissionais_descobertos','PROFISSIONAL_NAO_ENCONTRADO',inicio);
        return {ok:false,motivo:'CONTA_NAO_IDENTIFICADA'};
      }
      const medico=base.encontrados[0]!;
      try {
        const estado=(await deps.consultarStatus(medico.id))[agenda];
        if(estado.indisponivel || !estado.conectada) {
          registrar('confirmar_profissionais_descobertos',estado.indisponivel?'STATUS_INDISPONIVEL':'CONEXAO_PENDENTE',inicio);
          return {ok:false,motivo:estado.indisponivel?'CONSULTA_INDISPONIVEL':'AGENDA_SEM_CONEXAO'};
        }
        const atual=await deps.descobrirProfissionais!(medico.id,agenda);
        if(!atual.ok || !atual.nomes?.length) {
          registrar('confirmar_profissionais_descobertos','STATUS_INDISPONIVEL',inicio);
          return {ok:false,motivo:'IDENTIDADES_NAO_VERIFICADAS'};
        }
        const comprovados=nomes.map(n=>atual.nomes!.filter(c=>normalizarNomeMedico(c)===normalizarNomeMedico(n)));
        if(comprovados.some(c=>c.length!==1)) {
          registrar('confirmar_profissionais_descobertos','PROFISSIONAL_AMBIGUO',inicio);
          return {ok:false,motivo:'NOME_NAO_CONFERIDO_NA_FONTE'};
        }
        const dito=normalizarNomeMedico(entrada.texto);
        const confirmacao=/^(sim|isso|correto|confirmo|exatamente|pode ser)[.! ]*$/i.test(entrada.texto.trim());
        const umaDescobertaConfirmada=confirmacao && nomes.length===1 &&
          entrada.estadoConversa?.perguntaPendente==='confirmar_profissional' &&
          entrada.estadoConversa.descoberta?.agenda===agenda &&
          normalizarNomeMedico(entrada.estadoConversa.nomeProfissionalPerguntado??'')===normalizarNomeMedico(nomes[0]!) &&
          entrada.estadoConversa.descoberta.nomes.some(n=>normalizarNomeMedico(n)===normalizarNomeMedico(nomes[0]!));
        // Menção de um nome ("quem é Bruno?") NÃO é consentimento para
        // cadastrar/vincular. A autorização precisa se referir à ação.
        const intencaoExplicita = /\b(?:confirmo|confirmar|adicione|adicionar|cadastre|cadastrar|vincule|vincular|sao meus medicos|sao os profissionais)\b/.test(dito);
        const confirmouNomes = nomes.every(n=>dito.includes(normalizarNomeMedico(n)));
        if(!umaDescobertaConfirmada && !(intencaoExplicita && confirmouNomes)) {
          registrar('confirmar_profissionais_descobertos','DEPENDENCIA_PROFISSIONAL',inicio);
          return {ok:false,motivo:'CONFIRMACAO_EXPLICITA_NECESSARIA'};
        }
        const resultado=await deps.confirmarProfissionais!(medico.id,comprovados.map(c=>c[0]!));
        registrar('confirmar_profissionais_descobertos',resultado.ok?'PROFISSIONAIS_CONFIRMADOS':'PROFISSIONAL_AMBIGUO',inicio);
        return resultado.ok ? {ok:true,nomes:resultado.nomes??[],fiscalConfirmado:false,certificadosHerdados:false}
          : {ok:false,motivo:resultado.motivo??'FALHA_CONFIRMAR'};
      }catch {
        registrar('confirmar_profissionais_descobertos','FERRAMENTA_INDISPONIVEL',inicio);
        return {ok:false,motivo:'CONFIRMACAO_INDISPONIVEL'};
      }
    }
  }));
  if (deps.solicitarLinkAgenda) extras.push(tool({
    name: 'solicitar_link_seguro_agenda',
    description: 'Após escolha explícita de agenda e profissional autorizado, envia link de uso único ao próprio operador verificado. Não recebe senhas na conversa.',
    parameters: z.object({ agenda:z.enum(['tribemd','amplimed']), profissional:z.string() }),
    async execute({agenda,profissional}) {
      const inicio=Date.now();
      const r=identificar(profissional,profissionais);
      const id=r.encontrados[0]?.id;
      const escolhido=entrada.estadoConversa?.profissionalConfirmadoId===id ||
        normalizarNomeMedico(entrada.texto).includes(normalizarNomeMedico(profissional));
      const agendaEscolhida=entrada.estadoConversa?.agendaEscolhida===agenda ||
        normalizarNomeMedico(entrada.texto).includes(agenda);
      if (!id || r.encontrados.length!==1 || !escolhido || !agendaEscolhida) {
        registrar('solicitar_link_seguro_agenda','DEPENDENCIA_PROFISSIONAL',inicio);
        return {enviado:false,motivo:'ESCOLHA_DE_AGENDA_E_PROFISSIONAL_NECESSARIA'};
      }
      try {
        const estado=(await deps.consultarStatus(id))[agenda];
        if (estado.indisponivel) {
          registrar('solicitar_link_seguro_agenda','STATUS_INDISPONIVEL',inicio);
          return {enviado:false,motivo:'NAO_CONSEGUI_VERIFICAR'};
        }
        if (estado.conectada) {
          registrar('solicitar_link_seguro_agenda','CONEXAO_EXISTENTE',inicio);
          return {enviado:false,motivo:'JA_CONECTADA'};
        }
        const enviado=await deps.solicitarLinkAgenda!(id,agenda);
        registrar('solicitar_link_seguro_agenda',enviado.enviado?'LINK_ENVIADO':'FERRAMENTA_INDISPONIVEL',inicio);
        return enviado.enviado?{enviado:true,observacao:'Link enviado por mensagem separada; não repeti-lo.'}:{enviado:false,motivo:enviado.motivo??'ENVIO_INDISPONIVEL'};
      } catch {
        registrar('solicitar_link_seguro_agenda','FERRAMENTA_INDISPONIVEL',inicio);
        return {enviado:false,motivo:'ENVIO_INDISPONIVEL'};
      }
    }
  }));
  if (deps.consultarProntidao) extras.push(tool({
    name:'consultar_prontidao_onboarding',
    description:'Consulta apenas flags do cadastro, certificado e fiscal sem emitir, modificar ou revelar dados fiscais.',
    parameters:z.object({profissional:z.string()}),
    async execute({profissional}){
      const inicio=Date.now();
      const r=identificar(profissional,profissionais);
      if(r.encontrados.length!==1){
        registrar('consultar_prontidao_onboarding','PROFISSIONAL_NAO_ENCONTRADO',inicio);
        return {ok:false,motivo:'PROFISSIONAL_NAO_RESOLVIDO'};
      }
      try {
        const prontidao=await deps.consultarProntidao!(r.encontrados[0]!.id);
        registrar('consultar_prontidao_onboarding','PRONTIDAO_VERIFICADA',inicio);
        return {ok:true,...prontidao,observacao:'Nenhuma emissão foi realizada e nenhuma preferência fiscal foi alterada.'};
      }catch{
        registrar('consultar_prontidao_onboarding','FERRAMENTA_INDISPONIVEL',inicio);
        return {ok:false,motivo:'PRONTIDAO_INDISPONIVEL'};
      }
    }
  }));

  if (deps.salvarDadosProfissionais) extras.push(tool({
    name:'confirmar_dados_profissionais',
    description:'Registra nome completo, CRM ou RQE informados e explicitamente confirmados pelo operador na própria mensagem. Nunca altera dados fiscais, assinatura, certificado ou autorizações.',
    parameters:z.object({
      profissional:z.string(),
      nomeCompleto:z.string().min(2).max(200).optional(),
      crm:z.string().min(1).max(60).optional(),
      rqe:z.string().min(1).max(60).optional()
    }),
    async execute({profissional,nomeCompleto,crm,rqe}) {
      const inicio=Date.now();
      const resolucao=identificar(profissional,profissionais);
      const medico=resolucao.encontrados[0];
      if(!medico || resolucao.encontrados.length!==1 ||
          entrada.estadoConversa?.profissionalConfirmadoId!==medico.id) {
        registrar('confirmar_dados_profissionais','DEPENDENCIA_PROFISSIONAL',inicio);
        return {ok:false,motivo:'PROFISSIONAL_NAO_CONFIRMADO'};
      }
      const texto=entrada.texto.trim();
      const autorizou=/\b(?:confirmo|atualize|atualizar|registre|registrar|salve|salvar|pode registrar|pode atualizar)\b/i.test(texto);
      const especiais=new Set(['.','*','+','?','^','$','{','}','(',')','|','[',']','\\']);
      const escape=(valor:string) => [...valor].map(ch=>especiais.has(ch)?'\\'+ch:ch).join('');
      const informado=(rotulo:string,valor:string) =>
        new RegExp('\\b'+rotulo+'\\b\\s*(?:(?:n(?:umero|º|o)?)\\s*)?(?::|=|e|eh)?\\s*'+escape(valor)+'(?=$|[\\s,;.!?])','i').test(texto);
      const campos=[
        ...(nomeCompleto?[{rotulo:'(?:nome completo|me chamo)',valor:nomeCompleto}]:[]),
        ...(crm?[{rotulo:'crm',valor:crm}]:[]),
        ...(rqe?[{rotulo:'rqe',valor:rqe}]:[])
      ];
      if(!autorizou || !campos.length || !campos.every(c=>informado(c.rotulo,c.valor))) {
        registrar('confirmar_dados_profissionais','DEPENDENCIA_CONFIRMACAO',inicio);
        return {ok:false,motivo:'VALORES_E_CONFIRMACAO_EXPLICITOS_NECESSARIOS'};
      }
      try{
        const r=await deps.salvarDadosProfissionais!(medico.id,{
          ...(nomeCompleto?{nome:nomeCompleto}:{}),
          ...(crm?{crm}:{}),...(rqe?{rqe}:{})
        });
        registrar('confirmar_dados_profissionais',r.ok?'DADOS_PROFISSIONAIS_SALVOS':'FERRAMENTA_INDISPONIVEL',inicio);
        return r.ok?{ok:true,nome:r.nome,crm:r.crm,rqe:r.rqe,
          dadosFiscaisConfirmados:false,emissaoAutorizada:false}: {ok:false,motivo:r.motivo??'NAO_SALVO'};
      }catch{
        registrar('confirmar_dados_profissionais','FERRAMENTA_INDISPONIVEL',inicio);
        return {ok:false,motivo:'DADOS_PROFISSIONAIS_NAO_VERIFICADOS'};
      }
    }
  }));

  if (deps.consultarProntidao && entrada.painelUrl) extras.push(tool({
    name: 'orientar_certificado_seguro',
    description: 'Com profissional explicitamente identificado, verifica se certificado já existe; se faltar, retorna somente a página autenticada para cadastro do A1. Nunca recebe arquivo ou senha pela conversa.',
    parameters: z.object({ profissional:z.string() }),
    async execute({profissional}) {
      const inicio=Date.now();
      const r=identificar(profissional,profissionais);
      const medico=r.encontrados[0];
      if (!medico || r.encontrados.length!==1 ||
          entrada.estadoConversa?.profissionalConfirmadoId!==medico.id) {
        registrar('orientar_certificado_seguro','DEPENDENCIA_PROFISSIONAL',inicio);
        return {ok:false,motivo:'IDENTIDADE_PROFISSIONAL_NAO_CONFIRMADA'};
      }
      try {
        const status=await deps.consultarProntidao!(medico.id);
        if(status.certificadoValido) {
          registrar('orientar_certificado_seguro','CERTIFICADO_EXISTENTE',inicio);
          return {ok:true,certificadoValido:true,orientacao:'Certificado válido; não pedir novo envio.'};
        }
        const origem=new URL(entrada.painelUrl!);
        if(origem.protocol!=='https:'||origem.username||origem.password||origem.pathname!=='/'||origem.search||origem.hash)
          throw new Error('ORIGEM_NAO_CONFIAVEL');
        const url=linkCertificadoMedico(origem.origin,medico.id);
        registrar('orientar_certificado_seguro','CERTIFICADO_PENDENTE',inicio);
        return {ok:true,certificadoValido:false,orientacao:'Abrir página autenticada, nunca enviar senha ou A1 pela conversa.',url};
      }catch {
        registrar('orientar_certificado_seguro','FERRAMENTA_INDISPONIVEL',inicio);
        return {ok:false,motivo:'PAGINA_SEGURA_INDISPONIVEL'};
      }
    }
  }));

  return new Agent({
    name: 'Noto Assistente',
    model: deps.modeloTeste ?? deps.modeloNome ?? 'gpt-4o-mini',
    instructions: INSTRUCOES_NOTO,
    tools: [consultarConta, consultarAgendas, orientarConexao, ...extras]
  });
}

/**
 * Verifica afirmações concretas de ações/estados, não palavras isoladas.
 * O agent.md guia comunicação/decisão; permissões e capacidades são limites em código.
 * Cada oração é avaliada por conta própria: um "não" em outra oração NÃO
 * autoriza uma afirmação indevida (inclusive após "mas", ponto ou vírgula).
 */
export function respostaCompativelComFerramentas(resposta: string, eventos: readonly EventoFerramenta[]): boolean {
  const normalizada = resposta.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const oracoes = normalizada.split(/[.!?;\n]+|\b(?:mas|porem|contudo|entretanto|todavia|so que)\b/).filter(Boolean);
  const incerta = (prefixo: string) =>
    /\b(?:nao sei se|nao posso (?:confirmar|afirmar) se|nao consegui verificar se|nao tenho como confirmar se|nao tenho evidencia de que)(?:\s+(?:a|o|uma|um|minha|sua))?\s*$/.test(prefixo);
  const negada = (prefixo: string) =>
    /\b(?:nao|nunca|jamais)\s*$/.test(prefixo) || incerta(prefixo);
  const estadosIndisponiveis = eventos.some(e =>
    ['STATUS_INDISPONIVEL', 'STATUS_PARCIAL', 'FERRAMENTA_INDISPONIVEL'].includes(e.codigo));
  const evidenciaConectada = eventos.some(e => e.codigo === 'STATUS_CONECTADO' || e.codigo === 'CONEXAO_EXISTENTE');
  const evidenciaDesconectada = eventos.some(e => e.codigo === 'STATUS_NAO_CONECTADO');

  for (const oracao of oracoes) {
    // O modelo não tem ferramentas de emissão, cancelamento ou envio fiscal.
    // Negações como "não emiti" e "a nota não foi emitida" não afirmam execução.
    const acao = /\b(?:emiti|emitimos|cancelei|cancelamos|enviei|enviamos)\s+(?:(?:a|uma|o|um|as|os)\s+)?(?:notas?|documentos?|comprovantes?)\b/g;
    for (const match of oracao.matchAll(acao)) {
      const antes = oracao.slice(0, match.index).trimEnd();
      if (!negada(antes)) return false;
    }

    // Formas passivas: "o documento foi enviado" vs. "não foi enviado".
    const passivo = /\b(?:notas?|documentos?|comprovantes?)\s+(?:(?:ja|ainda|nao|nunca|jamais)\s+)*(?:foi|foram|esta|estao)\s+(?:(?:nao|nunca|jamais)\s+)?(?:emitid[ao]s?|cancelad[ao]s?|enviad[ao]s?)\b/g;
    for (const match of oracao.matchAll(passivo)) {
      const antes = oracao.slice(0, match.index).trimEnd();
      if (!/\b(?:nao|nunca|jamais)\b/.test(match[0]) && !incerta(antes)) return false;
    }

    // Conexão é um estado verificável; uma negativa continua sendo afirmação
    // sobre o estado ("a agenda não está conectada"), salvo dúvida explícita.
    const estado = /\b(?:agenda|tribemd|amplimed)\b[^.!?;\n]{0,100}?\b(?:desconectad[ao]s?|conectad[ao]s?|ativ[ao]s?)\b/g;
    for (const match of oracao.matchAll(estado)) {
      const antes = oracao.slice(0, match.index).trimEnd();
      if (incerta(antes) || /\b(?:pode|podem|talvez|possivelmente)\b/.test(match[0])) continue;
      if (estadosIndisponiveis) return false;
      const desconectada = /\bdesconectad[ao]s?\b/.test(match[0]) ||
        /\b(?:nao|nunca|jamais)\b[^,;.!?\n]{0,40}\b(?:conectad[ao]s?|ativ[ao]s?)\b/.test(match[0]);
      if (desconectada ? !evidenciaDesconectada || evidenciaConectada : !evidenciaConectada) return false;
    }
  }
  return true;
}

export async function responderAgente(entrada: EntradaAgente, deps: DependenciasAgente): Promise<string> {
  const inicio = Date.now();
  const ferramentas: EventoFerramenta[] = [];
  const registrar = (codigo: DiagnosticoAgente['codigo'], uso = semUso()) =>
    deps.aoDiagnostico?.({ codigo, ferramentas: [...ferramentas], uso, duracaoMs: Math.max(0, Date.now() - inicio) });
  if (contemCredencialAgenda(entrada.texto)) {
    registrar('CREDENCIAL_BLOQUEADA');
    return 'Por segurança, não envie senhas, tokens ou credenciais por aqui. Quando chegar a hora, vou te orientar a usar a página segura do Noto.';
  }
  if (!entrada.texto.trim()) {
    registrar('ENTRADA_VAZIA');
    return 'Olá! Eu sou o Noto. Como posso te ajudar?';
  }
  if (entrada.profissionais.length > 20) {
    registrar('LIMITE_PROFISSIONAIS');
    return 'Há muitos profissionais nesta conta. Qual profissional você deseja atender primeiro?';
  }
  if (!deps.modeloTeste && !deps.apiKey) {
    registrar('SEM_MODELO');
    return 'Sou o Noto! Posso te orientar a conectar uma agenda e organizar o trabalho fiscal. O atendimento inteligente está temporariamente indisponível. Quer verificar sua conexão pelo painel?';
  }
  const abort = new AbortController();
  const relogio = setTimeout(() => abort.abort(), 20_000);
  try {
    const agent = criarAgenteNoto(entrada, { ...deps, registrarFerramenta: e => ferramentas.push(e) });
    const runner = new Runner({
      ...(deps.modeloTeste ? {} : { modelProvider: new OpenAIProvider({ apiKey: deps.apiKey!, useResponses: true }) }),
      tracingDisabled: !deps.tracesAtivos,
      traceIncludeSensitiveData: false,
      workflowName: 'Noto Assistente - Entrega A'
    });
    const resultado = await runner.run(agent, [
      { role: 'user', content: JSON.stringify({
        mensagem: entrada.texto.slice(0, 1500),
        contextoAnterior: (entrada.contexto ?? []).slice(-3).map(s => s.slice(0, 500)),
        estadoConversacionalVerificado: entrada.estadoConversa ?? {}
      }) }
    ], { maxTurns: 6, signal: abort.signal });
    const resposta = typeof resultado.finalOutput === 'string' ? resultado.finalOutput.trim() : '';
    const u = resultado.state.usage;
    const uso = {
      requisicoes: u.requests, tokensEntrada: u.inputTokens, tokensSaida: u.outputTokens, tokensTotal: u.totalTokens
    };
    if (resposta && !respostaCompativelComFerramentas(resposta, ferramentas)) {
      registrar('RESPOSTA_BLOQUEADA', uso);
      return 'Não consegui confirmar isso pelas verificações disponíveis. Posso conferir a conexão da sua agenda novamente?';
    }
    registrar(resposta ? 'RESPOSTA' : 'SEM_RESPOSTA', uso);
    return resposta ? resposta.slice(0, 1200) : 'Não consegui concluir essa verificação. Podemos continuar com a conexão da agenda?';
  } catch {
    registrar('FALLBACK_MODELO');
    return 'Não consegui concluir a consulta agora. Não alterei nenhuma configuração. Posso te orientar a conferir a agenda na área segura do Noto.';
  } finally {
    clearTimeout(relogio);
  }
}
