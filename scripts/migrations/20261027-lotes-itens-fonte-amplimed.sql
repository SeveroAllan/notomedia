-- Somente proposta de migração: não executar automaticamente. Precisa do "pode rodar" do Allan.
-- Motivo: noto_lotes_itens aceita só fonte='tribemd'; o lote do Amplimed grava itens com fonte='amplimed' e falha na constraint.
-- Efeito: troca uma constraint CHECK por outra mais larga. Não altera nem apaga linhas. Reversível (voltar para fonte='tribemd' só funciona se não houver itens amplimed).
begin;
alter table public.noto_lotes_itens drop constraint noto_lotes_itens_fonte_check;
alter table public.noto_lotes_itens add constraint noto_lotes_itens_fonte_check check (fonte in ('tribemd', 'amplimed'));
commit;
