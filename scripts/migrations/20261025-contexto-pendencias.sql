-- Preparada para aplicação manual. Somente estado da conversa e controle da sync, sem dados de paciente.
begin;
create table if not exists public.noto_contexto_pendencias (
  medico_id uuid primary key references public.medicos(id) on delete cascade,
  data_inicio date,
  aguardando_data boolean not null default false,
  ultimo_aviso text,
  chave_sync text,
  sync_estado text check (sync_estado in ('executando','concluida','erro')),
  atualizado_em timestamptz not null default now()
);
alter table public.noto_contexto_pendencias enable row level security;
revoke all on table public.noto_contexto_pendencias from anon, authenticated;
commit;
