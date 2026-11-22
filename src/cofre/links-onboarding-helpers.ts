/**
 * Utilitários e contratos compartilhados pelos links efêmeros de onboarding no
 * cofre (`cofre_links`): hash SHA-256 do token, validação de formato e verificação
 * do telefone autorizado na conta. Isolado para evitar duplicação entre os módulos
 * de agenda/profissionais e de certificado/XML.
 */

import { createHash } from 'node:crypto';
import type pg from 'pg';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';

export const TIPO_LINK_PROFISSIONAIS = 'cadastro_profissionais';
export const TIPO_LINK_CERTIFICADO = 'certificado_a1';
export const TIPO_LINK_XML = 'xml_referencia';

export interface MedicoCadastradoLink {
  id: string;
  nomeCompleto: string;
  crm: string;
  rqe: string | null;
}

export interface ResultadoProcessamentoCertificado {
  ok: boolean;
  detalheErro?: string;
  fiscalImportado?: boolean;
  resumoFiscal?: string;
}

export interface ResultadoProcessamentoXml {
  ok: boolean;
  detalheErro?: string;
  resumoFiscal?: string;
}

export function hashTokenCofre(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function formatoTokenCofreValido(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export async function operadorAutorizadoNaConta(
  pool: Pick<pg.Pool, 'query'>,
  contaId: string,
  telefone: string
): Promise<boolean> {
  const variantes = gerarVariantesTelefoneBrasileiro(telefone);
  if (!variantes.length) return false;
  const { rows } = await pool.query(
    `select telefone from public.usuarios
     where conta_id = $1 and ativo = true and auth_user_id is not null`,
    [contaId]
  );
  return rows.some(u =>
    gerarVariantesTelefoneBrasileiro(String(u.telefone ?? '')).some(v => variantes.includes(v))
  );
}
