import { Agent, OpenAIProvider, Runner, tool, type Model } from '@openai/agents';
import { z } from 'zod';
import { normalizarNomeMedico } from '../conta/medicos-conta.js';
import { contemCredencialAgenda } from '../cofre/links.js';
import { semUso, type CodigoFerramenta, type DiagnosticoAgente, type EventoFerramenta, type FerramentaNoto } from './diagnostico.js';
import { INSTRUCOES_NOTO } from './instrucoes.js';

export interface ProfissionalAgente { id: string; nome: string }
export interface EstadoFonte { salvo: boolean; conectada: boolean; indisponivel?: boolean }
export interface StatusFontes { tribemd: EstadoFonte; amplimed: EstadoFonte }

export interface EntradaAgente {
  texto: string;
  profissionais: ProfissionalAgente[];
  semConta?: boolean;
  painelUrl?: string;
  contexto?: readonly string[];
}
export interface DependenciasAgente {
  consultarStatus: (medicoId: string) => Promise<StatusFontes>;
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
        etapasPossiveis: ['identificar conta', 'identificar profissional', 'escolher agenda', 'conectar no Cofre seguro'],
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
      if (!mencionado && !confirmouUltimaPergunta) {
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
          proximaEtapa: (estado.salvo ? 'Conferir/reconectar acesso salvo' : 'Conectar agenda') + ' na seção Cofre ' + painel + '. Inserir credenciais somente na página segura. Não pedir senha pelo WhatsApp.' };
      } catch {
        log('STATUS_INDISPONIVEL');
        return { pronto: false, profissional: p.nome, agendaEscolhida: plataforma, codigo: 'STATUS_INDISPONIVEL',
          proximaEtapa: 'A consulta interna falhou. Não presumir conexão ou desconexão nem pedir ao usuário para investigar a falha técnica; ofereça uma nova tentativa mais tarde.' };
      }
    }
  });

  return new Agent({
    name: 'Noto Assistente',
    model: deps.modeloTeste ?? deps.modeloNome ?? 'gpt-4o-mini',
    instructions: INSTRUCOES_NOTO,
    tools: [consultarConta, consultarAgendas, orientarConexao]
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
    /\b(?:nao sei se|nao posso (?:confirmar|afirmar) se|nao consegui verificar se|nao tenho como confirmar se|nao tenho evidencia de que)\s*$/.test(prefixo);
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
        contextoAnterior: (entrada.contexto ?? []).slice(-3).map(s => s.slice(0, 500))
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
