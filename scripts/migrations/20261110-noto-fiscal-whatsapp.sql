-- Revisão apenas. Pré-requisitos: cadeia de comprovantes de 20261018 a 20261021
-- e tabelas fiscais da homologação. Transação aborta se faltar uma dependência.
begin;

alter table public.noto_auditoria_comprovantes
  add column origem text not null default 'comprovante',
  add column conta_id uuid references public.contas(id),
  add column mensagem_ref text,
  add constraint noto_auditoria_origem_check check (
    (origem = 'comprovante' and conta_id is null and mensagem_ref is null)
    or (origem = 'autorizacao_whatsapp' and conta_id is not null and mensagem_ref is not null and lido is null)
  ),
  add constraint noto_auditoria_identidade_unique unique (id, medico_id, origem);

alter table public.noto_emissoes_comprovantes
  add column origem text not null default 'comprovante',
  add column if not exists dps_id text,
  add column if not exists recusa_definitiva boolean not null default false;

alter table public.noto_emissoes_comprovantes
  alter column comprovante_chave drop not null,
  add constraint noto_emissoes_origem_check check (
    (origem = 'comprovante' and comprovante_chave is not null)
    or (origem = 'autorizacao_whatsapp' and comprovante_chave is null and solicitacao_id is not null)
  ),
  add constraint noto_emissoes_auditoria_origem_fk
    foreign key (auditoria_comprovante_id, medico_id, origem)
    references public.noto_auditoria_comprovantes (id, medico_id, origem);

alter table public.solicitacoes_nota
  add column if not exists referencia_externa text,
  add column if not exists aguardando_cpf_medico boolean not null default false;

create unique index if not exists idx_solicitacoes_medico_ref
  on public.solicitacoes_nota (medico_id, referencia_externa) where referencia_externa is not null;

alter table public.medico_perfil_fiscal
  add column if not exists nome_fantasia text,
  add column if not exists regime_apuracao_sn text,
  add column if not exists regime_especial_tributacao smallint,
  add column if not exists percentual_tot_trib_sn numeric,
  add column if not exists xml_nota_referencia_url text;

commit;
