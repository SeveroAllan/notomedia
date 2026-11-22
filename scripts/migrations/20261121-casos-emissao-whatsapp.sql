-- Proposta de migração local (não aplicar automaticamente em banco remoto).
-- Cria persistência de casos conversacionais de emissão pelo WhatsApp (com
-- idempotência anti-duplicidade e CPF criptografado) e vínculos aprendidos de
-- pagadores secundários (ex.: familiar pagando Pix em nome de um paciente).

begin;

create table if not exists public.conta_pagadores_secundarios (
  id uuid primary key default gen_random_uuid(),
  conta_id uuid not null references public.contas(id) on delete cascade,
  pagador_nome text not null,
  pagador_nome_normalizado text not null,
  pagador_cpf_hash text,
  paciente_nome text not null,
  paciente_telefone text,
  emitir_no_cpf_de text not null default 'paciente'
    check (emitir_no_cpf_de in ('paciente', 'pagador')),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (conta_id, pagador_nome_normalizado)
);

create index if not exists idx_conta_pagadores_secundarios_conta
  on public.conta_pagadores_secundarios (conta_id, atualizado_em desc);

create index if not exists idx_conta_pagadores_secundarios_cpf
  on public.conta_pagadores_secundarios (conta_id, pagador_cpf_hash)
  where pagador_cpf_hash is not null;

create table if not exists public.noto_casos_emissao (
  id uuid primary key default gen_random_uuid(),
  conta_id uuid not null references public.contas(id) on delete cascade,
  medico_id uuid references public.medicos(id) on delete set null,
  origem text not null check (origem in ('comprovante_paciente', 'comprovante_medico', 'pedido_medico')),
  chave_idempotencia text not null,
  estado text not null check (estado in (
    'aguardando_esclarecimento',
    'aguardando_cpf_paciente',
    'aguardando_cpf_medico',
    'aguardando_aprovacao_medico',
    'aguardando_prontidao_fiscal',
    'enfileirada',
    'emitida',
    'erro',
    'cancelada'
  )),
  paciente_nome text,
  paciente_telefone text,
  paciente_cpf_hash text,
  paciente_cpf_encriptado bytea,
  pagador_nome text,
  pagador_cpf_hash text,
  atendimento_externo_id text,
  data_consulta date,
  valor_centavos integer check (valor_centavos is null or valor_centavos > 0),
  aprovado_pelo_medico boolean not null default false,
  ambiente text not null default 'homologacao' check (ambiente in ('homologacao', 'producao')),
  origem_mensagem_chave jsonb,
  solicitacao_id uuid,
  nota_fiscal_id uuid,
  erro_motivo text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (conta_id, chave_idempotencia)
);

create index if not exists idx_noto_casos_emissao_conta_estado
  on public.noto_casos_emissao (conta_id, estado, atualizado_em desc);

create index if not exists idx_noto_casos_emissao_aguardando_cpf
  on public.noto_casos_emissao (conta_id, paciente_telefone, atualizado_em desc)
  where estado = 'aguardando_cpf_paciente' and paciente_telefone is not null;

create index if not exists idx_noto_casos_emissao_solicitacao
  on public.noto_casos_emissao (solicitacao_id)
  where solicitacao_id is not null;

alter table public.conta_pagadores_secundarios enable row level security;
alter table public.noto_casos_emissao enable row level security;

revoke all on table public.conta_pagadores_secundarios from public;
revoke all on table public.noto_casos_emissao from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.conta_pagadores_secundarios from anon';
    execute 'revoke all on table public.noto_casos_emissao from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.conta_pagadores_secundarios from authenticated';
    execute 'revoke all on table public.noto_casos_emissao from authenticated';
  end if;
end $$;

commit;
