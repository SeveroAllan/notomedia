import type { ConsultaAdaptador } from './leitura-adaptativa.js';

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Legenda de status da agenda do Amplimed (conta de teste). "Atendido" = FINALIZADO é inferência
 * ainda não confirmada com a clínica: sem confirmação o leitor segue em modo observação.
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
