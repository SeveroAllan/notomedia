/**
 * Regras puras do motor de proatividade do Noto:
 * 1) Mapeamento matinal dos horários da agenda e verificação automática 10 min
 *    após cada consulta para checar se foi marcada como finalizada;
 * 2) Reagendamento gentil caso o médico atrase;
 * 3) Follow-up proativo de casos aguardando CPF do paciente há mais de 24h;
 * 4) Redação natural em PT-BR (sem cara de relatório) para avisos espontâneos.
 */

import { chaveAtendimentoSemNota } from '../emissao/cruzar-comprovante-agenda.js';
import { formatarValorReais } from '../emissao/extrair-cpf-mensagem.js';
import type { CasoEmissaoRegistro } from '../emissao/caso-emissao-repositorio.js';

export const HORA_INICIO_MAPEAMENTO_MANHA_SP = 7;
export const HORA_LIMITE_MAPEAMENTO_SP = 21;
export const ATRASO_POS_CONSULTA_MIN = 10;
export const REENTATIVAS_ATRASO_MIN = [20, 45] as const;
export const JANELA_AGRUPAMENTO_SLOTS_MS = 5 * 60_000;
export const HORAS_FOLLOWUP_CPF_PACIENTE = 24;

export interface HorarioConsultaAgenda {
  atendimentoId?: string | null;
  paciente: string;
  /** Data/hora ISO com offset ou YYYY-MM-DDTHH:mm:ss no fuso SP. */
  inicioIso: string;
  /** Fim estimado ISO; se ausente, assume início + 30 min. */
  fimIso?: string | null;
  finalizado: boolean;
}

export interface SlotConsultaMonitorado {
  chave: string;
  atendimentoId: string | null;
  paciente: string;
  diaIso: string;
  fimMs: number;
  proximaVerificacaoMs: number;
  tentativas: number;
  concluido: boolean;
}

export interface ResumoItemProativo {
  paciente: string;
  valorCentavos: number | null;
  acao: 'enfileirada' | 'aguardar_aprovacao_medico' | 'solicitar_cpf_paciente' | 'solicitar_cpf_medico' | 'esclarecer_com_medico' | 'aguardar_prontidao_fiscal';
  ambiente?: 'homologacao' | 'producao';
  valorSugeridoFormatado?: string;
}

export function obterRelogioSp(agora: Date = new Date()): { diaIso: string; hora: number; minuto: number } {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(agora);
  const ler = (t: string) => partes.find(p => p.type === t)?.value ?? '00';
  return {
    diaIso: `${ler('year')}-${ler('month')}-${ler('day')}`,
    hora: Number(ler('hour')) % 24,
    minuto: Number(ler('minute'))
  };
}

export function parsearDataHoraSpMs(iso: string): number | null {
  const limpo = iso.trim().replace(' ', 'T');
  if (!limpo) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(limpo)) {
    const ms = Date.parse(`${limpo}T18:00:00-03:00`);
    return Number.isFinite(ms) ? ms : null;
  }
  const comFuso = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(limpo) ? limpo : `${limpo}-03:00`;
  const ms = Date.parse(comFuso);
  return Number.isFinite(ms) ? ms : null;
}

export function planejarHorariosDoDia(entrada: {
  horariosHoje: readonly HorarioConsultaAgenda[];
  chavesJaEmitidas: ReadonlySet<string>;
  diaIso: string;
  agoraMs: number;
}): SlotConsultaMonitorado[] {
  const slots: SlotConsultaMonitorado[] = [];
  const chavesVistas = new Set<string>();

  for (const h of entrada.horariosHoje) {
    const nome = h.paciente.trim();
    if (!nome) continue;
    const inicioMs = parsearDataHoraSpMs(h.inicioIso);
    if (!inicioMs) continue;
    const fimMs = (h.fimIso ? parsearDataHoraSpMs(h.fimIso) : null) ?? (inicioMs + 30 * 60_000);
    const chaveNomeDia = chaveAtendimentoSemNota(nome, entrada.diaIso);
    const chave = h.atendimentoId ? String(h.atendimentoId) : chaveNomeDia;

    if (chavesVistas.has(chave) || entrada.chavesJaEmitidas.has(chave) || entrada.chavesJaEmitidas.has(chaveNomeDia)) {
      continue;
    }
    chavesVistas.add(chave);

    const alvoVerificacao = h.finalizado
      ? entrada.agoraMs
      : fimMs + ATRASO_POS_CONSULTA_MIN * 60_000;

    slots.push({
      chave,
      atendimentoId: h.atendimentoId ? String(h.atendimentoId) : null,
      paciente: nome,
      diaIso: entrada.diaIso,
      fimMs,
      proximaVerificacaoMs: alvoVerificacao,
      tentativas: 0,
      concluido: false
    });
  }

  return slots.sort((a, b) => a.proximaVerificacaoMs - b.proximaVerificacaoMs);
}

/**
 * Seleciona os slots já vencidos (10 min pós-atendimento) e agrupa slots
 * irmãos que venceriam nos próximos 5 min para fazer uma única leitura.
 */
export function selecionarSlotsParaVerificarAgora(
  slots: readonly SlotConsultaMonitorado[],
  agoraMs: number
): SlotConsultaMonitorado[] {
  const vencidos = slots.filter(s => !s.concluido && s.proximaVerificacaoMs <= agoraMs);
  if (!vencidos.length) return [];
  const janela = agoraMs + JANELA_AGRUPAMENTO_SLOTS_MS;
  return slots.filter(s => !s.concluido && s.proximaVerificacaoMs <= janela);
}

export function reagendarSlotNaoFinalizado(
  slot: SlotConsultaMonitorado,
  agoraMs: number
): SlotConsultaMonitorado {
  const atrasoMin = REENTATIVAS_ATRASO_MIN[slot.tentativas];
  if (atrasoMin === undefined) {
    return { ...slot, concluido: true };
  }
  return {
    ...slot,
    tentativas: slot.tentativas + 1,
    proximaVerificacaoMs: agoraMs + atrasoMin * 60_000
  };
}

export function identificarCasosCpfTravados(entrada: {
  casos: readonly CasoEmissaoRegistro[];
  agoraMs: number;
  jaAvisados: ReadonlySet<string>;
  horasLimite?: number;
}): CasoEmissaoRegistro[] {
  const limiteMs = (entrada.horasLimite ?? HORAS_FOLLOWUP_CPF_PACIENTE) * 3_600_000;
  return entrada.casos.filter(c => {
    if (c.estado !== 'aguardando_cpf_paciente') return false;
    if (entrada.jaAvisados.has(c.id)) return false;
    const atualizado = Date.parse(c.atualizadoEm);
    return Number.isFinite(atualizado) && entrada.agoraMs - atualizado >= limiteMs;
  });
}

export function formatarAvisoProativoConsultas(itens: readonly ResumoItemProativo[]): string | null {
  if (!itens.length) return null;

  if (itens.length === 1) {
    const it = itens[0]!;
    const valor = it.valorCentavos ? ` (${formatarValorReais(it.valorCentavos)})` : '';
    if (it.acao === 'enfileirada') {
      const modo = it.ambiente === 'homologacao' ? ' de teste' : '';
      return `Vi que a consulta de ${it.paciente}${valor} acabou agora e já coloquei a nota na fila${modo}. Assim que sair o PDF eu te mando.`;
    }
    if (it.acao === 'aguardar_aprovacao_medico') {
      return `Vi que a consulta de ${it.paciente}${valor} acabou agora e já deixei a nota pronta aqui. Posso emitir?`;
    }
    if (it.acao === 'solicitar_cpf_paciente') {
      return `Vi que a consulta de ${it.paciente}${valor} finalizou. Como estava sem CPF na agenda, já pedi direto no WhatsApp do paciente e assim que responder eu sigo com a nota.`;
    }
    if (it.acao === 'solicitar_cpf_medico') {
      return `Vi que a consulta de ${it.paciente}${valor} finalizou, mas não achei o CPF na agenda nem no histórico. Pode me mandar o CPF aqui para eu seguir com a nota?`;
    }
    if (it.acao === 'esclarecer_com_medico' && it.valorSugeridoFormatado) {
      return `Vi que a consulta de ${it.paciente} finalizou, mas ficou sem valor na agenda. Foi ${it.valorSugeridoFormatado} como na última consulta ou outro valor?`;
    }
    if (it.acao === 'esclarecer_com_medico') {
      return `Vi que a consulta de ${it.paciente} finalizou, mas ficou sem valor na agenda. Qual valor eu coloco na nota?`;
    }
    return `Vi que a consulta de ${it.paciente}${valor} finalizou e deixei a nota preparada aqui esperando só finalizar o Certificado A1/fiscal.`;
  }

  const enfileiradas = itens.filter(i => i.acao === 'enfileirada');
  const aprovacao = itens.filter(i => i.acao === 'aguardar_aprovacao_medico');
  const pendentes = itens.filter(i => i.acao !== 'enfileirada' && i.acao !== 'aguardar_aprovacao_medico');
  const partes: string[] = [];

  if (enfileiradas.length) {
    const nomes = enfileiradas.map(i => i.paciente).join(', ');
    partes.push(`Vi que finalizaram na agenda e já coloquei na fila de emissão: ${nomes}`);
  }
  if (aprovacao.length) {
    const nomes = aprovacao.map(i => `${i.paciente}${i.valorCentavos ? ` (${formatarValorReais(i.valorCentavos)})` : ''}`).join(', ');
    partes.push(`Deixei prontas esperando seu OK: ${nomes}`);
  }
  if (pendentes.length) {
    const nomes = pendentes.map(i => i.paciente).join(', ');
    partes.push(`Ficaram pendentes de algum dado (CPF ou valor): ${nomes}`);
  }
  return `${partes.join('. ')}.`;
}

export function formatarFollowupCpfTravado(caso: CasoEmissaoRegistro): string {
  const nome = caso.pacienteNome || 'o paciente';
  const valor = caso.valorCentavos ? ` (${formatarValorReais(caso.valorCentavos)})` : '';
  return `Oi! Pedi o CPF de ${nome}${valor} ontem para emitir a nota, mas ainda não tive retorno. Quer me passar o CPF por aqui ou prefere que eu dê mais um toque?`;
}
