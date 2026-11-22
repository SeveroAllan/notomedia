/**
 * Regras puras para decidir quando compactar mensagens antigas (dias anteriores
 * ou excesso no mesmo dia), gerar resumo determinístico de contingência e
 * montar o recorte de curto e longo prazo entregue ao agente. Sem banco nem rede.
 */

import {
  GATILHO_COMPACTACAO_MESMO_DIA,
  LIMITE_MENSAGENS_CURTO_PRAZO,
  MANTER_EM_ABERTO_APOS_COMPACTACAO,
  MAX_CHARS_RESUMO_MEMORIA
} from './memoria-config.js';
import type { MensagemMemoria, ResumoMemoria } from './memoria-repositorio.js';

export interface LoteParaCompactar {
  mensagens: MensagemMemoria[];
  periodoInicio: string;
  periodoFim: string;
}

/**
 * Seleciona mensagens não compactadas elegíveis para virar resumo de longo prazo:
 * 1) Todas as mensagens de dias anteriores ao `diaAtual` (prioridade);
 * 2) Se o próprio `diaAtual` ultrapassar o gatilho, compacta apenas o bloco mais antigo.
 */
export function selecionarMensagensParaCompactar(
  pendentes: readonly MensagemMemoria[],
  diaAtual: string
): LoteParaCompactar | null {
  if (!pendentes.length) return null;

  const deDiasAnteriores = pendentes.filter(m => m.diaReferencia < diaAtual);
  if (deDiasAnteriores.length > 0) {
    return montarLote(deDiasAnteriores);
  }

  if (pendentes.length < GATILHO_COMPACTACAO_MESMO_DIA) return null;
  const quantidade = pendentes.length - MANTER_EM_ABERTO_APOS_COMPACTACAO;
  if (quantidade <= 0) return null;
  return montarLote(pendentes.slice(0, quantidade));
}

function montarLote(mensagens: MensagemMemoria[]): LoteParaCompactar {
  const ordenadas = [...mensagens].sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
  const primeira = ordenadas[0]!;
  const ultima = ordenadas[ordenadas.length - 1]!;
  return {
    mensagens: ordenadas,
    periodoInicio: primeira.diaReferencia,
    periodoFim: ultima.diaReferencia
  };
}

/** Resumo local determinístico usado caso o compactador LLM esteja offline ou sem chave. */
export function gerarResumoFallback(mensagens: readonly MensagemMemoria[]): {
  resumo: string;
  fatosCombinados: string[];
} {
  const linhas = mensagens.map(m => {
    const quem = m.autor === 'medico' ? 'Médico' : 'Noto';
    return `[${m.diaReferencia}] ${quem}: ${m.texto.slice(0, 140)}`;
  });
  const resumo = linhas.join(' | ').slice(0, MAX_CHARS_RESUMO_MEMORIA);
  const fatosCombinados = mensagens
    .filter(m => m.autor === 'medico')
    .slice(-5)
    .map(m => `${m.diaReferencia}: ${m.texto.slice(0, 140)}`);
  return { resumo, fatosCombinados };
}

/** Converte mensagens de curto prazo no formato de turnos reais esperado pelo agente. */
export function formatarTurnosCurtoPrazo(
  mensagens: readonly MensagemMemoria[]
): string[] {
  return mensagens
    .slice(-LIMITE_MENSAGENS_CURTO_PRAZO)
    .map(m => (m.autor === 'medico' ? `Médico: ${m.texto}` : `Noto: ${m.texto}`));
}

/** Formata os resumos compactados para o payload de longo prazo entregue ao modelo. */
export function formatarResumosLongoPrazo(
  resumos: readonly ResumoMemoria[]
): Array<{ periodo: string; resumo: string; fatosCombinados: string[] }> {
  return resumos.map(r => ({
    periodo: r.periodoInicio === r.periodoFim
      ? r.periodoInicio
      : `${r.periodoInicio} a ${r.periodoFim}`,
    resumo: r.resumo,
    fatosCombinados: r.fatosCombinados
  }));
}
