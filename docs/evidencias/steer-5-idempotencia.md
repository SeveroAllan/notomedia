# STEER 5 — idempotência no transporte

Base: `05c46e1`. Antes: 5 arquivos relacionados passaram (215 testes, 3 ignorados). O teste novo de reserva global falhou antes da implementação, pois o registro retornava `void` e permitia a mesma mensagem em outras conversas.

O código gravava a mesma mensagem uma vez por variante de telefone no `server.ts`. Isso explica as quatro linhas de memória, mas sem consultar Evolution/ambiente real não comprova quatro entregas físicas. Esses loops foram removidos.

Agora `ComunicacaoHomologacao.conversa` e `boasVindas` só chegam ao transporte se ganharem o INSERT com `ON CONFLICT DO NOTHING RETURNING id` em `conversa_mensagens`. O critério é médico/mensagem, inclusive entre instâncias e variantes. Os gates anteriores e a reserva em `noto_envios_homologacao` continuam. Reserva permanece consumida em entrega parcial/incerta; não há retentativa automática. A linha é uma reserva da tentativa, não comprovação de recebimento.

O processamento não pré-grava mais uma resposta que bloquearia a reserva do transporte. O registro posterior é idempotente. Conversas normais usam a chave da mensagem recebida; boas-vindas e eventos de agenda possuem uma única linha e são lidos nas variantes de JID sem gerar cópias.

Conclusão de link ganha uma marca `concluido` persistente na auditoria existente, antes do callback. O inbound ganha reserva atômica por médico/instância/id Evolution antes de confirmação fiscal, IA ou conversa. Essa reserva contém somente hash/id, sem texto ou credencial.

Migration preparada: `20261023-conversa-envio-idempotente.sql`. Em transação, trava a tabela, mantém a primeira linha por médico/mensagem, cria a constraint UNIQUE global e amplia o CHECK da auditoria para a marca de conclusão. **Não executada. Deve ser aplicada manualmente para ativar a garantia de unicidade entre conversas no banco.**

Testes novos: 20 registros concorrentes em diferentes conversas; 20 transportes concorrentes para boas-vindas/acesso/continuação/falha, verificando uma linha antes do primeiro balão; conclusão concorrente e marca de outra tentativa; 12 reentregas concorrentes do mesmo id Evolution, com um processamento; contrato da migration.

Testes antigos atualizados: unicidade deixa de aceitar cópias por conversa; memória continua legível nos dois JIDs; falha parcial mantém reserva; texto sanitizado é permitido na tabela de conversa, enquanto a auditoria de transporte continua sem conteúdo; fakes modelam as novas reservas de entrada/conclusão. Nenhum assert de flag/ambiente/allowlist, credencial, dedup ou decisão fiscal foi removido.

Primeira suíte completa: 1048 passaram, 3 ignorados, 8 falharam. Seis falhas eram queries de reserva inbound ainda não modeladas no fake de `servidor-comunicacao-medico.test.ts`; duas eram timeouts de Chromium (5000ms), sem alterar testes/timeouts. Os dois arquivos passaram isolados: 13/13.

Repetição integral, `npx vitest run --maxWorkers=1`: 62 arquivos; **1056 passaram, 3 ignorados, zero falhas**, 110,28s. Depois foi preservada explicitamente a chave da conversa normal no transporte; typecheck e bateria relacionada foram repetidos.

Verificado localmente com transporte e banco falsos: reserva antes do envio, concorrência, reentrega, limites/gates e leitura de memória. Não verificado contra PostgreSQL ou Evolution real; não houve execução de migration, banco real, envio real, merge ou deploy. Nenhuma parte do STEER 6b foi implementada neste commit.

Logs locais ignorados em `work/steer5-*.log`.
