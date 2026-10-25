begin;

alter table if exists public.cofre_links
  add column if not exists destino_telefone text;

create table if not exists public.noto_operador_foco (
  usuario_id uuid primary key references public.usuarios(id) on delete cascade,
  medico_id uuid not null references public.medicos(id) on delete cascade,
  atualizado_em timestamptz not null default now()
);

create index if not exists idx_noto_operador_foco_medico
  on public.noto_operador_foco(medico_id);

commit;
