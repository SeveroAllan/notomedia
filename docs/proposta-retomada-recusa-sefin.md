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

---

## Implementação preparada (commit seguinte; flag desligada, migração NÃO aplicada)

- `src/fiscal/retomada-recusa.ts`: classificação pura. Recusa definitiva = rejeição estruturada
  do provedor (HTTP 400/422 com erros[] cujo 1º código E#### casa) + reconciliação HEAD /dps/{id}
  confirmando "não gerada". 401/403/408/429/5xx/rede/indeterminado NUNCA reabrem.
- `SefinNacionalClient.consultarDpsGerada`: HEAD /dps/{id} somente leitura. Os status de
  "gerada" (200) e "não gerada" (404) estão como constantes PENDENTES de confirmação empírica
  na produção restrita (swagger oficial inacessível da nossa infra: 403 em curl e túnel no
  navegador); qualquer outro status é "indeterminado" e mantém a trava.
- Emissor: persiste `dps_id` em noto_emissoes_comprovantes ao transmitir e, na rejeição
  estruturada, reconcilia e só então grava `recusa_definitiva=true`. Falha na reconciliação
  deixa travado e nunca interfere na emissão. Tudo atrás de `RETOMADA_RECUSA_ATIVA` (env,
  padrão desligado) no emissor e em criarSolicitacao.
- criarSolicitacao (flag): emissão existente 'erro' + recusa_definitiva + sem nota é
  substituída na MESMA transação (advisory lock por médico + select for update + índice único
  parcial = uma emissão ativa por consulta sob concorrência); nova linha com tentativa+1;
  antiga guarda substituida_por (auditoria). Incerto/nota/reserva viva: 'repetida'/'ja_faturada'.
- Migração `20261028-retomada-recusa-sefin.sql` (NÃO rodada): colunas dps_id, recusa_definitiva,
  tentativa, substituida_em/por; CHECK de formato do dps_id e de substituição; índice único por
  consulta vira parcial (where substituida_em is null). Linhas antigas ficam fora da retomada
  (recusa_definitiva=false) e o dps_id delas não existe (nDPS não era persistido), logo seguem
  travadas até reconciliação verificável com o provedor.
- Tentativas antigas do teste 22:29: sem dps_id persistido e sem prova do nDPS usado, NÃO são
  retomáveis por este caminho. Desbloqueio delas exigiria reconciliação manual verificável ou
  decisão explícita do Allan com escopo.
- Testes: tests/retomada-recusa.test.ts (8 cenários: classificação, status, rejeição
  estruturada, substituição com tentativa+1 e ligação, e os 4 casos que nunca reabrem).
