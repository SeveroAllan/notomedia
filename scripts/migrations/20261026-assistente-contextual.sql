begin;

-- Serviço novo, desativado até execução explícita. Não importa pedidos legados.
create table assistente_memorias (
  usuario_id uuid primary key references usuarios(id) on delete cascade,
  conta_id uuid not null references contas(id) on delete cascade,
  dados jsonb not null default '{"agenda":null,"periodo":null,"profissionais":[]}',
  atualizado_em timestamptz not null default now()
);
create table assistente_mensagens (
  id bigserial primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  conta_id uuid not null references contas(id) on delete cascade,
  chave text not null,
  papel text not null check (papel in ('cliente','noto','sistema')),
  texto text not null,
  criado_em timestamptz not null default now(),
  unique (usuario_id, chave)
);
create table assistente_trabalhos (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references usuarios(id) on delete cascade,
  conta_id uuid not null references contas(id) on delete cascade,
  medico_id uuid references medicos(id) on delete cascade,
  tipo text not null check (tipo in ('conversa','preparacao','envio')),
  chave text not null,
  conteudo jsonb not null default '{}',
  estado text not null default 'pendente' check (estado in ('pendente','executando','concluido','falhou','incerto')),
  token uuid,
  lease_ate timestamptz,
  resultado jsonb,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (usuario_id, tipo, chave)
);
create index assistente_mensagens_contexto on assistente_mensagens(usuario_id, conta_id, id desc);
create index assistente_trabalhos_fila on assistente_trabalhos(tipo, criado_em, id)
  where estado in ('pendente','executando');
create unique index assistente_conversa_em_execucao on assistente_trabalhos(usuario_id)
  where tipo='conversa' and estado='executando';

-- Somente backend; nenhuma política permite acesso direto pelo cliente Supabase.
alter table assistente_memorias enable row level security;
alter table assistente_mensagens enable row level security;
alter table assistente_trabalhos enable row level security;
revoke all on assistente_memorias, assistente_mensagens, assistente_trabalhos from public, anon, authenticated;
revoke all on sequence assistente_mensagens_id_seq from public, anon, authenticated;
commit;
