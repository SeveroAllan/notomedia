import type pg from 'pg';

/** Rejeita um usuário do banco com qualquer privilégio de alteração
 * ou leitura fora do mínimo necessário ao piloto. A sessão também deve
 * operar em modo read-only no PostgreSQL. Não altera roles nem schemas. */
export async function validarBancoPilotoSomenteLeitura(pool: Pick<pg.Pool, 'query'>): Promise<void> {
  const sessao = await pool.query(`
    select current_setting('transaction_read_only') as somente_leitura,
           r.rolsuper as superusuario,
           r.rolbypassrls as ignora_rls,
           r.rolcreaterole as cria_roles,
           r.rolcreatedb as cria_bancos,
           r.rolreplication as replica
    from pg_roles r where r.rolname = current_user
  `);
  const s = sessao.rows[0];
  if (sessao.rows.length !== 1 || s.somente_leitura !== 'on' ||
    s.superusuario || s.ignora_rls || s.cria_roles || s.cria_bancos || s.replica) {
    throw new Error('PILOTO_BANCO_NAO_SOMENTE_LEITURA');
  }
  const privilegios = await pool.query(`
    select n.nspname as esquema, c.relname as objeto
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm', 'f')
      and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
      and (
        has_table_privilege(current_user, c.oid, 'INSERT')
        or has_table_privilege(current_user, c.oid, 'UPDATE')
        or has_table_privilege(current_user, c.oid, 'DELETE')
        or has_table_privilege(current_user, c.oid, 'TRUNCATE')
        or (
          has_table_privilege(current_user, c.oid, 'SELECT')
          and not (n.nspname = 'public' and c.relname in
            ('usuarios', 'medicos', 'noto_medico_agenda_referencias'))
        )
      )
    limit 1
  `);
  if (privilegios.rows.length) throw new Error('PILOTO_PERMISSOES_EXCESSIVAS');
  const obrigatorias = await pool.query(`
    select
      to_regclass('public.usuarios') is not null as existe_usuarios,
      to_regclass('public.medicos') is not null as existe_medicos,
      has_table_privilege(current_user, 'public.usuarios', 'SELECT') as le_usuarios,
      has_table_privilege(current_user, 'public.medicos', 'SELECT') as le_medicos
  `);
  const p = obrigatorias.rows[0];
  if (!p?.existe_usuarios || !p?.existe_medicos || !p?.le_usuarios || !p?.le_medicos) {
    throw new Error('PILOTO_CADASTRO_NAO_ACESSIVEL');
  }
}
