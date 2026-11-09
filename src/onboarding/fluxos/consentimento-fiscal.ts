import type pg from 'pg';
import { confirmarParametrosFiscais } from './confirmar-parametros-fiscais.js';

export const versaoConsentimentoFiscal = 'continuar-a1-v1';
export const textoConsentimentoFiscal = 'Ao clicar no botão "Continuar" você concorda com os termos de consentimento fiscal.';

export async function registrarConsentimentoFiscal(
  pool: Pick<pg.Pool, 'query'>, medicoId: string, certificadoId: string, usuarioId: string
) {
  await pool.query(`insert into public.auditoria (conta_id, usuario_id, evento, dados)
    select m.conta_id, $2, 'consentimento_parametros_fiscais', $3::jsonb
    from public.medicos m where m.id = $1 and not exists (
      select 1 from public.auditoria a where a.conta_id = m.conta_id
        and a.evento = 'consentimento_parametros_fiscais'
        and a.dados @> $4::jsonb
    )`, [medicoId, usuarioId, JSON.stringify({
    medicoId, versao: versaoConsentimentoFiscal, texto: textoConsentimentoFiscal, paginaTermos: null,
    origem: 'continuar_certificado', certificadoId, aceitoEm: new Date().toISOString()
  }), JSON.stringify({medicoId, certificadoId, versao: versaoConsentimentoFiscal})]);
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
  const consentimento = await deps.pool.query(`select true as permitido from public.auditoria a
    join public.medicos m on m.conta_id = a.conta_id
    join public.medico_certificados c on c.id::text = a.dados->>'certificadoId' and c.medico_id = m.id
    where a.evento = 'consentimento_parametros_fiscais'
      and m.id = $1 and a.dados->>'medicoId' = m.id::text and c.status = 'ativo'
      and (c.valido_de is null or c.valido_de <= current_date) and c.valido_ate >= current_date
      and a.dados->>'versao' = $2 limit 1`, [medicoId, versaoConsentimentoFiscal]);
  if (!consentimento.rows.length) return { ok: false, codigo: 'CONSENTIMENTO_NAO_REGISTRADO' };
  try {
    await (deps.confirmar ?? confirmarParametrosFiscais)(deps.pool, { medicoId, referenciaHash, usarReferencia: true },
      ...(deps.contaPilotoHomologacao?[deps.contaPilotoHomologacao] as const:[]));
    return { ok: true };
  } catch (erro: any) {
    const codigo = erro?.codigo || 'ADOTAR_REFERENCIA_FALHOU';
    (deps.registrar ?? (e => console.warn('[Fiscal] Adoção com consentimento pendente:', e)))({ medicoId, codigo, diagnostico: erro?.diagnostico, mensagem: erro?.message });
    return { ok: false, codigo, detalhe: 'A configuração fiscal permanece pendente para análise.' };
  }
}
