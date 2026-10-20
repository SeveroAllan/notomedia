-- Aplicar somente após o yes do Allan. Não executada automaticamente.
begin;
create table public.cofre_links (
    id uuid primary key default gen_random_uuid(),
    medico_id uuid not null references public.medicos(id) on delete cascade,
    agenda text not null,
    token_hash text not null unique,
    expira_em timestamptz not null,
    usado_em timestamptz,
    criado_em timestamptz not null default now()
);
create index cofre_links_medico_criado on public.cofre_links(medico_id, criado_em);
create table public.cofre_links_auditoria (
    link_id uuid not null references public.cofre_links(id) on delete cascade,
    evento text not null check (evento in ('criado', 'aberto', 'enviado', 'expirado')),
    criado_em timestamptz not null default now(),
    primary key (link_id, evento)
);
alter table public.cofre_links enable row level security;
alter table public.cofre_links_auditoria enable row level security;
revoke all on public.cofre_links, public.cofre_links_auditoria from public, anon, authenticated;
commit;
