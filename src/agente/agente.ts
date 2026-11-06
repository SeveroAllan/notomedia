import { Agent, OpenAIProvider, Runner, tool, type Model } from '@openai/agents';
import OpenAI from 'openai';
import type pg from 'pg';
import {ProvedorAgenteComOrcamento} from './modelo-com-limite.js';
import {PausaCustoPiloto,FALA_LIMITE_TESTE} from './limite-gasto-rodada.js';
import { z } from 'zod';
import { normalizarNomeMedico, linkCertificadoMedico } from '../conta/medicos-conta.js';
import { contemCredencialAgenda } from '../cofre/links.js';
import { nomeProfissionalValido } from '../conta/validar-dados-emissao.js';
import { semUso, type CodigoFerramenta, type DiagnosticoAgente, type EventoFerramenta, type FerramentaNoto } from './diagnostico.js';
import { INSTRUCOES_NOTO } from './instrucoes.js';
import type { EstadoConversa, AgendaEscolhida } from './estado-conversa.js';
import type { ComprovanteTarefa } from './tarefas.js';
import { descreverPanoramaFiscal, type ResultadoPanoramaFiscal } from './panorama-operacional.js';
import { descreverConferencia, type ResultadoConferencia } from './conferencia-atendimentos.js';
import { contaDoCofreId } from '../cofre/identidade-conta.js';
import { decidirVinculo, explicarVinculoNaoExecutado } from './confirmacao-contextual.js';
import type { ResultadoEnfileirar, TipoTrabalhoNoto, SituacaoTrabalhoNoto } from './trabalhos-duraveis.js';

export interface ProfissionalAgente { id: string; nome: string }
export interface EstadoFonte { salvo: boolean; conectada: boolean; indisponivel?: boolean;
  motivo?: 'INTEGRACAO_NAO_CONFIGURADA' | 'FALHA_CONSULTA_INTEGRACAO' }
export interface StatusFontes { tribemd: EstadoFonte; amplimed: EstadoFonte }

export interface EntradaAgente {
  texto: string;
  profissionais: ProfissionalAgente[];
  semConta?: boolean;
  painelUrl?: string;
  contexto?: readonly string[];
  estadoConversa?: EstadoConversa;
  /** Estado consultado em banco, sem token/URL/ID; aceite nao e entrega. */
  situacaoUltimoLink?: {agenda:AgendaEscolhida;estado:string};
  trabalhos?: SituacaoTrabalhoNoto[];
}
export interface DependenciasAgente {
  consultarStatus: (medicoId: string) => Promise<StatusFontes>;
  consultarPanorama?: (medicoIds: string[]) => Promise<ResultadoPanoramaFiscal>;
  consultarConferencia?: (medicoId: string, agenda: AgendaEscolhida) => Promise<ResultadoConferencia>;
  solicitarTrabalho?: (tipo: TipoTrabalhoNoto, agenda: AgendaEscolhida, medicoId: string | null) => Promise<ResultadoEnfileirar>;
  aoTrabalho?: (trabalho: { tipo:TipoTrabalhoNoto; agenda:AgendaEscolhida; estado:ResultadoEnfileirar }) => void;
  aoConsultaEntregaLink?: (agenda:AgendaEscolhida, estado:{estado:string;comId:boolean}|null) => void;
  aoConferencia?: (resultado: ResultadoConferencia) => void;
  aoPanorama?: (foco: string | null, resultado: ResultadoPanoramaFiscal) => void;
  /** Referência técnica existente do Cofre da conta autenticada, NÃO representa um médico escolhido. */
  referenciaContaAgenda?: () => Promise<string | null>;
  descobrirProfissionais?: (medicoId: string, agenda: AgendaEscolhida) => Promise<{ ok: boolean; nomes?: string[]; motivo?: string }>;
  confirmarProfissionais?: (medicoBaseId: string, nomes: string[]) => Promise<{
    ok:boolean; nomes?:string[]; motivo?:string; medicos?: {id:string;nome:string}[]
  }>;
  aoVinculoResultado?: (resultado: {ok:true;nome:string;registrado:boolean;pesquisa:'agendada'|'ja_existe'|'indisponivel'}|{ok:false;motivo:string}) => void;
  aoVinculo?: (agenda:AgendaEscolhida,medico:{id:string;nome:string}) => Promise<{
    registrado:boolean; pesquisa:'agendada'|'ja_existe'|'indisponivel'
  }>;
  proporCorrecaoPesquisa?: (medicoId:string,dados:{crm:string;rqe?:string}) => Promise<boolean>;
  concluirRevisaoPesquisa?: (medicoId:string) => Promise<boolean>;
  solicitarLinkRegistro?: (medicoId:string,acao?:'solicitar'|'consultar'|'substituir') => Promise<{ok:boolean;motivo?:string;anteriorInvalidado?:boolean}>;
  aprovarRegistroProfissional?: (medicoId:string)=>Promise<{ok:true;nome:string;crm:string;rqe:string|null}|{ok:false;motivo:string}>;
  aoLinkRegistro?: (r:{ok:boolean;nome:string;motivo?:string;anteriorInvalidado?:boolean})=>void;
  aoRevisaoRegistro?: (resultado:{ok:true;tipo:'aprovacao';nome:string;crm:string;rqe:string|null}|{ok:true;tipo:'correcao';nome:string;motivo?:string}|{ok:false;motivo:string}) => void;
  solicitarLinkAgenda?: (medicoId: string, agenda: AgendaEscolhida) => Promise<{ aceitoParaEnvio: boolean; motivo?: string }>;
  consultarEntregaLink?: (referencia: string, agenda: AgendaEscolhida) => Promise<{
    estado:string; comId:boolean; segundosDesdeAceite:number
  }|null>;
  consultarProntidao?: (medicoId: string) => Promise<{ certificadoValido: boolean; dadosProfissionaisCompletos: boolean; dadosFiscaisConfirmados: boolean; liberadoParaEmitir: boolean }>;
  salvarDadosProfissionais?: (medicoId: string, dados: { nome?: string; crm?: string; rqe?: string }) => Promise<{ ok: boolean; nome?: string; crm?: string | null; rqe?: string | null; motivo?: string }>;
  apiKey?: string;
  modeloNome?: string;
  /** Modelo determinístico para os testes do próprio loop do SDK. */
  modeloTeste?: Model;
  /** Obrigatório nos testes pagos do piloto; se o banco falhar, não chamar IA. */
  controleCusto?:pg.Pool;
  /** Garante que processo de piloto read-only não contorne o ledger. */
  exigirControleCusto?:boolean;
  tracesAtivos?: boolean;
  aoDiagnostico?: (registro: DiagnosticoAgente) => void;
  registrarFerramenta?: (evento: EventoFerramenta) => void;
  /** Evidência de ferramenta real, privada ao turno; nunca exposta no diagnóstico. */
  aoComprovante?: (comprovante: ComprovanteTarefa) => void;
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

/** Roteamento somente pela descoberta autenticada persistida.
 * Não tenta inferir "sim" com regex: a ferramenta interpreta a fala.
 */
function exigeDecisaoVinculo(entrada:EntradaAgente,deps:DependenciasAgente):boolean{
  const fonte=entrada.estadoConversa?.descoberta;
  return Boolean(!entrada.semConta&&deps.confirmarProfissionais&&
    entrada.estadoConversa?.faseAgenda==='CONFIRMACAO_PENDENTE'&&fonte&&
    ['tribemd','amplimed'].includes(fonte.agenda)&&
    Array.isArray(fonte.nomes)&&fonte.nomes.length>0);
}

/** Cria ferramentas somente de leitura para a conta resolvida no webhook.
 * O modelo não recebe identificadores internos nem consegue escolhê-los. */
export function criarAgenteNoto(entrada: EntradaAgente, deps: DependenciasAgente) {
  const profissionais = entrada.profissionais.filter(p => p.id && nomeProfissionalValido(p.nome)).slice(0, 21);
  // Descoberta já comprovada e pendente é a única condição que ativa
  // a ferramenta obrigatória. O modelo decide a INTENÇÃO (inclusive negar
  // ou esclarecer); o código nunca converte um "sim" em autorização por regex.
  // Sem essa evidência, nenhum toolChoice de escrita é imposto.
  const confirmacaoPendente=exigeDecisaoVinculo(entrada,deps);
  // Nunca expor o ID técnico ao modelo, nem usá-lo como nome de profissional.
  const ancoraDaConta = async () => entrada.semConta ? null : await deps.referenciaContaAgenda?.() ?? null;
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
        etapasPossiveis: ['identificar conta', 'escolher agenda', 'conexão em página segura', 'descobrir profissionais na agenda', 'confirmar nomes descobertos'],
        escolhasJaResolvidas: entrada.estadoConversa ?? {},
        situacaoUltimoLink: entrada.situacaoUltimoLink??null,
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
      if (entrada.semConta) {
        registrarStatus('DEPENDENCIA_CONTA');
        return { ok: false, motivo: 'SEM_CADASTRO_AUTORIZADO' };
      }
      // Sem nome profissional confirmado, consultar o acesso da CONTA.
      // Em contas já configuradas, mantém consulta por profissional explícito.
      const referencia = profissional === null && !profissionais.length
        ? await ancoraDaConta().catch(()=>null) : null;
      if (profissional === null && !profissionais.length && !referencia) {
        registrarStatus('DEPENDENCIA_CONTA');
        return {ok:false,motivo:'REFERENCIA_CONTA_NAO_ENCONTRADA'};
      }
      const resolucao = referencia ? {encontrados:[{id:referencia,nome:'conta'}]} : identificar(profissional,profissionais);
      if ('erro' in resolucao && resolucao.erro) {
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
          // Verificar "a agenda" em geral exige resultado de ambas as fontes.
          if (!s.tribemd.indisponivel && !s.amplimed.indisponivel) {
            deps.aoComprovante?.({ tipo: 'verificar_agenda', profissionalId: p.id });
          }
          if (!s.tribemd.indisponivel) {
            deps.aoComprovante?.({ tipo: 'verificar_agenda', profissionalId: p.id, agenda: 'tribemd' });
            if (s.tribemd.conectada) deps.aoComprovante?.({ tipo: 'conectar_agenda', profissionalId: p.id, agenda: 'tribemd' });
          }
          if (!s.amplimed.indisponivel) {
            deps.aoComprovante?.({ tipo: 'verificar_agenda', profissionalId: p.id, agenda: 'amplimed' });
            if (s.amplimed.conectada) deps.aoComprovante?.({ tipo: 'conectar_agenda', profissionalId: p.id, agenda: 'amplimed' });
          }
          const descrever = (e: EstadoFonte) =>
            e.motivo === 'INTEGRACAO_NAO_CONFIGURADA' ? 'integração não configurada neste ambiente' :
            e.indisponivel ? 'consulta indisponível' :
            e.conectada ? 'conectada' : e.salvo ? 'acesso salvo, conexão não confirmada' : 'não conectada';
          return {
            profissional: p.nome,
            tribemd: descrever(s.tribemd),
            amplimed: descrever(s.amplimed)
          };
        } catch { return { profissional: p.nome, erro: 'consulta indisponível; não presumir ausência de conexão' }; }
      }));
      const quantosIndisponiveis = resultados.reduce((n, r) => n +
        ('erro' in r ? 2 : Number(['consulta indisponível', 'integração não configurada neste ambiente'].includes(r.tribemd)) + Number(['consulta indisponível', 'integração não configurada neste ambiente'].includes(r.amplimed))), 0);
      const codigo = quantosIndisponiveis === resultados.length * 2 ? 'STATUS_INDISPONIVEL' :
        quantosIndisponiveis ? 'STATUS_PARCIAL' :
        resultados.some(r => 'tribemd' in r && (r.tribemd === 'conectada' || r.amplimed === 'conectada')) ?
          'STATUS_CONECTADO' : 'STATUS_NAO_CONECTADO';
      const faltaConfig = resultados.some(r => 'tribemd' in r &&
        (r.tribemd === 'integração não configurada neste ambiente' ||
          r.amplimed === 'integração não configurada neste ambiente'));
      registrarStatus(faltaConfig ? 'INTEGRACAO_NAO_CONFIGURADA' : codigo);
      return { ok: true, codigo: faltaConfig ? 'INTEGRACAO_NAO_CONFIGURADA' : codigo, estados: resultados,
        observacao: faltaConfig
          ? 'A integração não está configurada neste ambiente. Não é falha da TribeMD ou Amplimed e repetir a consulta não resolve. É necessária configuração local antes do link seguro. Senhas só na página segura.'
          : 'Estado das conexões somente; nenhuma consulta ou nota foi verificada. Falha de consulta não comprova desconexão.' };
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
      if (profissional === null && entrada.estadoConversa?.profissionalConfirmadoId) {
        profissional = profissionais.find(p => p.id === entrada.estadoConversa?.profissionalConfirmadoId)?.nome ?? null;
      }
      // Primeira conexão é da CONTA. O esquema de links exige um medico_id
      // como referência técnica de armazenamento, não identidade profissional.
      if (profissional === null) {
        const referencia = await ancoraDaConta().catch(() => null);
        if (!referencia) {
          log('DEPENDENCIA_CONTA');
          return { pronto: false, agendaEscolhida: plataforma,
            proximaEtapa: 'A conta não tem referência técnica para o Cofre. Não criar nem escolher automaticamente um médico.' };
        }
        try {
          const estado = (await deps.consultarStatus(referencia))[agenda];
          if (estado.motivo === 'INTEGRACAO_NAO_CONFIGURADA') {
            log('INTEGRACAO_NAO_CONFIGURADA');
            return { pronto: false, agendaEscolhida: plataforma, codigo: 'INTEGRACAO_NAO_CONFIGURADA',
              proximaEtapa: 'A integração ainda não está configurada neste ambiente do Noto. Não é falha da plataforma e repetir não resolverá.' };
          }
          if (estado.indisponivel) {
            log('STATUS_INDISPONIVEL');
            return { pronto: false, agendaEscolhida: plataforma, codigo: 'STATUS_INDISPONIVEL',
              proximaEtapa: 'Não consegui conferir a conexão agora; não presumir desconexão.' };
          }
          if (estado.conectada) {
            log('CONEXAO_EXISTENTE');
            return { pronto: true, agendaEscolhida: plataforma,
              orientacao: 'A agenda da conta já está conectada. Chame descobrir_profissionais_agenda com profissional=null para consultar nomes reais. Só depois peça confirmação.' };
          }
          log('CONEXAO_PENDENTE');
          return { pronto: false, agendaEscolhida: plataforma,
            proximaEtapa: 'Pode solicitar o link seguro para esta conta sem escolher médico. Chame solicitar_link_seguro_agenda com profissional=null; depois do login pelo navegador, descubra nomes reais e peça confirmação. Senha somente na página segura ' + painel + '.' };
        } catch {
          log('STATUS_INDISPONIVEL');
          return { pronto: false, agendaEscolhida: plataforma, codigo: 'STATUS_INDISPONIVEL',
            proximaEtapa: 'Não consegui verificar a conexão agora. Nenhum médico foi selecionado.' };
        }
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
          if (estado.motivo === 'INTEGRACAO_NAO_CONFIGURADA') {
            log('INTEGRACAO_NAO_CONFIGURADA');
            return { pronto: false, profissional: p.nome, agendaEscolhida: plataforma,
              codigo: 'INTEGRACAO_NAO_CONFIGURADA',
              proximaEtapa: 'Esta integração ainda não está configurada na homologação do Noto. Não é falha da plataforma. Não ofereça tentar mais tarde: a configuração local precisa ser concluída antes. Senhas somente na página segura.' };
          }
          log('STATUS_INDISPONIVEL');
          return { pronto: false, profissional: p.nome, agendaEscolhida: plataforma, codigo: 'STATUS_INDISPONIVEL',
            proximaEtapa: 'Não foi possível consultar o estado interno do Cofre agora. Não afirmar que a agenda está desconectada nem pedir ao usuário para descobrir o estado técnico. Ofereça tentar verificar novamente mais tarde.' };
        }
        if (estado.conectada) {
          log('CONEXAO_EXISTENTE');
          deps.aoComprovante?.({ tipo: 'conectar_agenda', profissionalId: p.id, agenda });
          deps.aoComprovante?.({ tipo: 'verificar_agenda', profissionalId: p.id, agenda });
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
  if (deps.consultarPanorama) extras.push(tool({
    name: 'consultar_panorama_operacional',
    description: 'Consulta registros fiscais reais dos últimos 30 dias dos médicos da conta. profissional=null consulta todos os médicos confirmados. Não infere atendimento sem nota, nem emite.',
    parameters: z.object({ profissional: z.string().nullable() }),
    async execute({ profissional }) {
      const inicio = Date.now();
      const r = identificar(profissional, profissionais);
      if (r.erro || !r.encontrados.length) {
        deps.aoPanorama?.(null, { ok: false, motivo: !profissionais.length ? 'SEM_PROFISSIONAIS_CONFIRMADOS' : 'ESCOPO_NAO_CONFERIDO' });
        registrar('consultar_panorama_operacional',
          r.erro?.includes('ambíguo') ? 'PROFISSIONAL_AMBIGUO' : 'DEPENDENCIA_PROFISSIONAL', inicio);
        return { ok: false, motivo: r.erro ?? 'SEM_PROFISSIONAIS_CONFIRMADOS' };
      }
      try {
        const resultado = await deps.consultarPanorama!(r.encontrados.map(p => p.id));
        if (!resultado.ok) {
          deps.aoPanorama?.(profissional, resultado);
          registrar('consultar_panorama_operacional', 'PANORAMA_FISCAL_INDISPONIVEL', inicio);
          return resultado;
        }
        deps.aoPanorama?.(profissional === null ? null : r.encontrados[0]!.nome, resultado);
        registrar('consultar_panorama_operacional', 'PANORAMA_FISCAL_CONSULTADO', inicio);
        return resultado;
      } catch {
        deps.aoPanorama?.(profissional, { ok: false, motivo: 'DADOS_FISCAIS_INDISPONIVEIS' });
        registrar('consultar_panorama_operacional', 'PANORAMA_FISCAL_INDISPONIVEL', inicio);
        return { ok: false, motivo: 'DADOS_FISCAIS_INDISPONIVEIS' };
      }
    }
  }));
  // Um único trabalho de comparação por turno. O modelo não pode forçar
  // leituras repetidas do portal nem migrar de médico durante a execução.
  let conferenciaEscolhida: string | null = null;
  let conferenciaEmVoo: Promise<ResultadoConferencia> | null = null;
  if (deps.consultarConferencia) extras.push(tool({
    name: 'conferir_atendimentos_e_notas',
    description: 'Confere a agenda real de UM médico autorizado com vínculos fiscais exatos dos últimos 30 dias; não declara consultas sem nota, não emite e não cadastra nada. Escolha a agenda somente se explícita, já confirmada ou única conectada.',
    parameters: z.object({ profissional: z.string(), agenda: z.enum(['tribemd','amplimed']) }),
    async execute({ profissional, agenda }) {
      const inicio = Date.now();
      const entregar = (resultado: ResultadoConferencia) => {
        deps.aoConferencia?.(resultado);
        registrar('conferir_atendimentos_e_notas', resultado.ok ? 'CONFERENCIA_REALIZADA' : 'CONFERENCIA_PENDENTE', inicio);
        return resultado;
      };
      const r = identificar(profissional, profissionais);
      if (r.erro || r.encontrados.length !== 1) return entregar({ok:false,motivo:'ESCOPO_NAO_CONFERIDO'});
      const medico = r.encontrados[0]!;
      const texto = normalizarNomeMedico(entrada.texto);
      const nomesCitados = profissionais.filter(p => {
        const normalizado=normalizarNomeMedico(p.nome);
        return normalizado && (texto.includes(normalizado) ||
          normalizado.split(' ').some(token => token.length >= 4 && texto.split(' ').includes(token)));
      });
      // Uma mensagem que cita outro médico (ou vários) não herda o foco antigo.
      if (nomesCitados.length > 1 || (nomesCitados.length === 1 && nomesCitados[0]!.id !== medico.id)) {
        return entregar({ok:false,motivo:'ESCOPO_NAO_CONFERIDO'});
      }
      const focoValido = entrada.estadoConversa?.profissionalConfirmadoId === medico.id ||
        (nomesCitados.length === 1 && nomesCitados[0]!.id === medico.id) ||
        profissionais.length === 1;
      if (!focoValido) return entregar({ok:false,motivo:'ESCOPO_NAO_CONFERIDO'});
      try {
        const status=await deps.consultarStatus(medico.id);
        const conectadas=(['tribemd','amplimed'] as const).filter(fonte =>
          status[fonte].conectada && !status[fonte].indisponivel);
        const citouTribe=/\btribe(?:md)?\b/i.test(entrada.texto);
        const citouAmplimed=/\bamplimed\b/i.test(entrada.texto);
        if ((citouTribe && citouAmplimed) ||
            (citouTribe && agenda!=='tribemd') ||
            (citouAmplimed && agenda!=='amplimed')) {
          return entregar({ok:false,motivo:'AGENDA_AMBIGUA'});
        }
        const explicitou=agenda==='tribemd' ? citouTribe : citouAmplimed;
        const agendaJustificada=explicitou || entrada.estadoConversa?.agendaEscolhida===agenda ||
          (conectadas.length===1 && conectadas[0]===agenda && !status[agenda==='tribemd'?'amplimed':'tribemd'].indisponivel);
        if (!agendaJustificada || !conectadas.includes(agenda)) {
          return entregar({ok:false,motivo:!agendaJustificada?'AGENDA_AMBIGUA':'INTEGRACAO_INDISPONIVEL'});
        }
        const chave=medico.id+':'+agenda;
        if (conferenciaEscolhida && conferenciaEscolhida !== chave) {
          return entregar({ok:false,motivo:'ESCOPO_NAO_CONFERIDO'});
        }
        conferenciaEscolhida=chave;
        if(deps.solicitarTrabalho) {
          const pedido=await deps.solicitarTrabalho('conferencia_fiscal',agenda,medico.id);
          deps.aoTrabalho?.({tipo:'conferencia_fiscal',agenda,estado:pedido});
          registrar('conferir_atendimentos_e_notas',pedido.ok?'TRABALHO_REGISTRADO':'TRABALHO_INDISPONIVEL',inicio);
          return pedido.ok?{ok:true,estado:pedido.estado,observacao:'A consulta está em andamento fora deste turno; nenhuma nota foi confirmada nesta execução.'}:
            {ok:false,motivo:pedido.motivo};
        }
        conferenciaEmVoo??=deps.consultarConferencia!(medico.id,agenda);
        return entregar(await conferenciaEmVoo);
      } catch {
        return entregar({ok:false,motivo:'INTEGRACAO_INDISPONIVEL'});
      }
    }
  }));
  if (deps.descobrirProfissionais) extras.push(tool({
    name: 'descobrir_profissionais_agenda',
    description: 'Após conexão comprovada, consulta nomes REAIS na agenda. profissional=null usa somente referência técnica da conta (sem escolher médico). Nunca revela pacientes.',
    parameters: z.object({ agenda: z.enum(['tribemd','amplimed']), profissional: z.string().nullable() }),
    async execute({agenda, profissional}) {
      const inicio=Date.now();
      const r=profissional === null ? null : identificar(profissional,profissionais);
      if (r && (r.erro || r.encontrados.length!==1)) {
        registrar('descobrir_profissionais_agenda','PROFISSIONAL_NAO_ENCONTRADO',inicio);
        return {ok:false,motivo:'PROFISSIONAL_NAO_RESOLVIDO'};
      }
      const id=r ? r.encontrados[0]!.id : await ancoraDaConta().catch(()=>null);
      if (!id) {
        registrar('descobrir_profissionais_agenda','DEPENDENCIA_CONTA',inicio);
        return {ok:false,motivo:'CONTA_NAO_IDENTIFICADA'};
      }
      try {
        const status=(await deps.consultarStatus(id))[agenda];
        if (status.indisponivel) {
          registrar('descobrir_profissionais_agenda',
            status.motivo === 'INTEGRACAO_NAO_CONFIGURADA' ? 'INTEGRACAO_NAO_CONFIGURADA' : 'STATUS_INDISPONIVEL',inicio);
          return {ok:false,motivo:status.motivo === 'INTEGRACAO_NAO_CONFIGURADA'
            ? 'INTEGRACAO_NAO_CONFIGURADA' : 'CONEXAO_INDISPONIVEL'};
        }
        if (!status.conectada) {
          registrar('descobrir_profissionais_agenda','CONEXAO_PENDENTE',inicio);
          return {ok:false,motivo:status.salvo?'ACESSO_SALVO_SEM_CONEXAO':'AGENDA_NAO_CONECTADA'};
        }
        if(deps.solicitarTrabalho) {
          // A referência técnica de uma conexão legada pode ser médico da conta.
          // Isso NÃO atribui consulta ao médico; apenas reusa a sessão correta.
          const referenciaLegada=contaDoCofreId(id)?null:id;
          const pedido=await deps.solicitarTrabalho('descoberta_agenda',agenda,referenciaLegada);
          deps.aoTrabalho?.({tipo:'descoberta_agenda',agenda,estado:pedido});
          registrar('descobrir_profissionais_agenda',pedido.ok?'TRABALHO_REGISTRADO':'TRABALHO_INDISPONIVEL',inicio);
          return pedido.ok?{ok:true,estado:pedido.estado,observacao:'A leitura dos nomes será entregue quando o navegador concluir. Nenhum nome novo foi confirmado ainda.'}:
            {ok:false,motivo:pedido.motivo};
        }
        const resultado=await deps.descobrirProfissionais!(id,agenda);
        const nomes = resultado.ok ? (resultado.nomes??[]).filter(nomeProfissionalValido).slice(0,20) : [];
        registrar('descobrir_profissionais_agenda',resultado.ok ? (nomes.length ? 'PROFISSIONAIS_ENCONTRADOS' : 'PROFISSIONAIS_NAO_IDENTIFICADOS') : 'STATUS_INDISPONIVEL',inicio);
        if (resultado.ok && nomes.length) deps.aoComprovante?.({ tipo: 'descobrir_profissionais', profissionalId: id, agenda });
        return resultado.ok ? {ok:true,nomes, aviso:'Nomes da leitura real da agenda, ainda não confirmados nem vinculados. Não apresentar cadastro técnico.'}
          : {ok:false,motivo:resultado.motivo??'LEITURA_INDISPONIVEL'};
      } catch {
        registrar('descobrir_profissionais_agenda','STATUS_INDISPONIVEL',inicio);
        return {ok:false,motivo:'LEITURA_INDISPONIVEL'};
      }
    }
  }));
  // Consentimento interpretado pelo mesmo agente conversacional, com alvo
  // limitado pela descoberta autenticada. Nenhuma regex de "sim" é permissão.
  let vinculoNesteTurno=false;
  if (deps.confirmarProfissionais) extras.push(tool({
    name:'confirmar_profissionais_descobertos',
    description:'Ferramenta obrigatória quando existir descoberta autenticada aguardando confirmação. Classifique a intenção da mensagem atual: confirmar somente com autorização explícita; negar quando recusar; corrigir quando contestar o nome; esclarecer quando for pergunta ou outro assunto. NÃO trate toda mensagem como confirmação. Só vincule alvo comprovado; com vários nomes, não suponha qual é o profissional. Não reler a agenda, não pesquisar CRM/RQE na mesma ferramenta.',
    parameters:z.object({
      agenda:z.enum(['tribemd','amplimed']),
      profissionalBase:z.string().nullable(),
      decisao:z.enum(['confirmar','negar','corrigir','esclarecer']),
      nomes:z.array(z.string().trim().min(2).max(150)).max(10).default([])
    }),
    async execute({agenda,profissionalBase,decisao,nomes}){
      const inicio=Date.now();
      if(vinculoNesteTurno){
        registrar('confirmar_profissionais_descobertos','DEPENDENCIA_CONFIRMACAO',inicio);
        deps.aoVinculoResultado?.({ok:false,motivo:'VINCULO_JA_PROCESSADO_NO_TURNO'});
        return {ok:false,motivo:'VINCULO_JA_PROCESSADO_NO_TURNO'};
      }
      const decisaoValidada=decidirVinculo(entrada.estadoConversa,{
        agenda,decisao,nomes,mensagem:entrada.texto
      });
      if(!decisaoValidada.ok){
        registrar('confirmar_profissionais_descobertos',decisaoValidada.motivo,inicio);
        deps.aoVinculoResultado?.({ok:false,motivo:decisaoValidada.motivo});
        return {ok:false,motivo:decisaoValidada.motivo,proximaEtapa:explicarVinculoNaoExecutado(decisaoValidada.motivo)};
      }
      // Uma escolha por turno permite que cada confirmação tenha uma prova
      // e uma pesquisa identificável; não inferir autorização em lote.
      if(decisaoValidada.nomes.length!==1){
        registrar('confirmar_profissionais_descobertos','PROFISSIONAL_AMBIGUO',inicio);
        deps.aoVinculoResultado?.({ok:false,motivo:'ALVO_AMBIGUO'});
        return {ok:false,motivo:'ALVO_AMBIGUO'};
      }
      const base=profissionalBase===null?null:identificar(profissionalBase,profissionais);
      const baseId=base?base.encontrados.length===1?base.encontrados[0]!.id:null:
        await ancoraDaConta().catch(()=>null);
      if(!baseId){
        registrar('confirmar_profissionais_descobertos','PROFISSIONAL_NAO_ENCONTRADO',inicio);
        deps.aoVinculoResultado?.({ok:false,motivo:'CONTA_NAO_IDENTIFICADA'});
        return {ok:false,motivo:'CONTA_NAO_IDENTIFICADA'};
      }
      vinculoNesteTurno=true;
      try{
        // Status é barato; NÃO reabrir a agenda de 62s. Nomes são o snapshot
        // autenticado e persistido quando a conexão foi comprovada.
        const status=(await deps.consultarStatus(baseId))[agenda];
        if(status.indisponivel||!status.conectada){
          const motivo=status.indisponivel?'STATUS_INDISPONIVEL':'CONEXAO_PENDENTE';
          registrar('confirmar_profissionais_descobertos',motivo,inicio);
          deps.aoVinculoResultado?.({ok:false,motivo});
          return {ok:false,motivo,observacao:'Vínculo não executado. CRM/RQE não foram consultados nem validados.'};
        }
        const r=await deps.confirmarProfissionais!(baseId,decisaoValidada.nomes);
        if(!r.ok){
          registrar('confirmar_profissionais_descobertos','PROFISSIONAL_AMBIGUO',inicio);
          deps.aoVinculoResultado?.({ok:false,motivo:r.motivo??'VINCULO_INDISPONIVEL'});
          return {ok:false,motivo:r.motivo??'VINCULO_INDISPONIVEL',observacao:'Não fiz pesquisa ou cadastro de CRM/RQE.'};
        }
        const medico=r.medicos?.[0];
        // A conta já confirmou a operação. Conservar o marco mesmo se a
        // gravação da etapa ou o agendamento CRM levar mais que o turno.
        deps.aoVinculoResultado?.({ok:true,nome:decisaoValidada.nomes[0]!,registrado:false,pesquisa:'indisponivel'});
        let pesquisa:'agendada'|'ja_existe'|'indisponivel'='indisponivel';
        let registrado=Boolean(medico);
        if(medico&&deps.aoVinculo){
          const acompanhamento=await deps.aoVinculo(agenda,medico);
          pesquisa=acompanhamento.pesquisa;
          registrado=acompanhamento.registrado;
        }
        registrar('confirmar_profissionais_descobertos','PROFISSIONAIS_CONFIRMADOS',inicio);
        deps.aoVinculoResultado?.({ok:true,nome:decisaoValidada.nomes[0]!,registrado,pesquisa});
        deps.aoComprovante?.({tipo:'vincular_profissionais',profissionalId:baseId,agenda});
        return {ok:true,vinculoRegistrado:registrado,nome:decisaoValidada.nomes[0],
          pesquisaPublica:pesquisa==='agendada'?'iniciada':pesquisa==='ja_existe'?'ja_em_andamento':'indisponivel',
          observacao:'CRM/RQE ainda não foram pesquisados nem validados. Nenhum dado profissional foi gravado.'};
      }catch{
        registrar('confirmar_profissionais_descobertos','FERRAMENTA_INDISPONIVEL',inicio);
        deps.aoVinculoResultado?.({ok:false,motivo:'OPERACAO_INDISPONIVEL'});
        return {ok:false,motivo:'OPERACAO_INDISPONIVEL',observacao:'Não afirmar falha de validação de CRM/RQE; a operação de vínculo não terminou com evidência.'};
      }
    }
  }));
  if (deps.solicitarLinkAgenda) extras.push(tool({
    name: 'solicitar_link_seguro_agenda',
    description: 'Após escolha explícita de agenda, envia link único ao operador autorizado. profissional=null permite primeira conexão pela CONTA, sem médico conhecido. Nunca recebe senha.',
    parameters: z.object({ agenda:z.enum(['tribemd','amplimed']), profissional:z.string().nullable() }),
    async execute({agenda,profissional}) {
      const inicio=Date.now();
      const r=profissional === null ? null : identificar(profissional,profissionais);
      const id=r ? r.encontrados.length===1 ? r.encontrados[0]!.id : null
        : await ancoraDaConta().catch(()=>null);
      const escolhido=profissional === null || (r?.encontrados.length===1 &&
        (entrada.estadoConversa?.profissionalConfirmadoId===id ||
        normalizarNomeMedico(entrada.texto).includes(normalizarNomeMedico(profissional))));
      const agendaEscolhida=entrada.estadoConversa?.agendaEscolhida===agenda ||
        (agenda === 'tribemd' ? /\btribe(?:md)?\b/i.test(entrada.texto) : /\bamplimed\b/i.test(entrada.texto));
      if (!id || !escolhido || !agendaEscolhida) {
        registrar('solicitar_link_seguro_agenda', !id?'DEPENDENCIA_CONTA':'DEPENDENCIA_PROFISSIONAL',inicio);
        return {aceitoParaEnvio:false,motivo:!id?'CONTA_NAO_IDENTIFICADA':'ESCOLHA_DE_AGENDA_NECESSARIA'};
      }
      try {
        const estado=(await deps.consultarStatus(id))[agenda];
        if (estado.indisponivel) {
          registrar('solicitar_link_seguro_agenda',estado.motivo==='INTEGRACAO_NAO_CONFIGURADA'?'INTEGRACAO_NAO_CONFIGURADA':'STATUS_INDISPONIVEL',inicio);
          return {aceitoParaEnvio:false,motivo:estado.motivo==='INTEGRACAO_NAO_CONFIGURADA'?'INTEGRACAO_NAO_CONFIGURADA':'NAO_CONSEGUI_VERIFICAR'};
        }
        if (estado.conectada) {
          registrar('solicitar_link_seguro_agenda','CONEXAO_EXISTENTE',inicio);
          return {aceitoParaEnvio:false,motivo:'JA_CONECTADA',
            proximaEtapa:'Conexao comprovada: descobrir profissionais na agenda antes de pedir confirmacao.'};
        }
        const resultado=await deps.solicitarLinkAgenda!(id,agenda);
        registrar('solicitar_link_seguro_agenda',resultado.aceitoParaEnvio?'LINK_ACEITO_PARA_ENVIO':'FERRAMENTA_INDISPONIVEL',inicio);
        // Jamais produzir comprovante de tarefa concluída a partir de HTTP 2xx.
        return resultado.aceitoParaEnvio
          ? {aceitoParaEnvio:true,entregue:false,
            observacao:'A Evolution aceitou o pedido de envio. Ainda não há comprovante de entrega. Não afirmar que a pessoa recebeu, não reenviar link ou URL automaticamente.'}
          : {aceitoParaEnvio:false,entregue:false,motivo:resultado.motivo??'ENVIO_INDISPONIVEL'};
      } catch {
        registrar('solicitar_link_seguro_agenda','FERRAMENTA_INDISPONIVEL',inicio);
        return {aceitoParaEnvio:false,motivo:'ENVIO_INDISPONIVEL'};
      }
    }
  }));
  if (deps.consultarEntregaLink) extras.push(tool({
    name:'consultar_status_entrega_link_agenda',
    description:'Consulta comprovantes reais da mensagem que contem link seguro. Nao le token, URL ou senha; nao dispara reenvio.',
    parameters:z.object({agenda:z.enum(['tribemd','amplimed'])}),
    async execute({agenda}) {
      const inicio=Date.now();
      const referencia=await ancoraDaConta().catch(()=>null);
      if(!referencia) {
        registrar('consultar_status_entrega_link_agenda','DEPENDENCIA_CONTA',inicio);
        return {ok:false,motivo:'CONTA_NAO_IDENTIFICADA'};
      }
      try {
        const status=await deps.consultarEntregaLink!(referencia,agenda);
        deps.aoConsultaEntregaLink?.(agenda,status);
        registrar('consultar_status_entrega_link_agenda',
          status?.estado==='ENTREGUE'?'LINK_ENTREGUE':status?.estado==='LIDO'?'LINK_LIDO':'ENTREGA_CONSULTADA',inicio);
        if(!status) return {ok:true,estado:'SEM_EVIDENCIA',orientacao:'Nao encontrei um recibo de envio confirmado. Nao presuma entrega nem gere novo link automaticamente.'};
        const mensagens:Record<string,string>={
          ACEITO_SEM_CONFIRMACAO:'O pedido foi aceito pelo serviço de mensagens, mas ainda não há confirmação de entrega.',
          AGUARDANDO_ENTREGA:'O servidor do WhatsApp aceitou a mensagem; ainda não há confirmação de entrega ao aparelho.',
          SEM_CONFIRMACAO:'Ainda não veio confirmação de entrega. A demora não prova uma falha.',
          ENTREGUE:'O WhatsApp confirmou a entrega ao aparelho. Isso não prova que a página foi aberta.',
          LIDO:'O WhatsApp registrou leitura. Isso não prova que o link foi aberto ou que o login foi realizado.',
          ERRO_COMPROVADO:'O WhatsApp informou erro para essa mensagem; não vou reenviar o link automaticamente.'
        };
        return {ok:true,estado:status.estado,orientacao:mensagens[status.estado]??mensagens.SEM_CONFIRMACAO,
          semReenvioAutomatico:true};
      } catch {
        registrar('consultar_status_entrega_link_agenda','FERRAMENTA_INDISPONIVEL',inicio);
        return {ok:false,motivo:'STATUS_ENTREGA_INDISPONIVEL'};
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
        deps.aoComprovante?.({ tipo: 'verificar_prontidao', profissionalId: r.encontrados[0]!.id });
        return {ok:true,...prontidao,observacao:'Nenhuma emissão foi realizada e nenhuma preferência fiscal foi alterada.'};
      }catch{
        registrar('consultar_prontidao_onboarding','FERRAMENTA_INDISPONIVEL',inicio);
        return {ok:false,motivo:'PRONTIDAO_INDISPONIVEL'};
      }
    }
  }));

  // O formulário seguro é o único caminho para digitação/correção de números.
  // Confirmação de sugestão já exibida é decisão tipada, não frase fixa.
  if(deps.solicitarLinkRegistro)extras.push(tool({
    name:'solicitar_link_seguro_registro',
    description:'CRM/RQE no Cofre: autorizar solicita link quando não há ativo ou falhou comprovadamente; consultar verifica recibo sem envio; substituir exige novo consentimento explícito para invalidar link incerto/aceito sem entrega e só então criar outro. Não inferir falha pela falta de ACK.',
    parameters:z.object({
      profissional:z.string(),
      decisao:z.enum(['autorizar','recusar','esclarecer','consultar','substituir'])
    }),
    async execute({profissional,decisao}){
      const inicio=Date.now();
      const alvo=identificar(profissional,profissionais);
      const medico=alvo.encontrados.length===1?alvo.encontrados[0]:undefined;
      const estado=medico?entrada.estadoConversa?.pesquisasRegistro?.[medico.id]:undefined;
      if(!medico||entrada.estadoConversa?.profissionalConfirmadoId!==medico.id ||
         !estado||!['manual_pendente','aguardando_confirmacao','aguardando_preenchimento','link_manual_reservado'].includes(estado.estado)){
        registrar('solicitar_link_seguro_registro','DEPENDENCIA_PROFISSIONAL',inicio);
        deps.aoLinkRegistro?.({ok:false,nome:medico?.nome??'',motivo:'REVISAO_NAO_DISPONIVEL'});
        return {ok:false,motivo:'REVISAO_NAO_DISPONIVEL'};
      }
      if(!['autorizar','consultar','substituir'].includes(decisao)){
        registrar('solicitar_link_seguro_registro','DEPENDENCIA_CONFIRMACAO',inicio);
        deps.aoLinkRegistro?.({ok:false,nome:medico.nome,motivo:'SEM_AUTORIZACAO'});
        return {ok:false,motivo:'SEM_AUTORIZACAO'};
      }
      const pendencias=Object.entries(entrada.estadoConversa?.pesquisasRegistro??{})
        .filter(([_,r])=>['manual_pendente','aguardando_confirmacao','aguardando_preenchimento','link_manual_reservado'].includes(r.estado));
      if(pendencias.length>1){
        const dito=normalizarNomeMedico(entrada.texto);
        const exato=normalizarNomeMedico(medico.nome);
        const tokens=exato.split(' ').filter(t=>t.length>=4);
        const explicito=dito.includes(exato)||tokens.some(t=>dito.split(' ').includes(t)&&
          pendencias.filter(([_,p])=>normalizarNomeMedico(p.nome).split(' ').includes(t)).length===1);
        if(!explicito){
          registrar('solicitar_link_seguro_registro','PROFISSIONAL_AMBIGUO',inicio);
          deps.aoLinkRegistro?.({ok:false,nome:medico.nome,motivo:'ALVO_AMBIGUO'});
          return {ok:false,motivo:'ALVO_AMBIGUO'};
        }
      }
      try{
        const r=await deps.solicitarLinkRegistro!(medico.id,decisao==='substituir'?'substituir':decisao==='consultar'?'consultar':'solicitar');
        registrar('solicitar_link_seguro_registro',r.motivo==='ACEITO_API'?'LINK_ACEITO_PARA_ENVIO':'DEPENDENCIA_CONFIRMACAO',inicio);
        deps.aoLinkRegistro?.({ok:r.ok,nome:medico.nome,motivo:r.motivo,anteriorInvalidado:r.anteriorInvalidado});
        return {ok:r.ok,estado:r.motivo,preenchido:false,confirmado:false,
          proximaAcao:r.motivo==='FALHA_COMPROVADA'?'solicitar_novo_com_autorizacao':
            ['ENVIO_INCERTO','ACEITO_SEM_ENTREGA'].includes(r.motivo??'')?
             'consultar_recibo_ou_substituir_com_autorizacao':'verificar_estado',
          observacao:'O estado é de envio, não de preenchimento ou aprovação.'};
      }catch{
        registrar('solicitar_link_seguro_registro','FERRAMENTA_INDISPONIVEL',inicio);
        deps.aoLinkRegistro?.({ok:false,nome:medico.nome,motivo:'ENVIO_INCERTO'});
        return {ok:false,motivo:'ENVIO_INCERTO'};
      }
    }
  }));

  if(deps.aprovarRegistroProfissional || deps.solicitarLinkRegistro)extras.push(tool({
    name:'revisar_registro_profissional',
    description:'Interprete a autorização natural para aprovar uma sugestão que o Noto JÁ apresentou. Correção exige cofre seguro, jamais números enviados por WhatsApp. A resposta da ferramenta determina o relato, não o texto livre da IA.',
    parameters:z.object({
      profissional:z.string(),
      decisao:z.enum(['aprovar','corrigir','recusar','esclarecer'])
    }),
    async execute({profissional,decisao}){
      const inicio=Date.now();
      const resolucao=identificar(profissional,profissionais);
      const medico=resolucao.encontrados.length===1?resolucao.encontrados[0]:undefined;
      const estado=medico?entrada.estadoConversa?.pesquisasRegistro?.[medico.id]:undefined;
      const falhar=(motivo:string)=>{
        registrar('revisar_registro_profissional','DEPENDENCIA_CONFIRMACAO',inicio);
        deps.aoRevisaoRegistro?.({ok:false,motivo});
        return {ok:false,motivo};
      };
      if(!medico||entrada.estadoConversa?.profissionalConfirmadoId!==medico.id ||
        estado?.estado!=='aguardando_confirmacao')
        return falhar('PESQUISA_OU_VINCULO_AINDA_PENDENTE');
      if(decisao==='esclarecer')return falhar('PRECISA_ESCLARECER');
      if(decisao==='recusar')return falhar('NAO_APROVADO');
      if(decisao==='corrigir'){
        if(!deps.solicitarLinkRegistro)return falhar('COFRE_INDISPONIVEL');
        const r=await deps.solicitarLinkRegistro(medico.id,'solicitar').catch(()=>({ok:false,motivo:'ENVIO_INCERTO'}));
        registrar('revisar_registro_profissional',r.motivo==='ACEITO_API'?'LINK_ACEITO_PARA_ENVIO':'DEPENDENCIA_CONFIRMACAO',inicio);
        if(!r.ok)return falhar(r.motivo??'ENVIO_INCERTO');
        deps.aoRevisaoRegistro?.({ok:true,tipo:'correcao',nome:medico.nome,motivo:r.motivo});
        return {ok:r.ok,gravado:false,
          observacao:r.ok?'Link para correção aceito pela API; aguardar preenchimento e nova aprovação.':
            'Não confirmei o envio de um link. Não alterei dados profissionais.'};
      }
      if(!estado.proposta && (estado.razao!=='ENCONTRADO' || (estado.candidatos?.length??0)!==1))
        return falhar('REGISTRO_AMBIGUO');
      if(!deps.aprovarRegistroProfissional)return falhar('GRAVACAO_INDISPONIVEL');
      const r=await deps.aprovarRegistroProfissional(medico.id).catch(()=>({ok:false as const,motivo:'GRAVACAO_INDISPONIVEL'}));
      if(!r.ok)return falhar(r.motivo);
      registrar('revisar_registro_profissional','DADOS_PROFISSIONAIS_SALVOS',inicio);
      deps.aoRevisaoRegistro?.({ok:true,tipo:'aprovacao',nome:r.nome,crm:r.crm,rqe:r.rqe});
      deps.aoComprovante?.({tipo:'salvar_dados_profissionais',profissionalId:medico.id});
      return {ok:true,gravado:true,crm:r.crm,rqe:r.rqe};
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
          deps.aoComprovante?.({ tipo: 'verificar_certificado', profissionalId: medico.id });
          return {ok:true,certificadoValido:true,orientacao:'Certificado válido; não pedir novo envio.'};
        }
        const origem=new URL(entrada.painelUrl!);
        if(origem.protocol!=='https:'||origem.username||origem.password||origem.pathname!=='/'||origem.search||origem.hash)
          throw new Error('ORIGEM_NAO_CONFIAVEL');
        const url=linkCertificadoMedico(origem.origin,medico.id);
        registrar('orientar_certificado_seguro','CERTIFICADO_PENDENTE',inicio);
        deps.aoComprovante?.({ tipo: 'verificar_certificado', profissionalId: medico.id });
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
    modelSettings:{
      maxTokens:1024,
      ...(confirmacaoPendente ? {
        // 'required' deixaria a IA escolher qualquer ferramenta ou texto.
        // O SDK exige exatamente esta ferramenta no PRIMEIRO turno do modelo.
        toolChoice:'confirmar_profissionais_descobertos',
        parallelToolCalls:false
      } : {})
    },
    tools: [consultarConta, consultarAgendas, orientarConexao, ...extras],
    // Vincular é um marco transacional: o resultado da ferramenta já é
    // narrado com base na evidência. Evita segunda inferência cara/lenta,
    // que estava abortando o turno de confirmação após 20 segundos.
    toolUseBehavior:{stopAtToolNames:['confirmar_profissionais_descobertos']}
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
  const naoConfigurada = eventos.some(e => e.codigo === 'INTEGRACAO_NAO_CONFIGURADA');
  // Não converter falta de infraestrutura em culpa da plataforma ou retentativa.
  if (naoConfigurada && /(?:tentar (?:de novo|novamente|mais tarde|depois)|tente (?:de novo|novamente|mais tarde|depois)|instabilidade|instavel|fora do ar|falha (?:da|na|do) (?:tribemd|tribe|amplimed)|(?:tribemd|tribe|amplimed) (?:falhou|esta fora|indisponivel))/.test(normalizada)) return false;
  const estadosIndisponiveis = eventos.some(e =>
    ['STATUS_INDISPONIVEL', 'STATUS_PARCIAL', 'FERRAMENTA_INDISPONIVEL', 'INTEGRACAO_NAO_CONFIGURADA'].includes(e.codigo));
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

    // Confirmações de ações do onboarding só podem aparecer após a
    // ferramenta correspondente. Uma negação restrita à mesma oração passa.
    const verificarAcao = (expressao: RegExp, codigo: CodigoFerramenta): boolean => {
      for (const match of oracao.matchAll(expressao)) {
        const antes = oracao.slice(0, match.index).trimEnd();
        if (!negada(antes) && !eventos.some(e => e.codigo === codigo)) return false;
      }
      return true;
    };
    // Sem DELIVERY_ACK/READ na mesma mensagem, nao afirmar "enviei/recebeu".
    if (/\b(?:enviei|mandei|enviamos|mandamos)\s+(?:(?:o|um)\s+)?link\b|\b(?:voce|tu)\s+(?:ja\s+)?(?:recebeu|recebeste)\s+(?:(?:o|um)\s+)?link\b/.test(oracao)) {
      const match=oracao.match(/\b(?:enviei|mandei|enviamos|mandamos|recebeu|recebeste)\b/);
      if (!negada(oracao.slice(0,match?.index??0).trimEnd())) return false;
    }
    if (/\b(?:o|esse|meu|seu)\s+link\b[^.!?;\n]{0,65}\b(?:foi|esta|chegou)\s+(?:ja\s+)?(?:entregue|recebido)\b|\b(?:whatsapp|aparelho)\s+(?:ja\s+)?(?:recebeu|confirmou a entrega)\s+(?:(?:o|do|um)\s+)?link\b/.test(oracao)
        && !eventos.some(e=>e.codigo==='LINK_ENTREGUE'||e.codigo==='LINK_LIDO')) return false;
    if (!verificarAcao(/\b(?:registrei|atualizei|salvei)\s+(?:(?:o|um|os)\s+)?(?:crm|rqe|nome completo|dados profissionais)\b/g, 'DADOS_PROFISSIONAIS_SALVOS')) return false;
    if (!verificarAcao(/\b(?:crm|rqe|dados profissionais)\s+(?:(?:ja|esta|foi)\s+)*(?:registrad[oa]s?|atualizad[oa]s?|salv[oa]s?)\b/g, 'DADOS_PROFISSIONAIS_SALVOS')) return false;
    if (!verificarAcao(/\b(?:foi adicionad[oa]|foram adicionad[oa]s|cadastrei|adicionei)\b[^.!?;\n]{0,65}\b(?:conta|medic[oa]s?|profissionais)\b/g, 'PROFISSIONAIS_CONFIRMADOS')) return false;
    if (!verificarAcao(/\bencontrei\b[^.!?;\n]{0,100}\bna agenda\b/g, 'PROFISSIONAIS_ENCONTRADOS')) return false;

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

/**
 * O transportador e as ferramentas são a autoridade dos MARCOS de ação.
 * Para transições executadas neste turno, o modelo não narra o estado do
 * transporte: a resposta vem de evidência tipada, não de frases proibidas.
 * Fora dessas transições, preserva integralmente a conversa livre.
 */
export function acompanhamentoVerificado(
  entrada: EntradaAgente, eventos: readonly EventoFerramenta[]
): string | null {
  const tem=(codigo:CodigoFerramenta)=>eventos.some(e=>e.codigo===codigo);
  const agenda=entrada.estadoConversa?.agendaEscolhida??entrada.situacaoUltimoLink?.agenda;
  const nomeAgenda=agenda==='tribemd'?'TribeMD':agenda==='amplimed'?'Amplimed':'agenda';
  if(tem('LINK_ACEITO_PARA_ENVIO')) return [
    `O serviço de mensagens aceitou o pedido do link seguro para a ${nomeAgenda}.`,
    'O link já foi aceito para envio, mas não tenho confirmação de entrega no WhatsApp.',
    'Depois que a conexão for confirmada, vou identificar os médicos na agenda.'
  ].join(' ');
  if(tem('CONEXAO_EXISTENTE')) return [
    `A agenda ${nomeAgenda} já está conectada.`,
    'Antes de vincular qualquer médico, precisamos verificar os profissionais na fonte.',
    'Nenhum profissional será adicionado sem sua confirmação.'
  ].join(' ');
  if(tem('LINK_ENTREGUE')||tem('LINK_LIDO')) return [
    tem('LINK_LIDO')?'O WhatsApp registrou a leitura do link seguro.':'O WhatsApp confirmou a entrega do link seguro.',
    'Isso não confirma o login na agenda.',
    'A verificação dos médicos começa depois da conexão autenticada.'
  ].join(' ');
  // Histórico de link e fases são contexto. Somente fatos deste turno entram no relato.
  return null;
}

/** Traduz apenas evidência da ferramenta, mesmo quando o Runner é interrompido.
 * Não declara vínculo executado se só houve decisão ou erro de dependência. */
function explicarResultadoVinculo(
  v:{ok:true;nome:string;registrado:boolean;pesquisa:'agendada'|'ja_existe'|'indisponivel'}|
    {ok:false;motivo:string}
):string{
  if(!v.ok)return v.motivo==='CONEXAO_PENDENTE'||v.motivo==='STATUS_INDISPONIVEL'
    ?'Ainda não confirmei o acesso necessário para vincular o profissional. Não consultei nem validei CRM ou RQE.'
    :v.motivo==='VINCULO_JA_PROCESSADO_NO_TURNO'
      ?'A solicitação de vínculo já foi processada neste turno. Não repeti o cadastro nem a pesquisa.'
      :explicarVinculoNaoExecutado(v.motivo);
  if(!v.registrado)return 'O cadastro aceitou o vínculo de '+v.nome+
    ', mas ainda não confirmei a gravação da etapa na conversa. Vou conferir essa etapa antes de pesquisar CRM/RQE.';
  const confirmacao='Vinculei '+v.nome+' à sua conta.';
  if(v.pesquisa==='agendada')return confirmacao+
    ' Vou pesquisar CRM e RQE nas fontes públicas e te mostrar os dados antes de salvar.';
  if(v.pesquisa==='ja_existe')return confirmacao+
    ' A pesquisa pública já está registrada. Vou aproveitar o resultado existente, sem repeti-la.';
  return confirmacao+
    ' A consulta pública de CRM/RQE não está disponível para iniciar agora; não vou inventar esses dados.';
}

/** Relato coerente com o resultado do Cofre e os ACKs, não com regex do modelo. */
function falaEnvioRegistro(motivo:string|undefined,nome:string,anteriorInvalidado=false):string{
  const alvo=nome?' de '+nome:'';
  const troca=anteriorInvalidado?'Invalidei o link anterior para que apenas o novo possa ser usado. ':'';
  switch(motivo){
    case 'ACEITO_API':
    case 'ACEITO_SEM_ENTREGA':
      return troca+'O serviço aceitou o link seguro'+alvo+', mas o WhatsApp ainda não confirmou entrega. Posso conferir o recibo. Se não chegou, você pode autorizar a invalidação do anterior e uma nova solicitação.';
    case 'ENVIO_INCERTO':
      return troca+'O resultado do envio do link seguro'+alvo+' ficou incerto. Não sei se a mensagem chegou e não vou reenviá-la às cegas. Posso conferir o recibo; se você preferir, podemos invalidar o link anterior e pedir outro com sua autorização.';
    case 'FALHA_COMPROVADA':
      return troca+'O envio do link seguro'+alvo+' falhou de forma comprovada. Posso solicitar outro agora, com sua autorização, sem manter o link anterior utilizável.';
    case 'ENTREGUE':
      return 'O WhatsApp confirmou a entrega do link seguro'+alvo+'. Isso ainda não significa que o formulário foi preenchido.';
    case 'LIDO':
      return 'O WhatsApp confirmou a leitura da mensagem com o link seguro'+alvo+'. Ainda aguardo o preenchimento.';
    case 'LINK_ENTREGUE':
      return 'O link seguro'+alvo+' já teve a entrega confirmada. Não gerei outro; posso ajudar se a página não abriu.';
    case 'PEDIDO_JA_PROCESSADO':
      return 'Esse pedido de link seguro'+alvo+' já foi processado. Não reenviei nada. Posso verificar o estado atual.';
    case 'SEM_LINK_ATIVO':
      return 'Não existe um link seguro ativo'+alvo+'. Se você autorizar, posso solicitar um novo.';
    case 'LIMITE_LINKS':
      return 'O limite de criação de links seguros foi atingido. Não fiz outro envio; precisamos respeitar esse limite.';
    case 'SEM_AUTORIZACAO':
      return 'Não solicitei outro link. Preciso da sua autorização para realizar essa ação.';
    case 'REVISAO_NAO_AUTORIZADA':
    case 'REVISAO_NAO_DISPONIVEL':
      return 'A revisão dos dados'+alvo+' ainda não está confirmada. Não gerei outro link nem alterei o cadastro.';
    default:
      return 'Ainda não tenho um estado verificável para o link seguro'+alvo+'. Não repeti o envio. Podemos verificar o que ficou pendente.';
  }
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
  if(!deps.modeloTeste&&deps.exigirControleCusto&&!deps.controleCusto){
    registrar('SEM_MODELO');
    return 'Os testes com IA estão pausados: este processo não possui acesso ao controle de gastos da rodada. Não fiz chamadas pagas.';
  }
  if (!deps.modeloTeste && !deps.apiKey) {
    registrar('SEM_MODELO');
    return 'Sou o Noto! Posso te orientar a conectar uma agenda e organizar o trabalho fiscal. O atendimento inteligente está temporariamente indisponível. Quer verificar sua conexão pelo painel?';
  }
  const trabalhoTurno: { atual?: { tipo:TipoTrabalhoNoto; agenda:AgendaEscolhida; estado:ResultadoEnfileirar } } = {};
  const vinculoTurno:{atual?: {ok:true;nome:string;registrado:boolean;pesquisa:'agendada'|'ja_existe'|'indisponivel'}|{ok:false;motivo:string}}={};
  const revisaoTurno:{atual?: {ok:true;tipo:'aprovacao';nome:string;crm:string;rqe:string|null}|{ok:true;tipo:'correcao';nome:string;motivo?:string}|{ok:false;motivo:string}}={};
  const linkRegistroTurno:{atual?:{ok:boolean;nome:string;motivo?:string;anteriorInvalidado?:boolean}}={};
  const linkConsultado: { atual?: { agenda: AgendaEscolhida; estado: {estado:string;comId:boolean}|null } } = {};
  const abort = new AbortController();
  const relogio = setTimeout(() => abort.abort(), 20_000);
  try {
    const panoramaTurno: { resultado?: ResultadoPanoramaFiscal } = {};
    const conferenciaTurno: { resultado?: ResultadoConferencia } = {};
    const agent = criarAgenteNoto(entrada, {
      ...deps,
      aoPanorama: (foco, resultado) => {
        panoramaTurno.resultado = resultado;
        deps.aoPanorama?.(foco, resultado);
      },
      aoConferencia: resultado => {
        conferenciaTurno.resultado=resultado;
        deps.aoConferencia?.(resultado);
      },
      aoTrabalho: trabalho => {
        trabalhoTurno.atual=trabalho;
        deps.aoTrabalho?.(trabalho);
      },
      aoConsultaEntregaLink: (agenda,estado) => {linkConsultado.atual={agenda,estado};},
      aoVinculoResultado:r=>{vinculoTurno.atual=r;},
      aoRevisaoRegistro:r=>{revisaoTurno.atual=r;},
      aoLinkRegistro:r=>{linkRegistroTurno.atual=r;},
      registrarFerramenta: e => ferramentas.push(e)
    });
    const runner = new Runner({
      ...(deps.modeloTeste ? {} : { modelProvider: deps.controleCusto?
        new ProvedorAgenteComOrcamento(new OpenAIProvider({openAIClient:new OpenAI({apiKey:deps.apiKey!,maxRetries:0}),useResponses:true}),deps.controleCusto):
        new OpenAIProvider({apiKey:deps.apiKey!,useResponses:true}) }),
      tracingDisabled: !deps.tracesAtivos,
      traceIncludeSensitiveData: false,
      workflowName: 'Noto Assistente - Entrega A'
    });
    const resultado = await runner.run(agent, [
      { role: 'user', content: JSON.stringify({
        mensagem: entrada.texto.slice(0, 1500),
        contextoAnterior: (entrada.contexto ?? []).slice(-3).map(s => s.slice(0, 500)),
        // IDs de mensagens e referências de tarefas ficam no orquestrador,
        // nunca no contexto enviado ao modelo externo.
        estadoConversacionalVerificado: Object.fromEntries(
          Object.entries(entrada.estadoConversa ?? {}).filter(([campo]) =>
            campo !== 'tarefasPendentes' && campo !== 'pesquisasRegistro')
        ),
        situacaoUltimoLink: entrada.situacaoUltimoLink??null,
        trabalhosEmAndamento: (entrada.trabalhos??[]).slice(0,4),
        registrosPublicosEmRevisao: Object.values(entrada.estadoConversa?.pesquisasRegistro??{}).slice(0,8)
          .map(r=>({profissional:r.nome,etapa:r.estado,resultado:r.razao,
            candidatos:r.candidatos?.map(c=>({crm:c.crm,rqes:c.rqes,origem:c.origem})),
            proposta:r.proposta?{crm:r.proposta.crm,rqe:r.proposta.rqe??null}:null}))
      }) }
    ], { maxTurns: 6, signal: abort.signal });
    const resposta = typeof resultado.finalOutput === 'string' ? resultado.finalOutput.trim() : '';
    const u = resultado.state.usage;
    const uso = {
      requisicoes: u.requests, tokensEntrada: u.inputTokens, tokensSaida: u.outputTokens, tokensTotal: u.totalTokens
    };
    // O provedor deve honrar toolChoice. Se não honrar (ou um modelo de
    // teste emitir texto livre), não aceitar nenhuma afirmação de vínculo.
    // Não repetir a IA: manter pendência e evidenciar a falha de contrato.
    if(exigeDecisaoVinculo(entrada,deps)&&!vinculoTurno.atual){
      registrar('CONFIRMACAO_SEM_FERRAMENTA',uso);
      return 'A confirmação do profissional ainda não foi processada pela verificação necessária. Não vinculei ninguém nem iniciei pesquisa de CRM/RQE. A etapa continua pendente para retomarmos com segurança.';
    }
    if(vinculoTurno.atual){
      registrar('RESPOSTA',uso);
      return explicarResultadoVinculo(vinculoTurno.atual);
    }
    if(linkRegistroTurno.atual){
      const l=linkRegistroTurno.atual;
      registrar('RESPOSTA',uso);
      return falaEnvioRegistro(l.motivo,l.nome,l.anteriorInvalidado);
    }
    if(revisaoTurno.atual){
      const r=revisaoTurno.atual;
      registrar('RESPOSTA',uso);
      if(!r.ok && r.motivo==='NAO_APROVADO')return 'Entendi, não salvei CRM nem RQE. Podemos revisar os dados quando quiser.';
      if(!r.ok)return r.motivo==='PESQUISA_OU_VINCULO_AINDA_PENDENTE'
        ?'Primeiro preciso concluir o vínculo e a pesquisa pública do profissional. Ainda não fiz validação de CRM/RQE.'
        : ['FALHA_COMPROVADA','ENVIO_INCERTO','ACEITO_SEM_ENTREGA','ENTREGUE','LIDO',
          'PEDIDO_JA_PROCESSADO','LINK_ENTREGUE','LIMITE_LINKS'].includes(r.motivo)
          ? falaEnvioRegistro(r.motivo,'')
          : 'Não salvei os dados: a confirmação ou a identificação do registro ainda não está completa.';
      if(r.tipo==='correcao')return falaEnvioRegistro(r.motivo,r.nome)+' Não alterei CRM nem RQE.';
      return 'Registrei os dados confirmados de '+r.nome+': CRM '+r.crm+
        (r.rqe?', RQE '+r.rqe:'')+'. Não alterei certificado nem parâmetros fiscais.';
    }
    // Recibo deste turno, não lembrança de um link antigo.
    if (linkConsultado.atual) {
      const {agenda,estado}=linkConsultado.atual;
      const fonte=agenda==='tribemd'?'TribeMD':'Amplimed';
      registrar('RESPOSTA',uso);
      if(!estado) return 'Consultei o envio do link da '+fonte+', mas não encontrei recibo confirmado. Não vou presumir entrega nem gerar outro link.';
      if(estado.estado==='ENTREGUE') return 'O WhatsApp confirmou a entrega do link da '+fonte+'. Ainda vou precisar da conexão autenticada para avançar.';
      if(estado.estado==='LIDO') return 'O WhatsApp registrou a leitura do link da '+fonte+'. Isso ainda não confirma o login na agenda.';
      if(estado.estado==='ERRO_COMPROVADO') return 'A entrega do link da '+fonte+' teve um erro comprovado. Não vou reenviar a credencial sem sua autorização.';
      if(estado.comId) return 'O pedido do link já foi aceito pelo serviço de mensagens para a '+fonte+'. Ainda não tenho confirmação de entrega no WhatsApp.';
      return 'Consultei o link da '+fonte+', mas a entrega ainda não está comprovada. Isso não quer dizer que houve uma falha.';
    }
    // Longa navegação virou trabalho registrado: não aguardar 62s no Runner.
    if (trabalhoTurno.atual) {
      const t=trabalhoTurno.atual, fonte=t.agenda==='tribemd'?'TribeMD':'Amplimed';
      registrar('RESPOSTA',uso);
      if(!t.estado.ok) return 'Não consegui iniciar a leitura da '+fonte+' porque a fila de tarefas está indisponível. Não vou afirmar que a consulta foi feita.';
      if(t.estado.estado==='ja_em_andamento') return 'A leitura da '+fonte+' já está em andamento. Pode continuar falando comigo enquanto ela termina.';
      return 'Comecei a conferir a '+fonte+'. Pode falar comigo normalmente; te aviso assim que a leitura terminar.';
    }
    // Conciliação e registros fiscais são narrados exclusivamente pelos fatos verificados.
    if (panoramaTurno.resultado || conferenciaTurno.resultado) {
      const textos: string[]=[];
      if (conferenciaTurno.resultado) textos.push(descreverConferencia(conferenciaTurno.resultado));
      if (panoramaTurno.resultado) {
        if (panoramaTurno.resultado.ok) textos.push(descreverPanoramaFiscal(panoramaTurno.resultado));
        else textos.push(panoramaTurno.resultado.motivo === 'SEM_PROFISSIONAIS_CONFIRMADOS'
          ? 'Ainda não tenho um médico confirmado nesta conta. Vou precisar identificar os profissionais na agenda antes de consultar os registros fiscais.'
          : panoramaTurno.resultado.motivo === 'ESCOPO_NAO_CONFERIDO'
            ? 'Não consegui conferir a identidade desse profissional na sua conta. Qual médico você quer consultar?'
            : 'Não consegui acessar os registros fiscais agora. Isso não significa que não haja notas ou solicitações; vou preservar a etapa para continuar com segurança.');
      }
      registrar('RESPOSTA',uso);
      return textos.join('\n');
    }
    const relato=acompanhamentoVerificado(entrada,ferramentas);
    if(relato) {
      // A abertura natural é livre, mas o relato da ação provém do
      // estado comprovado. Saída fora do contrato usa só o relato seguro.
      const partes=resposta.split('[[RESULTADO_ACAO]]');
      const introducao=partes.length===2 ? partes[0]!.trim() : '';
      const narracao=introducao.length>0 && introducao.length<=120
        ? introducao+' '+relato : relato;
      registrar('RESPOSTA',uso);
      return narracao;
    }
    if(resposta && !respostaCompativelComFerramentas(resposta,ferramentas)) {
      registrar('RESPOSTA_BLOQUEADA',uso);
      return ferramentas.some(e=>e.codigo==='INTEGRACAO_NAO_CONFIGURADA')
        ? 'A integração ainda não está configurada neste ambiente. É uma pendência local do Noto. Sua senha só entra na página segura.'
        : 'Não consegui confirmar isso pelas verificações disponíveis. Vou preservar a etapa atual sem afirmar que a ação foi concluída.';
    }
    registrar(resposta ? 'RESPOSTA' : 'SEM_RESPOSTA', uso);
    return resposta ? resposta.slice(0, 1200) : 'Não consegui concluir essa verificação. Podemos continuar com a conexão da agenda?';
  } catch (erro) {
    if(erro instanceof PausaCustoPiloto){
      registrar('RESPOSTA');
      return erro.motivo==='LIMITE_TESTE'?FALA_LIMITE_TESTE:
        erro.motivo==='SEM_RODADA'?
          'Os testes com IA estão pausados porque não há uma rodada ativa. Não fiz nova chamada. Uma nova rodada deve ser aberta pelo responsável pela homologação.':
        'Pausei a chamada de IA porque não consegui verificar o orçamento ou o preço do modelo. Não fiz essa chamada e não vou ultrapassar o limite por suposição.';
    }
    // Uma ferramenta já pode ter respondido ou gravado dados quando a segunda
    // inferência é interrompida. Esse fato precede o erro do Runner.
    if(vinculoTurno.atual){
      registrar('RESPOSTA');
      return explicarResultadoVinculo(vinculoTurno.atual);
    }
    if (trabalhoTurno.atual?.estado.ok) {
      const fonte=trabalhoTurno.atual.agenda==='tribemd'?'TribeMD':'Amplimed';
      registrar('RESPOSTA');
      return 'A leitura da '+fonte+' foi registrada. Vou continuar a conferência fora desta conversa e volto com os dados verificados.';
    }
    const natureza=abort.signal.aborted?'ABORT_SIGNAL':
      erro instanceof Error && erro.name==='MaxTurnsExceededError'?'MAX_TURNS':'FALHA_RUNNER';
    deps.aoDiagnostico?.({codigo:'FALLBACK_MODELO',ferramentas:[...ferramentas],uso:semUso(),
      duracaoMs:Math.max(0,Date.now()-inicio),falha:{natureza}});
    // Sem texto, senha, nome, número, argumentos nem stack em observabilidade.
    console.warn('NOTO_AGENT_EXECUCAO',JSON.stringify({codigo:natureza,duracaoMs:Math.max(0,Date.now()-inicio),
      ferramentas:ferramentas.map(f=>({nome:f.nome,codigo:f.codigo,duracaoMs:f.duracaoMs}))}));
    return natureza==='ABORT_SIGNAL'
      ? 'A resposta demorou mais que o limite desta conversa. Vou manter o estado verificado; não vou dizer que a consulta falhou sem conferir o trabalho registrado.'
      : 'Não consegui continuar esta etapa da conversa agora. Vou preservar o que já foi confirmado para retomarmos sem recomeçar.';
  } finally {
    clearTimeout(relogio);
  }
}
