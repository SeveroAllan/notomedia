import type { ConsultaAdaptador } from './leitura-adaptativa.js';

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Legenda de status da agenda do Amplimed (conta de teste). "Atendido" = FINALIZADO, confirmado pelo Allan em 22/10 18:26.
 * Regra confirmada junto: Cortesia/R$0 e convênio não geram nota na v1. O leitor segue em modo observação.
 * Status de faturamento TISS é outra lista e não entra aqui.
 */
export function statusAmplimed(texto: string): ConsultaAdaptador['status'] | 'desconhecido' {
  switch (norm(texto)) {
    case 'finalizado': return 'realizada';
    case 'cancelado': case 'reagendado': return 'cancelada';
    case 'nao compareceu': return 'faltou';
    case 'agendado': case 'confirmado': case 'esperando': case 'em atendimento': return 'agendada';
    default: return 'desconhecido'; // inclui BLOQUEADO
  }
}

/** Particular e Cortesia são os únicos valores elegíveis ou tratados; qualquer outro convênio fica fora da v1. */
export function cobrancaAmplimed(convenio: string | null | undefined): ConsultaAdaptador['tipoCobranca'] {
  const c = norm(convenio ?? '');
  if (!c) return 'desconhecido';
  if (c === 'particular') return 'particular';
  if (c === 'cortesia') return 'cortesia';
  return 'convenio';
}

/**
 * Status pela cor do compromisso na agenda (fc-event, background-color). Só o que foi observado na conta teste:
 * as 3 consultas FINALIZADO aparecem em "green". Qualquer outra cor é desconhecida: nunca presumir atendimento.
 */
export function statusAmplimedPorCor(cor: string | null | undefined): ConsultaAdaptador['status'] | 'desconhecido' {
  return (cor ?? '').trim().toLowerCase() === 'green' ? 'realizada' : 'desconhecido';
}
