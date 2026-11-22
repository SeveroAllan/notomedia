-- Revisão apenas. Registro administrativo separado da origem clínica.
begin;
create table public.noto_atendimentos_teste_aprovados (
  agendamento_id uuid primary key,
  conta_id uuid not null references public.contas(id),
  medico_id uuid not null,
  paciente_id uuid not null,
  servico_fiscal_id uuid not null,
  data_hora timestamptz not null,
  valor_centavos integer not null check (valor_centavos > 0),
  aprovacao_hash text not null check (aprovacao_hash ~ '^[a-f0-9]{64}$'),
  aprovado_em timestamptz not null default now(),
  foreign key (agendamento_id, medico_id) references public.agendamentos(id,medico_id),
  foreign key (paciente_id, medico_id) references public.pacientes(id,medico_id),
  foreign key (servico_fiscal_id, medico_id) references public.medico_servicos_fiscais(id,medico_id)
);
alter table public.noto_atendimentos_teste_aprovados enable row level security;
revoke all on public.noto_atendimentos_teste_aprovados from public;
do $$
begin
  if exists(select 1 from pg_roles where rolname='anon') then
    revoke all on public.noto_atendimentos_teste_aprovados from anon;
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    revoke all on public.noto_atendimentos_teste_aprovados from authenticated;
  end if;
end $$;
commit;
