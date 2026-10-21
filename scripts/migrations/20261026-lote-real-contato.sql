-- Preparada para aplicação manual. NÃO executar pelo aplicativo.
-- Registros fiscais podem conter os dados legais da nota; cadastro/cache de paciente não muda.
begin;
alter table public.solicitacoes_nota add column if not exists contato_paciente_encriptado bytea null;
-- Referência fiscal para reentrega: uma nova solicitação aponta à nota existente, sem reemitir.
alter table public.solicitacoes_nota add column if not exists nota_reenvio_id uuid null references public.notas_fiscais(id);

-- Um "sim" para simulação nunca autoriza transmissão real após esta mudança.
update public.noto_lotes_emissao set estado='bloqueado'
  where estado in ('aguardando_confirmacao_lote','confirmado','processando');
alter table public.noto_lotes_emissao drop constraint if exists noto_lotes_emissao_estado_check;
alter table public.noto_lotes_emissao add constraint noto_lotes_emissao_estado_check
  check (estado in ('aguardando_data_inicio','aguardando_confirmacao_lote','confirmado','processando','simulado','recusado','bloqueado','concluido'));
alter table public.noto_lotes_itens drop constraint if exists noto_lotes_itens_estado_check;
alter table public.noto_lotes_itens add constraint noto_lotes_itens_estado_check
  check (estado in ('pronto','processando','simulada','sem_valor','ja_faturada','repetida','dados_divergentes','erro','emitida'));
-- Histórico simulado é preservado, mas não representa uma nota fiscal nem bloqueia uma nova autorização real.
update public.noto_lotes_itens i set estado='erro' from public.noto_lotes_emissao l
  where l.id=i.lote_id and l.estado='bloqueado' and i.estado='processando';
drop index if exists public.noto_lote_consulta_unica;
create unique index noto_lote_consulta_unica on public.noto_lotes_itens(medico_id,consulta_chave)
  where estado in ('processando','emitida');

-- Compartilha a MESMA unicidade por consulta com o comprovante; não fabrica comprovante/auditoria.
alter table public.noto_emissoes_comprovantes add column if not exists lote_item_id uuid unique references public.noto_lotes_itens(id);
alter table public.noto_emissoes_comprovantes alter column comprovante_chave drop not null;
alter table public.noto_emissoes_comprovantes alter column auditoria_comprovante_id drop not null;
alter table public.noto_emissoes_comprovantes add constraint noto_emissao_origem_check check (
  (lote_item_id is null and comprovante_chave is not null and auditoria_comprovante_id is not null)
  or (lote_item_id is not null and comprovante_chave is null and auditoria_comprovante_id is null)
);
-- RLS e revogações já existentes permanecem; nenhuma política pública é criada.
commit;
