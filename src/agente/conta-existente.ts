import type pg from 'pg';
import type { UsuarioAutenticadoInfo } from '../auth/auth-admin-service.js';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';

/** Consulta somente usuários do login normal. Não corrige vínculo, não insere
 * médico e não cria conta no Supabase. A ausência/ambiguidade bloqueia o piloto. */
export async function localizarContaExistentePorTelefone(
  pool: Pick<pg.Pool, 'query'>, telefone: string
): Promise<UsuarioAutenticadoInfo | null> {
  const variantes = gerarVariantesTelefoneBrasileiro(telefone);
  if (!variantes.length) return null;
  const { rows } = await pool.query(`
    select u.id as usuario_id, u.auth_user_id, u.papel, u.nome,
           m.id as medico_id
    from usuarios u
    left join medicos m on m.usuario_id = u.id and m.conta_id = u.conta_id
    where u.ativo = true and u.auth_user_id is not null
      and u.conta_id is not null
      and regexp_replace(u.telefone, '[^0-9]', '', 'g') = any($1::text[])
    limit 3
  `, [variantes]);
  if (rows.length !== 1) return null;
  const u = rows[0];
  if (!u?.usuario_id || !u.auth_user_id ||
    !['medico', 'secretaria', 'contador', 'admin'].includes(u.papel)) return null;
  return {
    usuarioId: u.usuario_id,
    authUserId: u.auth_user_id,
    medicoId: u.medico_id ?? undefined,
    nome: u.nome ?? undefined,
    papel: u.papel,
    ehNovoUsuario: false
  };
}
