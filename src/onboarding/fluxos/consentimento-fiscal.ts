import type pg from 'pg';
import { confirmarParametrosFiscais } from './confirmar-parametros-fiscais.js';

export const versaoConsentimentoFiscal = 'continuar-a1-v1';
export const textoConsentimentoFiscal = 'Ao clicar no botão "Continuar" você concorda com os termos de consentimento fiscal.';

export async function registrarConsentimentoFiscal(pool: Pick<pg.Pool, 'query'>, medicoId: string, certificadoId: string) {
  await pool.query(`insert into auditoria (acao, entidade, entidade_id, dados_novos)
    values ('consentimento_parametros_fiscais', 'medicos', $1, $2)`, [medicoId, JSON.stringify({
    versao: versaoConsentimentoFiscal, texto: textoConsentimentoFiscal, paginaTermos: null,
    origem: 'continuar_certificado', certificadoId, aceitoEm: new Date().toISOString()
  })]);
}

/** Consentimento permite tentar a adoção; todas as validações fiscais continuam determinísticas. */
export async function adotarReferenciaConsentida(deps: {
  pool: pg.Pool; preparacaoFiscalAtiva: boolean;
  contaPilotoHomologacao?:string;
  confirmar?: typeof confirmarParametrosFiscais;
  registrar?: (evento: Record<string, unknown>) => void;
}, medicoId: string, referenciaHash: unknown): Promise<{ ok: boolean; codigo?: string; detalhe?: string }> {
  if (typeof referenciaHash !== 'string' || !/^[a-f0-9]{64}$/.test(referenciaHash)) return { ok: false, codigo: 'REFERENCIA_INVALIDA' };
  if (!deps.preparacaoFiscalAtiva) return { ok: false, codigo: 'PREPARACAO_FISCAL_INATIVA' };
  const consentimento = await deps.pool.query(`select true as permitido from auditoria a
    join medico_certificados c on c.id::text = a.dados_novos->>'certificadoId'
    where a.acao = 'consentimento_parametros_fiscais' and a.entidade = 'medicos'
      and a.entidade_id = $1 and c.medico_id = $1 and c.status = 'ativo'
      and a.dados_novos->>'versao' = $2 limit 1`, [medicoId, versaoConsentimentoFiscal]);
  if (!consentimento.rows.length) return { ok: false, codigo: 'CONSENTIMENTO_NAO_REGISTRADO' };
  try {
    await (deps.confirmar ?? confirmarParametrosFiscais)(deps.pool, { medicoId, referenciaHash, usarReferencia: true },
      ...(deps.contaPilotoHomologacao?[deps.contaPilotoHomologacao] as const:[]));
    return { ok: true };
  } catch (erro: any) {
    const codigo = erro?.codigo || 'ADOTAR_REFERENCIA_FALHOU';
    (deps.registrar ?? (e => console.warn('[Fiscal] Adoção com consentimento pendente:', e)))({ medicoId, codigo, diagnostico: erro?.diagnostico });
    return { ok: false, codigo, detalhe: erro?.message || 'A configuração fiscal permanece pendente para análise.' };
  }
}
