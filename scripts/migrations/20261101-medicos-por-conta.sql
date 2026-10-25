begin;

-- Uma conta pode administrar médicos que não possuem login próprio.
-- Médicos já vinculados a usuarios permanecem inalterados; a unicidade existente
-- de usuario_id continua valendo para valores não nulos.
alter table public.medicos
  alter column usuario_id drop not null;

do $medicos_conta$
begin
  if exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid=a.attrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='medicos'
      and a.attname='usuario_id' and not a.attisdropped and a.attnotnull
  ) then
    raise exception 'public.medicos.usuario_id continua obrigatório';
  end if;

  if not exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid=a.attrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='medicos'
      and a.attname='conta_id' and not a.attisdropped and a.attnotnull
  ) then
    raise exception 'public.medicos.conta_id precisa continuar obrigatório';
  end if;

  if not (
    has_table_privilege(current_user,'public.medicos','SELECT')
    and has_table_privilege(current_user,'public.medicos','INSERT')
    and has_table_privilege(current_user,'public.medicos','UPDATE')
  ) then
    raise exception 'Role do backend % perdeu acesso a public.medicos', current_user;
  end if;
end
$medicos_conta$;

commit;
