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

commit;
