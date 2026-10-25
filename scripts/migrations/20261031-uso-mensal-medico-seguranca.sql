begin;

-- uso_mensal_medico é estado interno do backend. O contador é atualizado pelo
-- trigger trg_notas_uso_mensal quando uma nota autorizada é persistida.
alter table public.uso_mensal_medico enable row level security;

revoke all on table public.uso_mensal_medico
from anon, authenticated;

-- Postcondições: a migration aborta antes do commit se a tabela continuar
-- exposta ao cliente ou se o caminho de escrita do backend deixar de funcionar.
do $seguranca_uso$
declare
  papel text;
begin
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public'
      and c.relname='uso_mensal_medico'
      and c.relkind='r'
      and c.relrowsecurity
  ) then
    raise exception 'RLS não habilitada em public.uso_mensal_medico';
  end if;

  foreach papel in array array['anon','authenticated'] loop
    if to_regrole(papel) is null then
      raise exception 'Role esperada do Supabase não existe: %', papel;
    end if;

    if has_table_privilege(papel, 'public.uso_mensal_medico', 'SELECT')
      or has_table_privilege(papel, 'public.uso_mensal_medico', 'INSERT')
      or has_table_privilege(papel, 'public.uso_mensal_medico', 'UPDATE')
      or has_table_privilege(papel, 'public.uso_mensal_medico', 'DELETE')
      or has_table_privilege(papel, 'public.uso_mensal_medico', 'TRUNCATE')
      or has_table_privilege(papel, 'public.uso_mensal_medico', 'REFERENCES')
      or has_table_privilege(papel, 'public.uso_mensal_medico', 'TRIGGER')
    then
      raise exception 'Privilégio residual de % em public.uso_mensal_medico', papel;
    end if;
  end loop;

  -- registrar_uso_mensal usa INSERT ... ON CONFLICT DO UPDATE e lê o contador
  -- atual. A mesma role da DATABASE_URL precisa manter esses privilégios.
  if not (
    has_table_privilege(current_user, 'public.uso_mensal_medico', 'SELECT')
    and has_table_privilege(current_user, 'public.uso_mensal_medico', 'INSERT')
    and has_table_privilege(current_user, 'public.uso_mensal_medico', 'UPDATE')
  ) then
    raise exception 'Role do backend % perdeu acesso ao contador mensal', current_user;
  end if;

  -- Sem FORCE RLS, owner/superuser/BYPASSRLS preserva o caminho interno do
  -- trigger mesmo sem policy para anon/authenticated.
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    join pg_roles atual on atual.rolname=current_user
    where n.nspname='public'
      and c.relname='uso_mensal_medico'
      and (c.relowner=atual.oid or atual.rolsuper or atual.rolbypassrls)
  ) then
    raise exception 'Role do backend % seria bloqueada pela RLS em public.uso_mensal_medico', current_user;
  end if;

  if to_regprocedure('public.registrar_uso_mensal()') is null then
    raise exception 'Função public.registrar_uso_mensal() não encontrada';
  end if;

  if not exists (
    select 1
    from pg_trigger t
    join pg_class tabela on tabela.oid=t.tgrelid
    join pg_namespace n on n.oid=tabela.relnamespace
    join pg_proc funcao on funcao.oid=t.tgfoid
    join pg_namespace fn on fn.oid=funcao.pronamespace
    where not t.tgisinternal
      and t.tgname='trg_notas_uso_mensal'
      and n.nspname='public'
      and tabela.relname='notas_fiscais'
      and fn.nspname='public'
      and funcao.proname='registrar_uso_mensal'
      and t.tgenabled <> 'D'
  ) then
    raise exception 'Trigger trg_notas_uso_mensal não está ativo em public.notas_fiscais';
  end if;
end
$seguranca_uso$;

commit;
