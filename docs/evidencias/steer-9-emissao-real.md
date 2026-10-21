# STEER 9 — emissão real de lote em homologação e contato da solicitação

Base: `e6caf7652924b05885ff131417e3148d70a21e0e`, branch `feat/conversa-etapa1`.

Escopo recebido: registros fiscais (valor na solicitação/nota, nome e CPF no XML/PDF) são permitidos; cadastro/cache de paciente permanece proibido. Não há preenchimento de nome/CPF/valor cobrado em pacientes, consultas sincronizadas ou itens de lote. O único snapshot de contato é criptografado na solicitação.

## Antes e depois

- Base anterior: typecheck limpo; 1124 testes passaram, 3 ignorados.
- Etapa de contato antes da integração fiscal: `npx tsc --noEmit` limpo; `npx vitest run --maxWorkers=1`: 66 arquivos, 1141 passaram, 3 ignorados, 0 falhas (79,04s).
- Testes escritos antes das implementações: casos de contato falharam sem o resolvedor; integração fiscal falhou sem o adaptador; reenvio falhou sem seu executor.
- Gate intermediário: 1149 passaram, 3 ignorados, 1 falhou. A fixture profissional "Medico Ficticio" era recusada pela validação existente; corrigida para "Clara Almeida Ficticia", preservando a regra. Não houve relaxamento de validação.
- Relacionados após a integração: 5 arquivos, 113 passaram, 0 falhas (25,58s).
- `npx tsc --noEmit` final: saída vazia, exit 0.
- Primeira execução final, `npx vitest run`: 1163 passaram, 3 ignorados e 1 timeout de 5000ms no caso Chromium normal de `tests/tribemd-sync-janela.test.ts` (arquivo não alterado), 108,41s. Repetição isolada: 4/4 passaram, 14,95s.
- Gate completo final, `npx vitest run --maxWorkers=1`: **67 arquivos, 1164 passaram, 3 ignorados, 0 falhas**, 173,74s, exit 0. A execução serial evita concorrência entre arquivos neste ambiente; nenhum timeout, assert ou teste legado de Chromium/worker foi alterado.
- `git diff --check`: limpo. Evidências brutas em `work/steer9-tsc-final.log`, `work/steer9-vitest-final.log`, `work/steer9-sync-isolado.log` e `work/steer9-vitest-serial.log` (diretório local ignorado).

## Mudanças

1. `fonte-agenda.ts` resolve contato por strip de não numéricos, 10–13 dígitos: celular válido, fallback telefone; dois válidos divergentes retornam null. O detalhe ao vivo do TribeMD passa ambos junto do nome/CPF/valor, somente em memória.
2. `PostgresEmissaoApiRepositorio.enfileirarSolicitacao` recebe origem lote e grava contato apenas no INSERT, com `pgp_sym_encrypt`. O SQL/11 parâmetros do comprovante permanecem iguais; ele não escreve a nova coluna.
3. `PostgresEmissaoLote` reutiliza `processarItemFila` e `PostgresFilaRepositorio`: vincula item/solicitação à MESMA reserva global HMAC por consulta do comprovante, sem inventar comprovante/auditoria. Transação com advisory lock verifica confirmação, item, médico, período, consulta realizada, homologação e assinatura do valor cobrado ao vivo. Consulta já faturada é pulada; qualquer reserva anterior conserva o bloqueio. A passagem para emitindo é condicional, antes da transmissão.
4. O worker embutido injeta seu emissor conservador real e a entrega protegida. O lote sai do caminho de simulação; a fila geral não consome origem lote em paralelo. Falhas e resultados incertos não autorizam retentativa automática. O resumo separa emitidas, entregues, sem contato válido, sem valor e itens que exigem conferência, sem nomes ou códigos.
5. O emissor exige tomador transitório válido e valor igual à solicitação. Não lê/escreve pacientes para lote. Exige integração real, preparação fiscal e SEFIN homologação; não cai no modo local simulado. Usa as mesmas validações fiscais, DPS, assinatura, XML autorizado e gerador PDF existentes. O tomador aparece somente nos registros/documentos fiscais permitidos.
6. A entrega descriptografa o snapshot da solicitação; origem lote sem snapshot não usa telefone do cadastro. Continuam flag, ambiente, allowlist, instância conectada do próprio médico e reserva por nota fiscal. Falhas do lote são agregadas, sem avisos individuais redundantes.
7. Reenvio após correção do contato cria nova solicitação, relê o contato da mesma consulta e aponta à nota já autorizada; nunca emite outra nota nem altera o snapshot anterior. A intenção atual é interpretada pela OpenAI em JSON estrito, confiança >=0,9; um sim isolado/pedido de emissão não é reenvio. A reserva de entrega continua por nota. A referência por item/mensagem impede recriar solicitação em reentrega.

## Migration preparada, NÃO executada

`scripts/migrations/20261026-lote-real-contato.sql` acrescenta contato criptografado e referência fiscal `nota_reenvio_id` (metadado para a solicitação de reentrega). Acrescenta vínculo do item de lote à reserva global existente e CHECK que distingue lote de comprovante, preservando a unicidade por consulta. Atualiza estados reais e preserva histórico simulado. Autorizações antigas de simulação pendentes/confirmadas/em processamento ficam bloqueadas: precisam de nova proposta e confirmação para emissão real. RLS/revogações existentes permanecem, sem política pública.

Aplicação manual é pré-requisito do código novo. Lotes antigos bloqueados não são retomados como emissão real: o fluxo exige uma nova proposta/contagem e confirmação, a partir de um novo início do retroativo. Nenhuma migration foi executada pelo Codex.

## Testes alterados e novos

- `tests/lote-contato.test.ts` (novo): contatos válidos/inválidos/divergentes; INSERT criptografado versus comprovante intacto; decriptação; ausência de fallback ao cadastro; concorrência/dedup por nota; flag/ambiente/allowlist e erro sem expor chave/contato.
- `tests/lote-emissao-real.test.ts` (novo): processamento fiscal pela fila; mesma leitura transitória para valor, tomador e contato; reserva compartilhada, concorrência de 12 chamadas e reexecução; assinatura divergente; produção/gate fechado ou revogado; falha fiscal/persistência sem retransmissão; reenvio sem nova nota; DPS/XML/PDF com SEFIN, certificado e Storage falsos. A preparação fiscal, HMAC, geração de DPS e PDF são reais no teste; certificado, assinatura digital, resposta da SEFIN e upload são controlados por fixtures, sem rede externa.
- `tests/lote-retroativo.test.ts`: expectativas de simulação trocadas pelo resultado fiscal novo com emissor falso; mantidos escopo congelado, TTL de 48h, confiança, vínculo da pergunta, sem valor, faturada entre confirmação e execução, idempotência e privacidade. Acrescentados contrato de reenvio e resumo com contagens independentes. O teste do helper de simulação continua isolado, sem chamador no runtime.
- `tests/lotes-postgres.test.ts`: execução espera emitida em vez de simulada; preservada a prova de mesma assinatura do valor cobrado nas duas pontas e recusa quando diverge.
- `tests/passo12-cofre.test.ts`: retorno esperado do detalhe inclui contato do mesmo atendimento; preservadas as demais verificações.
- `tests/servidor-conversa-livre.test.ts`: wiring recebe executor fiscal falso injetado; prova que não chama simulador, executa uma vez e entrega o novo resumo (3 balões no caso com falta de valor), mantendo privacidade e ausência de envio externo.

## Verificado versus não exercitado

Verificado com fixtures: gates, escopo/assinatura, dedup/reserva, reenvio sem reemissão, SQL criptografado, tomador transitório sem cadastro/cache, chamadas à SEFIN homologação falsa, XML/PDF fiscais e resumo sem dados pessoais. Revisado diff de flags/configuração/allowlist, validação de origem e testes do worker legado: não foram alterados.

Não exercitado: migration em PostgreSQL real, criptografia/decriptação em banco real, portal real, OpenAI real, SEFIN/Storage/Evolution reais ou entrega real. Os testes comprovam os contratos e o comportamento com serviços falsos; a integração real depende do gate/deploy de homologação e aplicação manual da migration. Nenhum merge, deploy, alteração de env, envio real ou uso da médica real foi feito.
