-- Proposta: permissões do Noto escolhidas por link com botões, por conta (WhatsApp conectado).
-- NÃO APLICADA. Aplicar somente com "pode rodar" explícito do Allan, em homologação, depois da revisão.
-- Desenho aprovado na conversa 22/10 11:15-12:04: 2 permissões por WhatsApp conectado
-- (emitir_autonomo, entregar_paciente), pedidas quando passam a valer, sem padrão presumido:
-- ausência de escolha NÃO libera autonomia nem envio a paciente.
-- Efeitos: 5 tabelas novas; nenhuma tabela existente é alterada. Aditivo: ausente = bloqueado.
begin;

-- Vínculo médico ↔ WhatsApp conectado (identidade do operador/conta). Uma conta pode ter vários
-- médicos (clínica); as permissões são da conta, não do médico isolado.
create table if not exists public.noto_whatsapps_conectados (
  id uuid primary key default gen_random_uuid(),
  medico_id uuid not null references public.medicos(id) on delete cascade,
  numero_whatsapp text not null check (numero_whatsapp ~ '^\d{10,15}$'),
  operador text check (operador in ('medico','secretaria','outro')),
  instancia text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (medico_id)
);

-- Escolha vigente por conta e permissão. Ausente = sem escolha = não autorizado.
create table if not exists public.noto_permissoes (
  whatsapp_conectado_id uuid not null references public.noto_whatsapps_conectados(id) on delete cascade,
  permissao text not null check (permissao in ('emitir_autonomo','entregar_paciente')),
  valor text not null check (
    (permissao='emitir_autonomo' and valor in ('autonomo','sempre_perguntar'))
    or (permissao='entregar_paciente' and valor in ('paciente','so_medico'))),
  escolhido_por text check (escolhido_por in ('medico','secretaria','outro')),
  link_id uuid,
  atualizado_em timestamptz not null default now(),
  primary key (whatsapp_conectado_id, permissao)
);

-- Link de escolha: uso único, 15 minutos, token só como hash, escopo por permissão.
create table if not exists public.noto_permissoes_links (
  id uuid primary key default gen_random_uuid(),
  whatsapp_conectado_id uuid not null references public.noto_whatsapps_conectados(id) on delete cascade,
  permissao text not null check (permissao in ('emitir_autonomo','entregar_paciente')),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  expira_em timestamptz not null,
  usado_em timestamptz,
  criado_em timestamptz not null default now()
);

-- Append-only: cada abertura, expiração e uso do link de escolha.
create table if not exists public.noto_permissoes_links_auditoria (
  link_id uuid not null references public.noto_permissoes_links(id) on delete cascade,
  evento text not null check (evento in ('criado','enviado','aberto','usado','expirado')),
  criado_em timestamptz not null default now(),
  primary key (link_id, evento)
);

-- Append-only: cada mudança de escolha. Nenhuma linha se apaga nem se altera.
create table if not exists public.noto_permissoes_auditoria (
  id bigint generated always as identity primary key,
  whatsapp_conectado_id uuid not null,
  permissao text not null,
  valor text not null,
  escolhido_por text,
  link_id uuid,
  criado_em timestamptz not null default now()
);

alter table public.noto_whatsapps_conectados enable row level security;
alter table public.noto_permissoes enable row level security;
alter table public.noto_permissoes_links enable row level security;
alter table public.noto_permissoes_links_auditoria enable row level security;
alter table public.noto_permissoes_auditoria enable row level security;

do $$ declare t text;
begin
  foreach t in array array['noto_whatsapps_conectados','noto_permissoes','noto_permissoes_links','noto_permissoes_links_auditoria','noto_permissoes_auditoria'] loop
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;

commit;
