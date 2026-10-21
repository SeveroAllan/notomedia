# LIMPEZA 2 — contrato de memória

Base: `034332e`, branch `feat/conversa-etapa1`.

A implementação Postgres de mensagens, marcas e resumos passa a pertencer a `src/onboarding/memoria-conversa.ts`. O módulo anterior apenas reexporta a mesma classe. Foram adicionadas leitura agregada, escrita explícita de fala/marca/resumo e limpeza de todas as conversas de um médico em uma única instrução SQL. A chave de conversa continua obrigatória na leitura, preservando o escopo existente.

Verificado: os métodos legados, de `ler` até `gravarResumo`, foram movidos byte a byte; consultas, parâmetros, sanitização, limites, IDs e dedup permanecem iguais. Nenhuma asserção existente foi editada. O fake ganhou somente suporte à instrução de limpeza; os quatro testes novos cobrem contrato, isolamento por médico, resumo monotônico, dedup e reset completo.

Exceções preservadas para evitar mudança de comportamento:
- `contexto:*` continua fora das falas. A marca legada `noto:cofre_agenda:solicitado` já entrava no histórico textual; removê-la alteraria a entrada do modelo. Sua leitura permanece documentada e testada.
- Leituras granulares continuam no fluxo, agora implementadas no módulo único; trocá-las por uma leitura agregada anteciparia consultas e mudaria o tratamento de falhas.
- A memória em RAM no modo legado e sua interface compartilhada permanecem intactas; a reserva de mensagem anterior ao envio mantém o método de compatibilidade, sem tocar na mecânica de envio.
- Balões reais de link mascarados continuam sendo falas; o resumo só é invalidado pela limpeza completa, como documentado no contrato.

Antes: 6 arquivos relacionados, 228 passaram / 3 ignorados (dois comandos: 217 + 11). Os quatro testes novos falharam antes da API existir.

Depois: `npx tsc --noEmit` passou (saída vazia, código 0). `npx vitest run tests/memoria-conversa-contrato.test.ts tests/memoria-conversa-medico.test.ts tests/processar-conversa-medico.test.ts tests/cofre-links.test.ts tests/servidor-conversa-livre.test.ts tests/conversa-repositorio.test.ts tests/ciclo-memoria-medico.test.ts tests/falas.test.ts --maxWorkers=1`: 8 arquivos passaram, 233 testes passaram / 3 ignorados, 97,84s. `git diff --check` limpo. Saídas locais em `work/limpeza2-*.log`.

Hipótese/não exercitado: a limpeza em PostgreSQL real não foi executada; o teste valida a instrução única e seu efeito no fake. Nenhuma migration, banco real, envio, emissão ou deploy foi executado. Gate integral permanece com o solicitante.
