begin;

alter table if exists public.cofre_links
  add column if not exists destino_telefone text;

create table if not exists public.secretarias (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null unique references public.usuarios(id) on delete cascade,
  conta_id uuid not null references public.contas(id) on delete cascade,
  criado_em timestamptz not null default now()
);

create table if not exists public.secretaria_medico (
  secretaria_id uuid not null references public.secretarias(id) on delete cascade,
  medico_id uuid not null references public.medicos(id) on delete cascade,
  primary key (secretaria_id, medico_id)
);

create index if not exists idx_secretaria_medico_medico
  on public.secretaria_medico(medico_id);

create table if not exists public.noto_operador_foco (
  usuario_id uuid primary key references public.usuarios(id) on delete cascade,
  medico_id uuid not null references public.medicos(id) on delete cascade,
  atualizado_em timestamptz not null default now()
);

create index if not exists idx_noto_operador_foco_medico
  on public.noto_operador_foco(medico_id);

-- Estas tabelas pertencem ao backend do Noto. Não há acesso direto pelo cliente.
-- RLS fica ativa como defesa em profundidade e anon/authenticated não recebem
-- privilégios de tabela. O owner/service role usado pelo backend não é revogado.
alter table public.secretarias enable row level security;
alter table public.secretaria_medico enable row level security;
alter table public.noto_operador_foco enable row level security;

revoke all on table
  public.secretarias,
  public.secretaria_medico,
  public.noto_operador_foco
from anon, authenticated;

-- Postcondições: se o ambiente não terminar exatamente protegido, a migration
-- aborta antes do commit. Não há policies de cliente de propósito.
do $
declare
  tabela text;
  papel text;
begin
  foreach tabela in array array['secretarias','secretaria_medico','noto_operador_foco'] loop
    if not exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=tabela and c.relkind='r' and c.relrowsecurity
    ) then
      raise exception 'RLS não habilitada em public.%', tabela;
    end if;

    foreach papel in array array['anon','authenticated'] loop
      if to_regrole(papel) is null then
        raise exception 'Role esperada do Supabase não existe: %', papel;
      end if;
      if has_table_privilege(papel, format('public.%I', tabela), 'SELECT')
        or has_table_privilege(papel, format('public.%I', tabela), 'INSERT')
        or has_table_privilege(papel, format('public.%I', tabela), 'UPDATE')
        or has_table_privilege(papel, format('public.%I', tabela), 'DELETE')
        or has_table_privilege(papel, format('public.%I', tabela), 'TRUNCATE')
        or has_table_privilege(papel, format('public.%I', tabela), 'REFERENCES')
        or has_table_privilege(papel, format('public.%I', tabela), 'TRIGGER')
      then
        raise exception 'Privilégio residual de % em public.%', papel, tabela;
      end if;
    end loop;
  end loop;
end $;

commit;
