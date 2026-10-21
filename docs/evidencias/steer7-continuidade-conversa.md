# Continuidade da conversa e histórico do link seguro

Base: 4cc392f, branch feat/conversa-etapa1.

## Mudança

Os balões do link passam ao histórico após cada envio real confirmado. A URL entra com `[LINK_SEGURO]` no lugar do token descartável; simulação/falha não registra texto não enviado. O wiring usa a memória existente, com chave da instância assistente e telefone; o leitor já inclui mensagens `noto:agenda:*` entre variantes de telefone. Falha de gravação gera aviso interno sem conteúdo sensível e não repete o envio.

O conversador recebe orientação para tratar explicações anteriores como sabidas e reconhecer imediatamente informação nova, com exemplo de agenda de papel, sem inventar modo manual. O resumo preserva informações novas e explicações já recebidas. Resultado `repetido` volta à IA com histórico, em vez de impor a frase fixa anterior. Um link ativo impede outra criação na conversa, inclusive sem a marca de solicitado. Renovação permitida usa apresentação curta, sem repetir justificativa/segurança.

O hook em links/router/server é necessário para capturar os textos efetivamente enviados; transporte, SQL de criação/invalidação/limite, credenciais, gates, dedup, lote e emissão permanecem com a mecânica anterior.

## Evidência

Antes: cinco arquivos relacionados, 265 passaram / 3 ignorados (36,02 s).
Teste primeiro: três regressões novas falharam / 133 passaram / 3 ignorados: ausência de histórico, renovação longa e criação com link ativo.
Typecheck: `npx tsc --noEmit`, saída vazia, exit 0.

A primeira rodada após implementação expôs expectativas antigas de renovação com link ativo. Os cenários foram ajustados para link expirado/usado, mantendo envio único, reentrega idempotente e tratamento da espera. A expectativa de primeira solicitação continua sem opção de renovação. O teste antigo de `repetido` determinístico foi substituído por cenário com histórico e resposta contextual, mantendo a proibição de alegar novo envio. Enviado/simulado/erro mantêm os asserts anteriores.

Cenários adicionados: emissão → link → agenda de papel (reconhecimento na primeira resposta, história disponível, sem novo link); renovação curta após expiração; link ativo sem marca anterior; gravação por envio confirmado inclusive falha parcial, sem simulação; histórico entre variantes do telefone; resultado repetido sem frase imposta.

Resultado final: `npx vitest run tests/cofre-links.test.ts tests/processar-conversa-medico.test.ts tests/conversador-medico.test.ts tests/memoria-conversa-medico.test.ts tests/servidor-conversa-livre.test.ts --maxWorkers=1` — 5 arquivos passaram, 271 passaram / 3 ignorados (53,88 s), exit 0. Logs brutos locais em `work/steer7-continuidade-*.log`.

## Verificado e limites

Verificado com fixtures isoladas: passagem dos balões e contexto até o modelo, token mascarado, bloqueio de ação com link ativo, renovação curta, ausência de gravação de envio simulado, registro parcial dos textos realmente enviados e limites/segurança dos módulos relacionados.

As respostas da IA são controladas nos testes; naturalidade efetiva e reconhecimento com OpenAI real dependem da bateria de homologação. Não foram feitas chamadas reais de agenda, OpenAI, banco ou WhatsApp. A suíte completa será validada pelo solicitante, conforme instrução desta tarefa. Sem deploy ou merge.
