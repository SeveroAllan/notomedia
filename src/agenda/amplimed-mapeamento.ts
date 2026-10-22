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

/** Legenda de cores da agenda (conta teste, 22/10): hex exato -> nome do status. */
const CORES_STATUS_AMPLIMED: Record<string, string> = {
  '6c757d': 'agendado', '1fbed9': 'confirmado', 'e3a62c': 'esperando', 'd75353': 'cancelado', 'f76397': 'nao compareceu',
  '840000': 'reagendado', '343a40': 'em atendimento', '008000': 'finalizado', '800080': 'bloqueado'
};
const NOMES_CSS: Record<string, string> = { green: '008000', purple: '800080', maroon: '800000' };

/** Normaliza o que o navegador devolve (#rrggbb, rgb(r, g, b) ou nome CSS) para 6 dígitos hex, ou null. */
export function corParaHex(cor: string | null | undefined): string | null {
  const c = (cor ?? '').trim().toLowerCase();
  if (NOMES_CSS[c]) return NOMES_CSS[c]!;
  const h = /^#([0-9a-f]{6})$/.exec(c); if (h) return h[1]!;
  const r = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(c);
  if (r) return [r[1], r[2], r[3]].map(n => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('');
  return null;
}

/** Status pela cor do compromisso. Cor fora da legenda, e BLOQUEADO, são desconhecidos: nunca presumir atendimento. */
export function statusAmplimedPorCor(cor: string | null | undefined): ConsultaAdaptador['status'] | 'desconhecido' {
  const hex = corParaHex(cor);
  const nome = hex ? CORES_STATUS_AMPLIMED[hex] : undefined;
  return nome ? statusAmplimed(nome) : 'desconhecido';
}
