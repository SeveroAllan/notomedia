-- Proposta idempotente, NÃO aplicada. Não guarda telefone, texto ou documento.
begin;
create table if not exists public.noto_envios_homologacao (
  id uuid primary key default gen_random_uuid(),
  medico_id uuid not null references public.medicos(id) on delete cascade,
  acao text not null,
  chave text not null check (chave ~ '^[a-f0-9]{64}$'),
  estado text not null check (estado in ('reservado', 'enviado', 'erro')),
  criado_em timestamptz not null default now(),
  unique (medico_id, acao, chave)
);
alter table public.noto_envios_homologacao enable row level security;
revoke all on table public.noto_envios_homologacao from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.noto_envios_homologacao from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.noto_envios_homologacao from authenticated'; end if;
end $$;
commit;
