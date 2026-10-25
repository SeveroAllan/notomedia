begin;

-- Uma conta pode administrar médicos que não possuem login próprio.
-- Médicos já vinculados a usuarios permanecem inalterados; a unicidade existente
-- de usuario_id continua valendo para valores não nulos.
alter table public.medicos
  alter column usuario_id drop not null;

alter table public.medicos
  drop constraint if exists medicos_usuario_id_fkey;

alter table public.medicos
  add constraint medicos_usuario_id_fkey
  foreign key (usuario_id) references public.usuarios(id) on delete set null;

-- RLS também segue a conta: papel do usuário não limita quais médicos da
-- própria conta ele pode operar.
create or replace function public.medicos_visiveis_para(p_auth_user_id uuid)
returns setof uuid
language sql stable security definer
set search_path = public
as $func$
  select m.id
  from public.usuarios u
  join public.medicos m on m.conta_id=u.conta_id
  where u.auth_user_id=p_auth_user_id and u.ativo=true
$func$;

revoke execute on function public.medicos_visiveis_para(uuid) from public, anon;
grant execute on function public.medicos_visiveis_para(uuid) to authenticated, service_role;

create table if not exists public.noto_medico_agenda_referencias (
  medico_id uuid not null references public.medicos(id) on delete cascade,
  agenda text not null check (agenda in ('tribemd','amplimed')),
  referencia_medico_id uuid not null references public.medicos(id) on delete cascade,
  atualizado_em timestamptz not null default now(),
  primary key (medico_id,agenda)
);

alter table public.noto_medico_agenda_referencias enable row level security;
revoke all on table public.noto_medico_agenda_referencias from anon, authenticated;

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

  if not exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid=con.conrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='medicos'
      and con.conname='medicos_usuario_id_fkey'
      and con.contype='f' and con.confdeltype='n'
  ) then
    raise exception 'FK medicos.usuario_id precisa usar ON DELETE SET NULL';
  end if;

  if pg_get_functiondef('public.medicos_visiveis_para(uuid)'::regprocedure)
      !~ 'join public\\.medicos m on m\\.conta_id=u\\.conta_id' then
    raise exception 'medicos_visiveis_para não está escopada pela conta';
  end if;

  if has_function_privilege('anon','public.medicos_visiveis_para(uuid)','EXECUTE') then
    raise exception 'anon não pode executar medicos_visiveis_para';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='noto_medico_agenda_referencias'
      and c.relkind='r' and c.relrowsecurity
  ) then
    raise exception 'RLS não habilitada em public.noto_medico_agenda_referencias';
  end if;

  if has_table_privilege('anon','public.noto_medico_agenda_referencias','SELECT')
    or has_table_privilege('anon','public.noto_medico_agenda_referencias','INSERT')
    or has_table_privilege('anon','public.noto_medico_agenda_referencias','UPDATE')
    or has_table_privilege('anon','public.noto_medico_agenda_referencias','DELETE')
    or has_table_privilege('authenticated','public.noto_medico_agenda_referencias','SELECT')
    or has_table_privilege('authenticated','public.noto_medico_agenda_referencias','INSERT')
    or has_table_privilege('authenticated','public.noto_medico_agenda_referencias','UPDATE')
    or has_table_privilege('authenticated','public.noto_medico_agenda_referencias','DELETE')
  then
    raise exception 'Acesso de cliente residual em public.noto_medico_agenda_referencias';
  end if;

  if not (
    has_table_privilege(current_user,'public.noto_medico_agenda_referencias','SELECT')
    and has_table_privilege(current_user,'public.noto_medico_agenda_referencias','INSERT')
    and has_table_privilege(current_user,'public.noto_medico_agenda_referencias','UPDATE')
  ) then
    raise exception 'Role do backend % perdeu acesso às referências de agenda', current_user;
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
