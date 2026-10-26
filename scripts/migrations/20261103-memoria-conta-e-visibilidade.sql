begin;

-- Memória durável precisa distinguir preferência pessoal do médico de preferência
-- operacional da conta. Linhas antigas permanecem no escopo do médico.
alter table public.conversa_memorias_semanticas
  add column if not exists escopo text,
  add column if not exists conta_id uuid references public.contas(id) on delete cascade;

update public.conversa_memorias_semanticas memoria
set escopo=coalesce(memoria.escopo,'medico'),
    conta_id=coalesce(memoria.conta_id,medico.conta_id)
from public.medicos medico
where medico.id=memoria.medico_id
  and (memoria.escopo is null or memoria.conta_id is null);

alter table public.conversa_memorias_semanticas
  alter column escopo set default 'medico',
  alter column escopo set not null,
  alter column conta_id set not null;

alter table public.conversa_memorias_semanticas
  drop constraint if exists conversa_memorias_semanticas_escopo_check;
alter table public.conversa_memorias_semanticas
  add constraint conversa_memorias_semanticas_escopo_check
  check (escopo in ('medico','conta'));

-- A unicidade antiga impedia uma memória da conta de ser compartilhada entre
-- médicos. Substituímos por chaves parciais de cada escopo.
alter table public.conversa_memorias_semanticas
  drop constraint if exists conversa_memorias_semanticas_medico_id_chave_key;

create unique index if not exists uq_conversa_memoria_medico_chave
  on public.conversa_memorias_semanticas (medico_id,chave)
  where escopo='medico';

create unique index if not exists uq_conversa_memoria_conta_chave
  on public.conversa_memorias_semanticas (conta_id,chave)
  where escopo='conta';

create index if not exists idx_conversa_memorias_semanticas_conta_ativas
  on public.conversa_memorias_semanticas (conta_id,atualizado_em desc)
  where ativa=true and escopo='conta';

-- O escopo padrão é toda a conta. Delegações explícitas antigas continuam
-- aditivas, inclusive contador/secretária ligados a médico de outra conta.
-- O parâmetro nunca pode ser usado para consultar como outro usuário:
-- a identidade informada precisa ser exatamente auth.uid().
create or replace function public.medicos_visiveis_para(p_auth_user_id uuid)
returns setof uuid
language sql stable security definer
set search_path = pg_catalog
as $func$
  with identidade as (
    select u.id,u.conta_id
    from public.usuarios u
    where u.auth_user_id=p_auth_user_id
      and u.ativo=true
      and p_auth_user_id=auth.uid()
  )
  select m.id
  from identidade i
  join public.medicos m on m.conta_id=i.conta_id
  union
  select sm.medico_id
  from identidade i
  join public.secretarias s on s.usuario_id=i.id
  join public.secretaria_medico sm on sm.secretaria_id=s.id
  union
  select cm.medico_id
  from identidade i
  join public.contadores c on c.usuario_id=i.id
  join public.contador_medico cm on cm.contador_id=c.id
$func$;

revoke execute on function public.medicos_visiveis_para(uuid) from public, anon;
grant execute on function public.medicos_visiveis_para(uuid) to authenticated, service_role;

do $validar_memoria_acesso$
declare
  corpo_visibilidade text;
begin
  corpo_visibilidade := lower(translate(
    pg_get_functiondef('public.medicos_visiveis_para(uuid)'::regprocedure),
    E' \n\r\t',''
  ));
  if exists (
    select 1 from public.conversa_memorias_semanticas
    where escopo is null or conta_id is null
  ) then
    raise exception 'memória semântica ficou sem escopo/conta';
  end if;

  if pg_get_functiondef('public.medicos_visiveis_para(uuid)'::regprocedure)
       !~ 'p_auth_user_id ?= ?auth\.uid\(\)' then
    raise exception 'medicos_visiveis_para aceita identidade arbitrária';
  end if;

  if pg_get_functiondef('public.medicos_visiveis_para(uuid)'::regprocedure)
       !~ 'public\.contador_medico'
     or pg_get_functiondef('public.medicos_visiveis_para(uuid)'::regprocedure)
       !~ 'public\.secretaria_medico' then
    raise exception 'delegações explícitas deixaram de ser preservadas';
  end if;

  if has_function_privilege('anon','public.medicos_visiveis_para(uuid)','EXECUTE') then
    raise exception 'anon não pode executar medicos_visiveis_para';
  end if;

  if not (
    has_table_privilege(current_user,'public.conversa_memorias_semanticas','SELECT')
    and has_table_privilege(current_user,'public.conversa_memorias_semanticas','INSERT')
    and has_table_privilege(current_user,'public.conversa_memorias_semanticas','UPDATE')
  ) then
    raise exception 'Role do backend % perdeu acesso à memória semântica', current_user;
  end if;
end
$validar_memoria_acesso$;

commit;
