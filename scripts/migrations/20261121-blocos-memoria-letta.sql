-- Proposta de migração local (não aplicar automaticamente em banco remoto).
-- Cria blocos persistentes de memória núcleo por conta (arquitetura Letta:
-- Core Memory Blocks + Sleep-Time Compute) para eliminar repetições e manter
-- o perfil do médico, estado vivo do consultório e combinados sempre em dia.

begin;

create table if not exists public.noto_memoria_blocos (
  conta_id uuid not null references public.contas(id) on delete cascade,
  rotulo text not null check (rotulo in ('perfil_medico', 'estado_vivo_consultorio', 'pendencias_e_combinados')),
  conteudo text not null default '' check (char_length(conteudo) <= 1600),
  versao integer not null default 1 check (versao >= 1),
  atualizado_por text not null check (atualizado_por in ('agente', 'sistema', 'sleep_time')),
  atualizado_em timestamptz not null default now(),
  primary key (conta_id, rotulo)
);

create index if not exists idx_noto_memoria_blocos_conta_atualizado
  on public.noto_memoria_blocos (conta_id, atualizado_em desc);

alter table public.noto_memoria_blocos enable row level security;

revoke all on table public.noto_memoria_blocos from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.noto_memoria_blocos from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.noto_memoria_blocos from authenticated';
  end if;
end $$;

commit;
