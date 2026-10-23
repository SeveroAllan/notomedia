/**
 * Retomada de emissão após recusa definitiva comprovada da SEFIN (proposta; inativa por padrão).
 * Nada aqui libera repetição por status genérico: só a combinação de
 * (a) rejeição estruturada do provedor com código E#### e (b) reconciliação HEAD /dps/{id}
 * confirmando que nenhuma NFS-e foi gerada para aquela DPS marca a tentativa como recusa
 * definitiva. Qualquer outro resultado (timeout, 5xx, rede, auth, "gerada", indeterminado)
 * mantém a tentativa travada.
 */

export interface EmissaoExistenteParaRetomada {
  estado: string;
  recusaDefinitiva: boolean;
  notaFiscalId: string | null;
}

/** Decide o destino de uma consulta que já possui emissão registrada. */
export function classificarRetomadaEmissao(e: EmissaoExistenteParaRetomada): 'reabrir' | 'repetida' | 'ja_faturada' {
  if (e.estado === 'nota_gerada' || e.notaFiscalId) return 'ja_faturada';
  if (e.estado === 'erro' && e.recusaDefinitiva) return 'reabrir';
  return 'repetida';
}

export type ResultadoConsultaDps = 'gerada' | 'nao_gerada' | 'indeterminado';

/**
 * Semântica do HEAD /dps/{id} (Manual dos Contribuintes - Sistema Nacional NFS-e, v1.2 out/2025,
 * seção 1.4.2: informa se uma NFS-e foi gerada ou não a partir do identificador da DPS).
 * ATENÇÃO: os códigos HTTP exatos de "gerada"/"não gerada" PRECISAM ser confirmados
 * empiricamente no ambiente de produção restrita antes de ativar a retomada; o swagger oficial
 * (https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional/docs/index) é inacessível da
 * nossa infra. Qualquer status fora destas listas é "indeterminado" e mantém a trava.
 */
export const STATUS_DPS_GERADA: readonly number[] = [200];
export const STATUS_DPS_NAO_GERADA: readonly number[] = [404];

export function classificarStatusConsultaDps(status: number): ResultadoConsultaDps {
  if (STATUS_DPS_GERADA.includes(status)) return 'gerada';
  if (STATUS_DPS_NAO_GERADA.includes(status)) return 'nao_gerada';
  return 'indeterminado';
}

export const CODIGO_REGRA_NEGOCIO = /^E\d{4}$/;

/**
 * Só a resposta estruturada do provedor (lista erros[]/mensagens[] cujo primeiro código E####
 * casa com o código retornado, em HTTP 4xx exceto transitórios) é candidata a recusa definitiva.
 * Falhas de rede, timeout, 5xx, 408/429 e corpos não estruturados nunca são recusa definitiva.
 */
export function ehRejeicaoRegraNegocio(r: { httpStatus?: number; codigoErro?: string; respostaRaw?: Record<string, unknown> }): boolean {
  // Apenas os status documentados de rejeição de negócio; auth (401/403), transitórios
  // (408/429), 5xx e qualquer outro código são indeterminados e mantêm a trava.
  if (r.httpStatus !== 400 && r.httpStatus !== 422) return false;
  if (!r.codigoErro || !CODIGO_REGRA_NEGOCIO.test(r.codigoErro)) return false;
  const raw = r.respostaRaw as Record<string, unknown> | undefined;
  const erros = (raw?.['erros'] ?? raw?.['mensagens'] ?? raw?.['Erros'] ?? raw?.['Mensagens']) as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(erros) || erros.length === 0) return false;
  const primeiro = erros[0];
  return (primeiro?.['codigo'] ?? primeiro?.['Codigo']) === r.codigoErro;
}
