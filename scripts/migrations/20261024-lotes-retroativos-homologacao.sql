-- Aplicação manual. Não executar pelo aplicativo. Somente controle de simulações.
begin;
create table if not exists public.noto_lotes_emissao (
  id uuid primary key default gen_random_uuid(),
  medico_id uuid not null references public.medicos(id) on delete cascade,
  conversa text not null,
  chave_evento text not null,
  desde date,
  ate timestamptz not null,
  total_consultas integer not null default 0 check (total_consultas >= 0),
  total_centavos bigint not null default 0 check (total_centavos >= 0),
  sem_valor integer not null default 0 check (sem_valor >= 0),
  estado text not null check (estado in ('aguardando_data_inicio','aguardando_confirmacao_lote','confirmado','processando','simulado','recusado','bloqueado')),
  mensagem_confirmacao_id text,
  pergunta_em timestamptz,
  resposta_confirmacao_id text,
  confirmado_em timestamptz,
  criado_em timestamptz not null default now(),
  unique (medico_id, chave_evento), unique (id, medico_id), unique (medico_id, resposta_confirmacao_id)
);
create unique index if not exists noto_lote_ativo_medico on public.noto_lotes_emissao(medico_id)
  where estado in ('aguardando_data_inicio','aguardando_confirmacao_lote','confirmado','processando');
create table if not exists public.noto_lotes_itens (
  id uuid primary key default gen_random_uuid(),
  lote_id uuid not null,
  medico_id uuid not null,
  fonte text not null check (fonte='tribemd'),
  id_externo text not null,
  consulta_chave text not null,
  assinatura text,
  estado text not null check (estado in ('pronto','processando','simulada','sem_valor','ja_faturada','repetida','dados_divergentes','erro')),
  foreign key (lote_id, medico_id) references public.noto_lotes_emissao(id, medico_id) on delete cascade,
  unique (lote_id, fonte, id_externo)
);
-- Uma consulta simulada/reservada não é executada de novo por outro lote.
create unique index if not exists noto_lote_consulta_unica on public.noto_lotes_itens(medico_id, consulta_chave)
  where estado in ('processando','simulada');
alter table public.noto_lotes_emissao enable row level security;
alter table public.noto_lotes_itens enable row level security;
revoke all on table public.noto_lotes_emissao, public.noto_lotes_itens from anon, authenticated;
commit;
