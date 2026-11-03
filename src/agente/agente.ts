import { Agent, OpenAIProvider, Runner, tool, type Model } from '@openai/agents';
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
  aoConferencia?: (resultado: ResultadoConferencia) => void;
  aoPanorama?: (foco: string | null, resultado: ResultadoPanoramaFiscal) => void;
  /** Referência técnica existente do Cofre da conta autenticada, NÃO representa um médico escolhido. */
  referenciaContaAgenda?: () => Promise<string | null>;
  descobrirProfissionais?: (medicoId: string, agenda: AgendaEscolhida) => Promise<{ ok: boolean; nomes?: string[]; motivo?: string }>;
  confirmarProfissionais?: (medicoBaseId: string, nomes: string[]) => Promise<{ ok: boolean; nomes?: string[]; motivo?: string }>;
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

/** Cria ferramentas somente de leitura para a conta resolvida no webhook.
 * O modelo não recebe identificadores internos nem consegue escolhê-los. */
export function criarAgenteNoto(entrada: EntradaAgente, deps: DependenciasAgente) {
  const profissionais = entrada.profissionais.filter(p => p.id && nomeProfissionalValido(p.nome)).slice(0, 21);
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
  if (deps.confirmarProfissionais && deps.descobrirProfissionais) extras.push(tool({
    name:'confirmar_profissionais_descobertos',
    description:'Após nomes vistos na agenda real e confirmação explícita, vincula à conta. profissionalBase=null usa referência técnica da conta. Nunca herda fiscal ou certificado.',
    parameters:z.object({
      agenda:z.enum(['tribemd','amplimed']),
      profissionalBase:z.string().nullable(),
      nomes:z.array(z.string().trim().min(2).max(150)).min(1).max(10)
    }),
    async execute({agenda,profissionalBase,nomes}) {
      const inicio=Date.now();
      // A primeira vinculação exige descoberta verificada em turno anterior
      // nesta mesma conta/conversa, seguida de confirmação explícita.
      if (profissionalBase === null && (
        entrada.estadoConversa?.descoberta?.agenda !== agenda ||
        !nomes.every(nome => entrada.estadoConversa!.descoberta!.nomes.some(
          visto => normalizarNomeMedico(visto) === normalizarNomeMedico(nome))))) {
        registrar('confirmar_profissionais_descobertos','DEPENDENCIA_CONFIRMACAO',inicio);
        return {ok:false,motivo:'DESCOBERTA_PREVIA_NECESSARIA'};
      }
      const base=profissionalBase === null ? null : identificar(profissionalBase,profissionais);
      const baseId=base ? base.encontrados.length===1 ? base.encontrados[0]!.id : null
        : await ancoraDaConta().catch(()=>null);
      if(!baseId) {
        registrar('confirmar_profissionais_descobertos','PROFISSIONAL_NAO_ENCONTRADO',inicio);
        return {ok:false,motivo:'CONTA_NAO_IDENTIFICADA'};
      }
      try {
        const estado=(await deps.consultarStatus(baseId))[agenda];
        if(estado.indisponivel || !estado.conectada) {
          registrar('confirmar_profissionais_descobertos',estado.indisponivel?'STATUS_INDISPONIVEL':'CONEXAO_PENDENTE',inicio);
          return {ok:false,motivo:estado.indisponivel?'CONSULTA_INDISPONIVEL':'AGENDA_SEM_CONEXAO'};
        }
        const atual=await deps.descobrirProfissionais!(baseId,agenda);
        if(!atual.ok || !atual.nomes?.length) {
          registrar('confirmar_profissionais_descobertos','STATUS_INDISPONIVEL',inicio);
          return {ok:false,motivo:'IDENTIDADES_NAO_VERIFICADAS'};
        }
        const comprovados=nomes.map(n=>atual.nomes!.filter(c=>nomeProfissionalValido(c) && normalizarNomeMedico(c)===normalizarNomeMedico(n)));
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
        const negouCadastro = /\b(?:nao|nunca|jamais)\b[^,;.!?\n]{0,70}\b(?:confirmo|confirmar|adicione|adicionar|cadastre|cadastrar|vincule|vincular)\b/.test(dito);
        const confirmouNomes = nomes.every(n=>dito.includes(normalizarNomeMedico(n)));
        if(negouCadastro || (!umaDescobertaConfirmada && !(intencaoExplicita && confirmouNomes))) {
          registrar('confirmar_profissionais_descobertos','DEPENDENCIA_PROFISSIONAL',inicio);
          return {ok:false,motivo:'CONFIRMACAO_EXPLICITA_NECESSARIA'};
        }
        const resultado=await deps.confirmarProfissionais!(baseId,comprovados.map(c=>c[0]!));
        registrar('confirmar_profissionais_descobertos',resultado.ok?'PROFISSIONAIS_CONFIRMADOS':'PROFISSIONAL_AMBIGUO',inicio);
        if (resultado.ok) deps.aoComprovante?.({ tipo: 'vincular_profissionais', profissionalId: baseId, agenda });
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
      const negouAlteracao=/\b(?:nao|nunca|jamais)\b[^,;.!?\n]{0,70}\b(?:confirmo|atualize|atualizar|registre|registrar|salve|salvar)\b/i.test(
        texto.normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      );
      const especiais=new Set(['.','*','+','?','^','$','{','}','(',')','|','[',']','\\']);
      const escape=(valor:string) => [...valor].map(ch=>especiais.has(ch)?'\\'+ch:ch).join('');
      const informado=(rotulo:string,valor:string) =>
        new RegExp('\\b'+rotulo+'\\b\\s*(?:(?:n(?:umero|º|o)?)\\s*)?(?::|=|e|eh)?\\s*'+escape(valor)+'(?=$|[\\s,;.!?])','i').test(texto);
      const campos=[
        ...(nomeCompleto?[{rotulo:'(?:nome completo|me chamo)',valor:nomeCompleto}]:[]),
        ...(crm?[{rotulo:'crm',valor:crm}]:[]),
        ...(rqe?[{rotulo:'rqe',valor:rqe}]:[])
      ];
      if(!autorizou || negouAlteracao || !campos.length || !campos.every(c=>informado(c.rotulo,c.valor))) {
        registrar('confirmar_dados_profissionais','DEPENDENCIA_CONFIRMACAO',inicio);
        return {ok:false,motivo:'VALORES_E_CONFIRMACAO_EXPLICITOS_NECESSARIOS'};
      }
      try{
        const r=await deps.salvarDadosProfissionais!(medico.id,{
          ...(nomeCompleto?{nome:nomeCompleto}:{}),
          ...(crm?{crm}:{}),...(rqe?{rqe}:{})
        });
        registrar('confirmar_dados_profissionais',r.ok?'DADOS_PROFISSIONAIS_SALVOS':'FERRAMENTA_INDISPONIVEL',inicio);
        if (r.ok) deps.aoComprovante?.({ tipo: 'salvar_dados_profissionais', profissionalId: medico.id });
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
  const trabalhoTurno: { atual?: { tipo:TipoTrabalhoNoto; agenda:AgendaEscolhida; estado:ResultadoEnfileirar } } = {};
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
      registrarFerramenta: e => ferramentas.push(e)
    });
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
        // IDs de mensagens e referências de tarefas ficam no orquestrador,
        // nunca no contexto enviado ao modelo externo.
        estadoConversacionalVerificado: Object.fromEntries(
          Object.entries(entrada.estadoConversa ?? {}).filter(([campo]) => campo !== 'tarefasPendentes')
        ),
        situacaoUltimoLink: entrada.situacaoUltimoLink??null,
        trabalhosEmAndamento: (entrada.trabalhos??[]).slice(0,4)
      }) }
    ], { maxTurns: 6, signal: abort.signal });
    const resposta = typeof resultado.finalOutput === 'string' ? resultado.finalOutput.trim() : '';
    const u = resultado.state.usage;
    const uso = {
      requisicoes: u.requests, tokensEntrada: u.inputTokens, tokensSaida: u.outputTokens, tokensTotal: u.totalTokens
    };
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
