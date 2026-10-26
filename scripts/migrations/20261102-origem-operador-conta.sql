begin;

-- Compatibilidade de rolling deploy: instalações que já executaram a migration
-- de conversa contínua podem ainda ter o CHECK antigo ('medico','secretaria').
alter table public.conversa_mensagens
  add column if not exists origem_operador text;

do $origem_conta$
declare
  restricao record;
begin
  for restricao in
    select con.conname
    from pg_constraint con
    join pg_class c on c.oid=con.conrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public'
      and c.relname='conversa_mensagens'
      and con.contype='c'
      and pg_get_constraintdef(con.oid) ilike '%origem_operador%'
  loop
    execute format('alter table public.conversa_mensagens drop constraint %I', restricao.conname);
  end loop;
end
$origem_conta$;

alter table public.conversa_mensagens
  add constraint conversa_mensagens_origem_operador_check
  check (origem_operador is null or origem_operador in ('medico','secretaria','conta'));

do $validar_origem_conta$
begin
  if not exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid=con.conrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public'
      and c.relname='conversa_mensagens'
      and con.conname='conversa_mensagens_origem_operador_check'
      and con.contype='c'
      and pg_get_constraintdef(con.oid) like '%''conta''%'
  ) then
    raise exception 'origem_operador ainda não aceita conta';
  end if;
end
$validar_origem_conta$;

commit;
