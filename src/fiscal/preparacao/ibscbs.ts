/**
 * Subconjunto declarativo da DPS nacional 1.01: operação regular e destinatário
 * igual ao tomador. Valores calculados da NFS-e não são parâmetros da próxima DPS.
 */
import { z } from 'zod';

export const ibscbsSchema = z.object({
  finNFSe: z.literal('0').optional(), // legado v1.00: ignorado na emissão (finNFSe agora vai em infDPS)
  indFinal: z.enum(['0', '1']).optional(),
  cIndOp: z.string().regex(/^\d{6}$/),
  indDest: z.literal('0'),
  CST: z.string().regex(/^\d{3}$/),
  cClassTrib: z.string().regex(/^\d{6}$/)
}).strict();
export type ParametrosIbscbs = z.infer<typeof ibscbsSchema>;

export function gerarGrupoIbscbs(entrada: ParametrosIbscbs): string {
  const p = ibscbsSchema.parse(entrada);
  return `<IBSCBS>`
    + (p.indFinal !== undefined ? `<indFinal>${p.indFinal}</indFinal>` : '')
    + `<cIndOp>${p.cIndOp}</cIndOp><indDest>${p.indDest}</indDest>`
    + `<valores><trib><CST>${p.CST}</CST><cClassTrib>${p.cClassTrib}</cClassTrib>`
    + '</trib></valores></IBSCBS>';
}
