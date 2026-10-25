begin;

-- O transcript original continua em conversa_mensagens. Estas tabelas adicionam
-- memória derivada e trabalho do agente sem transformar resumos em fonte de verdade.

alter table if exists public.conversa_mensagens
  add column if not exists origem_operador text
  check (origem_operador is null or origem_operador in ('medico','secretaria'));

-- Linhas antigas de entrada vieram do médico direto. Saídas do Noto ficam null.
update public.conversa_mensagens
set origem_operador='medico'
where papel='medico' and origem_operador is null;

create table if not exists public.conversa_chunks (
  id bigserial primary key,
  medico_id uuid not null references public.medicos(id) on delete cascade,
  conversa text not null,
  nivel smallint not null default 0 check (nivel between 0 and 8),
  inicio_mensagem_id bigint not null,
  fim_mensagem_id bigint not null,
  resumo text not null,
  pai_id bigint references public.conversa_chunks(id) on delete set null,
  criado_em timestamptz not null default now(),
  check (fim_mensagem_id >= inicio_mensagem_id),
  unique (medico_id, conversa, nivel, inicio_mensagem_id, fim_mensagem_id)
);

create index if not exists idx_conversa_chunks_raiz
  on public.conversa_chunks (medico_id, conversa, inicio_mensagem_id)
  where pai_id is null;

create table if not exists public.conversa_memorias_semanticas (
  id bigserial primary key,
  medico_id uuid not null references public.medicos(id) on delete cascade,
  chave text not null,
  categoria text not null check (categoria in ('preferencia_agenda','preferencia_comunicacao','rotina','decisao','outro')),
  valor text not null,
  origem_conversa text not null,
  origem_mensagem_id bigint not null,
  confianca numeric(4,3) not null check (confianca >= 0 and confianca <= 1),
  ativa boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (medico_id, chave)
);

create index if not exists idx_conversa_memorias_semanticas_ativas
  on public.conversa_memorias_semanticas (medico_id, atualizado_em desc)
  where ativa = true;

create table if not exists public.conversa_trabalho_eventos (
  id bigserial primary key,
  medico_id uuid not null references public.medicos(id) on delete cascade,
  conversa text not null,
  chave_processamento text not null,
  ferramenta text not null,
  fase text not null check (fase in ('iniciada','concluida','recusada','falhou')),
  metadados jsonb not null default '{}',
  criado_em timestamptz not null default now(),
  unique (medico_id, conversa, chave_processamento, ferramenta, fase)
);

create index if not exists idx_conversa_trabalho_eventos
  on public.conversa_trabalho_eventos (medico_id, conversa, criado_em desc);

alter table public.conversa_chunks enable row level security;
alter table public.conversa_memorias_semanticas enable row level security;
alter table public.conversa_trabalho_eventos enable row level security;

-- O backend acessa pelo Postgres/service role. O painel existente não ganha uma
-- superfície nova por esta migração.
revoke all on table
  public.conversa_chunks,
  public.conversa_memorias_semanticas,
  public.conversa_trabalho_eventos
from anon, authenticated;

commit;
