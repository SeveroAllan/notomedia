import { extrairTelefoneJid } from '../whatsapp/extrair-telefone-jid.js';
import { normalizarResultadoAgenda, selecionarConsultaComprovante, type FonteAgenda, type ResultadoFonteAgenda } from '../agenda/fonte-agenda.js';
import type { DadosMensagemEvolution } from '../whatsapp/payload-webhook-schema.js';
import type { ExtratorComprovante, EstadoPedidoComprovante, ResultadoExtracaoComprovante,
  DecisaoPedidoComprovante } from '../atendimento/comprovante.js';
import { validarCpf } from '../paciente/validar-cpf.js';
import type { HistoricoComunicacaoRepositorio } from '../onboarding/historico-comunicacao-repositorio.js';
import type { ProcessarWebhookDeps } from './processar-mensagem-webhook.js';

interface ProcessarComprovanteDeps {
  agenda?: ResultadoFonteAgenda;
  fonteAgenda?: FonteAgenda;
  consultaJaFaturada?: (fonte: string, idExterno: string) => Promise<boolean>;
  medicoEmFaseInicial?: (medicoId: string) => Promise<boolean>;
  extrator: ExtratorComprovante;
  historico: Pick<HistoricoComunicacaoRepositorio, 'registrarComprovante'>;
  log: (nivel: 'erro', codigo: string) => void;
  aoComunicar?: (decisao: DecisaoPedidoComprovante, lido: ResultadoExtracaoComprovante | null) => Promise<void>;
  aoDecidir?: (decisao: DecisaoPedidoComprovante, lido: ResultadoExtracaoComprovante | null, estado: EstadoPedidoComprovante) => Promise<void>;
}

interface OrquestrarComprovanteDeps extends Omit<ProcessarComprovanteDeps, 'log'> {
  lerEstado: (medicoId: string, pacienteId: string) => Promise<EstadoPedidoComprovante>;
  log: (nivel: 'info' | 'erro', mensagem: string) => void;
  // CPF ausente na agenda e na conversa: o Noto pergunta ao médico a quem recorrer (permissão solicitar_cpf).
  aoCpfAusente?: (medicoId: string) => Promise<void>;
}

export async function orquestrarComprovante(
  contexto: Parameters<NonNullable<ProcessarWebhookDeps['aoReceberComprovante']>>[0],
  deps: OrquestrarComprovanteDeps
): Promise<DecisaoPedidoComprovante> {
  const estado = await deps.lerEstado(contexto.medicoId, contexto.pacienteId);
  const decisao = await processarComprovante(contexto.mensagem, estado, deps);
  if (decisao.tipo === 'perguntar_medico' && decisao.motivo === 'CADASTRO_INCOMPLETO' && deps.aoCpfAusente &&
      (!estado.paciente.cpf || !validarCpf(estado.paciente.cpf))) {
    try { await deps.aoCpfAusente(estado.medicoId); }
    catch { deps.log('erro', 'OFERTA_CPF_FALHOU'); }
  }
  if (decisao.tipo === 'pedido_nota_pronto' && !deps.aoDecidir) deps.log('info', `pediria nota ${decisao.tipo}`);
  if (!deps.aoComunicar && (decisao.tipo === 'perguntar_medico' || decisao.tipo === 'perguntar_pacote' || decisao.tipo === 'pedir_agenda')) deps.log('info', `enviaria ${decisao.tipo}`);
  return decisao;
}

export async function processarComprovante(
  mensagem: DadosMensagemEvolution, estado: EstadoPedidoComprovante, deps: ProcessarComprovanteDeps
): Promise<DecisaoPedidoComprovante> {
  let lido: ResultadoExtracaoComprovante | null = null;
  if (deps.agenda?.tipo !== 'erro') {
    try { lido = await deps.extrator.extrair(mensagem); }
    catch { /* A indisponibilidade é auditada sem inventar campos ou expor o erro do provedor. */ }
  }
  if (lido?.tipo === 'nota_pdf' && deps.medicoEmFaseInicial) {
    try { estado = { ...estado, notaFaseInicial: await deps.medicoEmFaseInicial(estado.medicoId) }; }
    catch { /* Sem a fase confirmada, a nota segue como dúvida ao médico. */ }
  }
  const consultado = await consultarEstadoAgenda(mensagem, estado, deps, lido);
  estado = consultado.estado;
  const agenda = consultado.agenda;
  let decisao: DecisaoPedidoComprovante;
  try { decisao = await deps.historico.registrarComprovante(estado, lido, agenda); }
  catch {
    deps.log('erro', 'AUDITORIA_COMPROVANTE_FALHOU');
    return { tipo: 'nenhuma', motivo: 'AUDITORIA_FALHOU' };
  }
  if (deps.aoComunicar && ['perguntar_medico', 'perguntar_pacote', 'pedir_agenda'].includes(decisao.tipo)) {
    try { await deps.aoComunicar(decisao, lido); }
    catch { deps.log('erro', 'COMUNICACAO_COMPROVANTE_FALHOU'); }
  }
  if (deps.aoDecidir && (decisao.tipo === 'pedido_nota_pronto' ||
      decisao.tipo === 'nenhuma' && decisao.motivo === 'COMPROVANTE_JA_PROCESSADO')) {
    try { await deps.aoDecidir(decisao, lido, estado); }
    catch { deps.log('erro', 'ENFILEIRAMENTO_COMPROVANTE_FALHOU'); }
  }
  return decisao;
}

async function consultarEstadoAgenda(mensagem: DadosMensagemEvolution, estado: EstadoPedidoComprovante, deps: ProcessarComprovanteDeps, lido: ResultadoExtracaoComprovante | null) {
  if (!deps.fonteAgenda) return { estado, agenda: deps.agenda };
  const semConsulta = { ...estado, ultimaConsulta: null, consulta: undefined };
  try {
    const agenda = normalizarResultadoAgenda(await deps.fonteAgenda.consultar({ medicoId: estado.medicoId, referenciaCofre: estado.medicoId }));
    if (agenda.tipo === 'erro') return { estado: semConsulta, agenda };
    const faturadas = new Set<string>();
    await Promise.all(agenda.consultas.map(async consulta => {
      if (await deps.consultaJaFaturada?.(agenda.fonte, consulta.idExterno)) faturadas.add(consulta.idExterno);
    }));
    const telefone = extrairTelefoneJid(mensagem.key.remoteJidAlt) || extrairTelefoneJid(mensagem.key.remoteJid) || '';
    // O seletor verifica telefone compartilhado antes de excluir consultas faturadas.
    const selecionada = selecionarConsultaComprovante(agenda.consultas, telefone, faturadas,
      lido?.tipo === 'extraido' ? lido.campos.dataPagamento : undefined);
    if (selecionada.tipo === 'perguntar_medico') return { estado: { ...semConsulta, duvidaVinculo: selecionada.motivo,
      ...(selecionada.motivo === 'MULTIPLAS_CONSULTAS_SEM_NOTA' ? { duvidaConsultas: selecionada.consultas } : {}) }, agenda };
    const c = selecionada.consulta;
    return { agenda, estado: { ...semConsulta, ultimaConsulta: { valorConsultaCentavos: c.valorConsultaCentavos ?? null },
      consulta: { idExterno: c.idExterno, dataHora: c.dataHora, fonte: agenda.fonte, valorConsultaCentavos: c.valorConsultaCentavos ?? null } } };
  } catch { return { estado: semConsulta, agenda: { tipo: 'erro' as const, codigo: 'FONTE_INDISPONIVEL' as const } }; }
}
