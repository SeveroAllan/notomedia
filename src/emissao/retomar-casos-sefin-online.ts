/**
 * Monitoramento proativo em segundo plano de casos parados com erro de gateway/rede
 * da SEFIN (`HTTP 403` HTML do IIS, timeout ou indisponibilidade).
 * Sonda silenciosamente o endpoint da SEFIN e, assim que o bloqueio/queda cessa,
 * reenfileira automaticamente as notas para emitir e chamar o médico no WhatsApp.
 */

import https from 'node:https';
import type pg from 'pg';

export function sondarGatewaySefinDisponivel(urlStr = 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse'): Promise<boolean> {
  return new Promise(resolve => {
    const url = new URL(urlStr);
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'HEAD',
        agent: false,
        rejectUnauthorized: false,
        timeout: 8000
      },
      res => {
        const status = res.statusCode ?? 0;
        const ct = String(res.headers['content-type'] ?? '').toLowerCase();
        res.resume();
        // Enquanto o frontal IIS devolver 403 HTML ou 5xx, o gateway segue bloqueado.
        const bloqueadoIis = (status === 403 && ct.includes('text/html')) || status >= 500 || status === 0;
        resolve(!bloqueadoIis);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

export async function reenfileirarCasosErroSefinSeOnline(
  pool: Pick<pg.Pool, 'query'>,
  sondar: () => Promise<boolean> = () => sondarGatewaySefinDisponivel()
): Promise<number> {
  const { rows: pendentes } = await pool.query(
    `select c.id as caso_id, c.solicitacao_id
       from public.noto_casos_emissao c
      where c.estado = 'erro'
        and c.solicitacao_id is not null
        and (
          coalesce(c.erro_motivo, '') ilike '%SEFIN%'
          or coalesce(c.erro_motivo, '') ilike '%HTTP 403%'
          or coalesce(c.erro_motivo, '') ilike '%Timeout%'
        )
      limit 25`
  );
  if (!pendentes.length) return 0;

  const disponivel = await sondar();
  if (!disponivel) return 0;

  const casoIds = pendentes.map(r => String(r.caso_id));
  const solIds = pendentes.map(r => String(r.solicitacao_id));

  await pool.query(
    `update public.solicitacoes_nota
        set status = 'pronta',
            fila = 'pronta',
            erro = null,
            tentativas = 0,
            proxima_tentativa_em = null,
            bloqueada_por_worker = null,
            bloqueada_em = null,
            atualizado_em = now()
      where id = any($1::uuid[]) and status <> 'emitida'`,
    [solIds]
  );
  await pool.query(
    `update public.noto_casos_emissao
        set estado = 'enfileirada',
            erro_motivo = null,
            atualizado_em = now()
      where id = any($1::uuid[])`,
    [casoIds]
  );
  return casoIds.length;
}
