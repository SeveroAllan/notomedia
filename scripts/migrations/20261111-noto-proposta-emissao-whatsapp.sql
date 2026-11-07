-- Revisão apenas. Depende de 20261110-noto-fiscal-whatsapp.sql.
begin;
create table public.noto_propostas_emissao_whatsapp (
  id uuid primary key default gen_random_uuid(),
  conta_id uuid not null references public.contas(id),
  medico_id uuid not null references public.medicos(id),
  agendamento_id uuid not null references public.agendamentos(id),
  conversa_ref text not null check (conversa_ref ~ '^[a-f0-9]{64}$'),
  pedido_ref text not null unique check (pedido_ref ~ '^[a-f0-9]{64}$'),
  resposta_ref text unique check (resposta_ref ~ '^[a-f0-9]{64}$'),
  dados_hash text not null check (dados_hash ~ '^[a-f0-9]{64}$'),
  valor_centavos integer not null check (valor_centavos > 0),
  criada_em timestamptz not null default now(),
  expira_em timestamptz not null default now() + interval '10 minutes',
  revogada_em timestamptz,
  confirmada_em timestamptz,
  unique (id, medico_id, conta_id)
);
create unique index noto_proposta_ativa_por_conversa on public.noto_propostas_emissao_whatsapp (conta_id, conversa_ref)
  where revogada_em is null and confirmada_em is null;
alter table public.noto_propostas_emissao_whatsapp enable row level security;
revoke all on public.noto_propostas_emissao_whatsapp from public;
do $$
begin
  if exists(select 1 from pg_roles where rolname='anon') then
    revoke all on public.noto_propostas_emissao_whatsapp from anon;
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    revoke all on public.noto_propostas_emissao_whatsapp from authenticated;
  end if;
end $$;
alter table public.noto_auditoria_comprovantes
  add column proposta_whatsapp_id uuid unique,
  add constraint noto_auditoria_proposta_whatsapp_fk foreign key (proposta_whatsapp_id, medico_id, conta_id)
    references public.noto_propostas_emissao_whatsapp(id, medico_id, conta_id),
  add constraint noto_auditoria_proposta_whatsapp_origem check
    (proposta_whatsapp_id is null or origem='autorizacao_whatsapp');
commit;
