import type { RequestHandler } from 'express';
import type pg from 'pg';

export interface MedicoAutorizado {
  medicoId: string;
  usuarioId: string;
  medicoUsuarioId: string | null;
}

/**
 * O Bearer do OTP é uma sessão Supabase Auth, não um ID médico.
 * Autorização é SEMPRE feita pelo vínculo entre a conta ativa do usuário
 * autenticado e o médico solicitado. Não chama resolverMedicoId:
 * essa função legada pode inserir um médico para usuarioId inexistente.
 */
export function criarGuardaMedicoDaConta(deps: {
  pool: Pick<pg.Pool, 'query'>;
  autenticar: (token: string) => Promise<string | null>;
}): RequestHandler {
  return async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const cabecalho = req.header('Authorization') ?? '';
    const match = /^Bearer ([^\s]+)$/i.exec(cabecalho.trim());
    if (!match) { res.status(401).json({ ok: false, detalhe: 'Autenticação necessária' }); return; }
    let authUserId: string | null;
    try { authUserId = await deps.autenticar(match[1]!); }
    catch { res.status(503).json({ ok: false, detalhe: 'Não foi possível validar a sessão.' }); return; }
    if (!authUserId) { res.status(401).json({ ok: false, detalhe: 'Sessão inválida' }); return; }

    const body = req.body as Record<string, unknown> | undefined;
    // Consultas GET usam query, POSTs usam body. Nunca criar/corrigir cadastro
    // para determinar o alvo; a vinculação precisa existir ANTES da operação.
    const alvo = req.method === 'GET'
      ? req.query['medicoId']
      : (body?.['medicoId'] ?? body?.['usuarioId']);
    if (typeof alvo !== 'string' || !alvo.trim() || alvo.length > 150) {
      res.status(400).json({ ok: false, detalhe: 'medicoId é obrigatório' }); return;
    }
    try {
      const { rows } = await deps.pool.query(`
        select m.id as medico_id, m.usuario_id as medico_usuario_id, u.id as usuario_id
        from usuarios u
        join medicos m on m.conta_id = u.conta_id
        where u.auth_user_id = $1 and u.ativo = true and u.conta_id is not null
          and (m.id = $2 or (m.usuario_id = u.id and u.id = $2))
        limit 2
      `, [authUserId, alvo]);
      if (rows.length !== 1) {
        res.status(403).json({ ok: false, detalhe: 'Cadastro não autorizado' }); return;
      }
      const medico = rows[0] as { medico_id: string; medico_usuario_id: string | null; usuario_id: string };
      // usuarioId adicional nunca escolhe o usuário que será alterado.
      if (body?.['usuarioId'] !== undefined && body['usuarioId'] !== medico.usuario_id) {
        res.status(403).json({ ok: false, detalhe: 'Cadastro não autorizado' }); return;
      }
      res.locals['medicoAutorizado'] = {
        medicoId: medico.medico_id, usuarioId: medico.usuario_id,
        medicoUsuarioId: medico.medico_usuario_id
      } satisfies MedicoAutorizado;
      next();
    } catch {
      res.status(503).json({ ok: false, detalhe: 'Não foi possível verificar o acesso à conta.' });
    }
  };
}

export function medicoAutorizado(res: { locals: Record<string, unknown> }): MedicoAutorizado {
  const atual = res.locals['medicoAutorizado'] as MedicoAutorizado | undefined;
  if (!atual) throw new Error('GUARDA_SESSAO_AUSENTE');
  return atual;
}
