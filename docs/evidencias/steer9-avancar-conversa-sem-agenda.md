# STEER 9 — avançar a conversa sem repetir a orientação

Base: 76001c1, branch feat/conversa-etapa1.

## Mudança

O prompt substitui o exemplo incompleto pela primeira orientação completa: reconhecer agenda de papel/WhatsApp, explicar uma vez que não vê o histórico/comprovantes antigos, pedir CPF e telefone do paciente, valor e data da consulta, um por vez, explicar a conferência/confirmação e manter o fluxo normal de comprovantes novos. A pergunta seguinte sobre como emitir pede diretamente os dados, sem repetir o reconhecimento ou a explicação. A coleta continua somente na conversa; não foi adicionada ação fiscal.

O repositório fornece os últimos seis balões do Noto, isolados por médico e conversa. Uma candidata que repete um deles, após sanitização e normalização de espaços/caixa, é rejeitada. Há exatamente uma nova chamada à IA, com instrução de avançar no pedido atual. A resposta regenerada passa pelo mesmo schema, limites, sanitização e gates de ação. Repetição persistente ou JSON inválido nessa tentativa usa o fallback existente, sem terceira chamada nem ação da resposta descartada.

A marca `contexto:sem_agenda_digital` agora guarda somente `{"semAgendaDigital":true}`. Como o schema existente aceita apenas `medico` e `noto`, usa o papel técnico `noto`, mas o prefixo reservado a exclui de TODAS as leituras de fala e das mensagens a resumir: não é apresentada como fala de nenhum dos dois. A IA recebe a informação somente como contexto estruturado no sistema. Marcas antigas no papel `medico` também são excluídas imediatamente; o upsert corrige papel/texto ao próximo reconhecimento. Não houve migration nem execução no banco real.

Três arquivos de produção alterados: conversador, repositório de conversa e passagem do contexto. Sem mudança em emissão, envio, lote, Hub, flags, allowlist, dedup ou transportes.

## Evidência

- Baseline relacionado: quatro arquivos, 237 passaram / 3 ignorados, 30,78 s.
- Teste primeiro: cinco regressões falharam / 182 passaram, demonstrando repetição sem regeneração, ausência da orientação completa no prompt e marca interna misturada às falas.
- Primeira rodada após implementação: 282 passaram / 3 ignorados, uma falha em fixture antiga de resumo. O mock repetia a mesma fala e passou a disparar a regeneração; foi variada somente essa resposta. Todos os asserts de quantidade de mensagens, janela, conteúdo sanitizado e avanço do marcador foram mantidos.
- Validação final: `npx vitest run tests/conversador-medico.test.ts tests/processar-conversa-medico.test.ts tests/memoria-conversa-medico.test.ts tests/cofre-links.test.ts tests/servidor-conversa-livre.test.ts --maxWorkers=1` — 5 arquivos passaram, 285 passaram / 3 ignorados, 152,61 s, exit 0. `npx tsc --noEmit` — saída vazia, exit 0. Logs brutos locais em `work/steer9-*.log`.

Fixtures novas cobrem primeira orientação completa → pergunta seguinte → candidata repetida → instrução de avançar → resposta prática; apenas uma regeneração; segunda repetição/JSON inválido sem terceira chamada; comparação após sanitização; gates mantidos na resposta regenerada; marca legada convertida sem duplicar e excluída de falas/resumos; últimos seis balões isolados por médico/conversa. O fake SQL foi ajustado para representar os novos filtros, limite e upsert, sem alterar dedup das mensagens normais.

## Verificado versus hipótese

Verificado por fixtures: protocolo, encadeamento entre turnos, rejeição de repetição, marca de contexto separada, ausência de chamadas reais e proteção de dados/ações. Typecheck e execução relacionada passaram conforme os resultados acima.

As falas da IA são controladas nos testes; a aderência da OpenAI real à orientação completa e o tom precisam da bateria de homologação. A guarda determinística verifica igualdade, não equivalência semântica. Respostas determinísticas de ferramentas mantêm sua lógica anterior. Suíte completa fica para o gate do solicitante. Sem deploy ou merge.
