import { Router } from 'express';
import type pg from 'pg';
import { criarGuardaMedicoDaConta, medicoAutorizado } from '../http/autorizar-medico-sessao.js';
import type { ResultadoStatusWhatsapp } from '../onboarding/io/consultar-status-instancia-whatsapp.js';

/** Consulta do painel: sessão + vínculo de conta validados sem side effects. */
export function criarRouterStatusWhatsapp(deps: {
  pool: pg.Pool;
  autenticar: (token: string) => Promise<string | null>;
  consultar: (medicoId: string) => Promise<ResultadoStatusWhatsapp>;
}) {
  const router = Router();
  router.get('/status', criarGuardaMedicoDaConta(deps), async (_req, res) => {
    try {
      const { medicoId } = medicoAutorizado(res);
      const resultado = await deps.consultar(medicoId);
      res.status(resultado.ok ? 200 : 502).json({
        ok: resultado.ok, conectado: resultado.conectado, status: resultado.status
      });
    } catch {
      res.status(502).json({ ok: false, detalhe: 'Não foi possível verificar a conexão do WhatsApp.' });
    }
  });
  return router;
}
