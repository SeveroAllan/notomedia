# Proposta: retomar consulta recusada pela SEFIN (homologação). NÃO APLICADA.

Estado: proposta. Nada de migração rodada. Só rodar com "pode rodar" do Allan.

## Problema
Item com erro_codigo `EMISSAO_COMPROVANTE_RECUSADA: E0207` fica preso: índice único `noto_lote_consulta_unica (medico_id, consulta_chave)` em noto_lotes_itens e a trava em `reservarEEnfileirar` (estado erro/bloqueada => EMISSAO_COMPROVANTE_BLOQUEADA).

## Regra: recusa comprovada x resultado incerto
- Recusa comprovada (retomável): noto_emissoes_comprovantes.estado='erro', nota_fiscal_id IS NULL, erro_codigo ~ '^EMISSAO_COMPROVANTE_RECUSADA: E[0-9]{4}$' (código de negócio devolvido pela SEFIN) e solicitação em erro.
- Incerto (continua travado, sem retomada automática): PERSISTENCIA_COMPROVANTE_PENDENTE, EMISSAO_COMPROVANTE_FALHOU, SEFIN_TIMEOUT, AMBIENTE_FISCAL_BLOQUEADO, qualquer erro sem código E####, ou com nota_fiscal_id.

## Mecanismo (auditoria preservada, nada apagado)
1. Nova tentativa só em lote novo, com novo "sim" do médico (a confirmação do lote anterior não vale).
2. Antes de inserir itens, `preparar` marca a emissão antiga comprovadamente recusada como `substituida` (novo valor no CHECK de estado) e grava `substituida_por` (lote_item novo). O item antigo muda de consulta_chave sufixada ou o índice único passa a ser parcial (`where estado <> 'substituido'`).
3. reservarEEnfileirar ignora linhas `substituida` na checagem de existentes e cria nova reserva + nova solicitação (nova ref). Nota emitida (`nota_gerada`) continua bloqueando para sempre.
4. Testes: recusa E#### reabre; timeout/incerto não reabre; nota_gerada não reabre; sem "sim" novo não emite.

## Migração necessária (a escrever depois do "pode")
- CHECK de estado em noto_emissoes_comprovantes aceita 'substituida'; coluna substituida_por uuid.
- Índice único de noto_lotes_itens parcial ou item antigo com estado 'substituido' fora do índice.
