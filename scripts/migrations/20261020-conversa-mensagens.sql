create table if not exists conversa_mensagens (
  id bigserial primary key,
  medico_id uuid not null references public.medicos(id) on delete cascade,
  conversa text not null,
  papel text not null check (papel in ('medico', 'noto')),
  mensagem_id text not null,
  texto text not null,
  criada_em timestamptz default now(),
  unique (medico_id, conversa, mensagem_id)
);
create index if not exists conversa_mensagens_contexto on conversa_mensagens (medico_id, conversa, id desc);

create table if not exists conversa_resumos (
  medico_id uuid not null references public.medicos(id) on delete cascade,
  conversa text not null,
  resumo text,
  ate_id bigint,
  atualizado_em timestamptz default now(),
  primary key (medico_id, conversa)
);

alter table public.conversa_mensagens enable row level security;
alter table public.conversa_resumos enable row level security;
revoke all on table public.conversa_mensagens, public.conversa_resumos from anon, authenticated;
