# Conversa — etapa 1

Base: `main`, `b5e1d2fe8b0e8a5633ca7e065667ca323d1b6dca` (conferida no origin). Branch: `feat/conversa-etapa1`.

## O que mudou

- Migration idempotente `20261020-conversa-mensagens.sql`, runner e `npm run migrate:conversa`, somente como arquivos. `medico_id` é UUID, como nas migrations vizinhas. Nenhuma migration foi aplicada.
- Repositório Postgres: últimas quatro mensagens em ordem cronológica, sanitização antes de gravar, deduplicação por médico/conversa/mensagem, leitura e gravação de resumo com marcador de ID.
- Conversador sem ferramentas: reutiliza `completarIa`/`iaModeloTexto`, JSON estrito via zod, um a três balões de até 500 caracteres. Erro/JSON inválido usa a única constante `RASCUNHO_FALLBACK_CONVERSA`, com o comentário de aprovação futura solicitado.
- Resumo rolante: após mais de vinte mensagens antigas fora da janela e posteriores ao último marcador, pede JSON estrito de até 600 caracteres; falhas são ignoradas.
- `CONVERSA_LIVRE_ATIVA` só aceita `true` literal; padrão false. Desligada, mantém a RAM existente e não acessa `conversa_*` nem o novo conversador/resumidor.
- Ligação somente em resposta do médico com decisão `nenhuma` elegível. O sinal opcional do orquestrador diferencia ausência de decisão de reserva ocupada e erro, inclusive erro de liberação. Cofre, senha/segredo e estado ausente preservam os retornos anteriores.
- O callback do servidor somente registra `conversa simulada`. Nenhum transporte novo, ferramenta ou tipo de `ProximaAcaoNoto`. Boas-vindas e os controles existentes de envio não foram modificados.

## TRAVAR — antes de editar

A primeira tentativa de `npm run typecheck` e `npm test` parou na compilação por dependência ausente no ambiente:

```text
src/io/pdf/extrator-comprovante-pdf.ts(1,29): error TS2307: Cannot find module 'pdfjs-dist/legacy/build/pdf.mjs' or its corresponding type declarations.
src/io/pdf/extrator-comprovante-pdf.ts(11,36): error TS7006: Parameter 'item' implicitly has an 'any' type.
```

Executei `npm ci` pelo lockfile existente: `added 216 packages in 4s`. Não alterei package-lock.json, código PDF ou teste existente. Repeti os dois comandos ainda antes da primeira edição; ambos passaram.

Typecheck da base:

```text
> notomed-whats@0.1.0 typecheck
> tsc --noEmit
```

Saída da suíte da base:

```text
> notomed-whats@0.1.0 test
> tsc --noEmit -p tsconfig.test.json && vitest run


 RUN  v4.1.12 /workspace/notomedia


 Test Files  54 passed (54)
      Tests  711 passed | 3 skipped (714)
   Start at  09:09:57
   Duration  13.28s (transform 2.12s, setup 470ms, import 14.17s, tests 4.19s, environment 6ms)
```

## PROVAR — depois

Typecheck final, sem erros:

```text
> notomed-whats@0.1.0 typecheck
> tsc --noEmit
```

Saída integral da suíte final:

```text
> notomed-whats@0.1.0 test
> tsc --noEmit -p tsconfig.test.json && vitest run


 RUN  v4.1.12 /workspace/notomedia


 Test Files  59 passed (59)
      Tests  759 passed | 3 skipped (762)
   Start at  09:16:07
   Duration  14.28s (transform 2.40s, setup 528ms, import 15.18s, tests 4.20s, environment 6ms)
```

Antes: **54 arquivos, 711 passando, 3 ignorados (714)**. Depois: **59 arquivos, 759 passando, 3 ignorados (762)**. Acréscimo: **48 testes passando**, todos em arquivos novos. Nenhum teste existente editado, removido ou com assert enfraquecido. `git diff --check` passou.

Durante a escrita dos testes novos, a compilação detectou inferência de string no double do extrator e um parâmetro implícito any no teste novo do servidor. Corrigi apenas as anotações desses testes novos; os checks finais acima incluem essas correções. Os testes selecionados do repositório e os existentes relacionados passaram (41); os do conversador passaram (17).

### Verificado com doubles e fronteiras observadas

- Repositório: CPF, telefone, e-mail e token ausentes dos parâmetros SQL; leitura por outra instância recupera a janela, com isolamento por médico/conversa e idempotência de mensagem.
- Flag off: RAM/ação/histórico anterior preservados; zero queries novas e zero chamadas ao conversador. A suíte anterior inteira segue passando.
- Fora do assunto e fluxo sem decisão: entregam fala. Provedor indisponível, JSON inválido, vazio e mais de três balões usam fallback.
- Texto malicioso permanece dado no prompt. O novo cliente não recebe ferramentas; a ação segue `nenhuma`.
- Servidor com flag on, tanto NVIDIA quanto OpenAI: usa o provedor escolhido, recupera textos depois de recriar o app e somente loga a fala. Spies confirmam zero chamadas a enviarTexto, enviarPdf, fetch e ao ponto de entrada do emissor, inclusive com `envioMedicoRealAtivo=true`.
- Resumo: não grava com vinte antigas; grava ao passar do limite; mantém a janela; usa o resumo anterior no lote seguinte; marcador não retrocede. Falha da IA mantém a fala e o resumo anterior.
- Nenhuma conversa nova em cofre, segredo, estado ausente, falha de estado/histórico/extrator/liberação, reserva ocupada, ausência de resposta ou ação determinística.

### Limites da evidência

Não executei banco Postgres real, migration, provedor de IA real nem WhatsApp real. O teste de migration inspeciona o arquivo; os testes de persistência usam fake de pool no padrão vizinho. Os prompts expressam as restrições de conteúdo; os doubles provam contrato/isolamento e não medem obediência de um modelo real. Nenhuma alegação de homologação de fala para envio real.

## ENXUGAR — escopo e decisões

Nenhuma funcionalidade fora do pedido. Sem dependências novas, refatoração de outras áreas ou alteração em emissão, fila, certificado, login/OTP, cofre, agenda ou worker. Não executei merge ou deploy.

Detalhes de implementação não definidos no prompt:

- **decisão do Codex, não do dono**: usar um callback interno opcional `aoSemDecisao` para distinguir os motivos de `nenhuma`, sem ampliar a união de ações. Só sinaliza após liberar a reserva sem erro.
- **decisão do Codex, não do dono**: guardar os balões da mesma resposta como um texto com quebras de linha e ID `noto:<chaveProcessamento>`, preservando uma mensagem por papel/evento. O callback recebe o array de balões.
- **decisão do Codex, não do dono**: representar IDs bigserial como strings no TypeScript para evitar perda de precisão; comparar/ordenar numericamente em SQL e impedir que um resumo atrasado faça o marcador retroceder.
- **decisão do Codex, não do dono**: reutilizar a chaveConversa já produzida no webhook. Chamadas internas sem essa chave não ganham identificador de conversa inventado e não persistem histórico textual.
- **decisão do Codex, não do dono**: atualizar o resumo depois de persistir a troca e entregar a fala simulada, preservando a resposta caso o resumo falhe. Sanitizar também a saída do modelo antes de persistir/logar.

Não há dúvida funcional pendente anotada como resolvida por suposição. Fala real continua para etapa posterior; esta entrega não a habilita.


---

# Relatório — feat/conversa-etapa1

Base confirmada: `ab233d7c89b7526297bae2973a3a397f05ecebfc`, repositório SeveroAllan/notomedia.

## Plano registrado antes da implementação

1. Em `src/server.ts`, `src/config.ts`, `.env.example`, `src/cadastro/google-registro.ts` e consumidores de `completarNvidia`, usar somente chave/modelos/cliente OpenAI. Remover o endpoint e a função NVIDIA, preservando os nomes legados de classes e pastas para limitar o diff. Atualizar também o script de consulta que consome a configuração removida.
2. Ajustar apenas fixtures, mocks e cenários de seleção do provedor nos testes afetados, preservando os asserts de negócio. Substituir a cobertura do provedor removido pela rejeição explícita sem chave; verificar a pesquisa opcional de CRM.
3. No segundo commit, acrescentar exclusivamente as duas referências com cascade na migration existente. Não executar SQL.
4. Verificar typecheck, compilação dos testes, Vitest, ausência dos endpoints/modelos proibidos e diff; registrar evidências antes/depois e fazer push na mesma branch.

## Antes de alterar código

`npm ci` — exit 0:
```text
added 216 packages in 58s
```

`npm run typecheck` — exit 0, sem diagnósticos:
```text
> notomed-whats@0.1.0 typecheck
> tsc --noEmit
```

`npx vitest run` — exit 1:
```text
Test Files  2 failed | 57 passed (59)
     Tests  2 failed | 757 passed | 3 skipped (762)
  Start at  14:01:18 UTC
  Duration  252.46s (transform 35.33s, setup 8.11s, import 209.15s, tests 80.31s, environment 653ms)
```

As duas falhas foram `Test timed out in 5000ms`: fluxo completo de `tests/login-otp-email-http.test.ts` e cenário NVIDIA de `tests/servidor-conversa-livre.test.ts`. O total esperado de 759 aprovados não foi observado nessa primeira execução. Reexecução isolada dos dois arquivos iniciada sem modificar testes, mocks, asserts ou timeout.

Ocorrência operacional: typecheck e Vitest foram inicialmente disparados antes de o npm ci terminar e retornaram `tsc: not found` / `vitest: not found`. Depois da instalação foram executados novamente; os resultados acima são dessa execução completa.

Reteste antes da implementação — `npx vitest run tests/login-otp-email-http.test.ts tests/servidor-conversa-livre.test.ts`, exit 0:
```text
Test Files  2 passed (2)
     Tests  9 passed (9)
  Start at  14:05:41 UTC
  Duration  21.07s (transform 12.11s, setup 1.44s, import 30.33s, tests 3.39s, environment 0ms)
```
Os dois arquivos passaram sem alterações ou aumento de timeout; a causa específica da lentidão da execução completa permanece hipótese.

## Complemento: plano do terceiro commit

Após os commits OpenAI e FK, acrescentar um método específico de conversa em `src/whatsapp/comunicacao-homologacao.ts`, reutilizando `permitido` e `enviarUnico`. A reserva cobre o lote inteiro de até três balões e permanece consumida em entrega incerta. Ligar o callback existente de fala livre em `src/server.ts` a esse método; nenhuma outra ação do orquestrador será habilitada. Atualizar somente o comentário do fallback, sem renomear sua constante ou alterar o texto informado no pedido.

Em `tests/servidor-conversa-livre.test.ts`, manter a prova de memória e ausência de efeitos fiscais e acrescentar integração webhook → fala → envio falso, com allowlist única `+5551993527271`, JID sem nono dígito `555193527271`, outro telefone, flags desligadas, produção, reentrega e fallback. Em `tests/passo12-envio-medico.test.ts`, cobrir limite de balões, concorrência e falha com reserva consumida no novo método, reutilizando o mesmo desenho de fake SQL existente. Nenhuma configuração de servidor ou envio real será executado. `ENVIO_PACIENTE_REAL_ATIVO` permanece false nos cenários de integração.

## Commit 1 — diff e explicação de cada teste alterado

- `src/config.ts` e `.env.example`: removidas chave/modelo NVIDIA; exemplo passa a expor chave e modelos OpenAI de texto/visão.
- `src/server.ts`: seleção fixa de OpenAI, mantendo pesquisa CRM desligada sem chave.
- `src/cadastro/google-registro.ts` e `scripts/consultar-registro-profissional.mjs`: usam opção `openaiApiKey` e modelo OpenAI; retirado o desvio Kimi → Llama. Códigos de diagnóstico legados foram preservados para evitar mudança desnecessária de contrato.
- `src/io/nvidia/chat-client.ts`: removidos função/endpoint NVIDIA e a configuração genérica de provedor sem outros consumidores; request só pode usar o endpoint OpenAI. Erro sem chave continua `IA_NAO_CONFIGURADA`.
- Extratores e tipo do conversador: usam o mesmo cliente OpenAI; nomes de pastas/classes preservados.

Testes alterados, com motivo:

- `tests/ambiente.ts`: limpa `OPENAI_API_KEY`, agora a credencial usada, para não consumir a chave do ambiente real.
- `tests/ia-provedor.test.ts`: conserva URL, modelo, Authorization, conteúdo e ausência de campos NVIDIA no request OpenAI; substitui o teste do provedor removido por rejeição `IA_NAO_CONFIGURADA` sem fetch. Acrescenta CRM desligado sem chave e extração padrão no endpoint/modelo OpenAI, cobrindo o consumidor que tinha fallback próprio.
- `tests/servidor-conversa-livre.test.ts`: remove somente a variante NVIDIA e seu mock/fixture; conserva o cenário OpenAI, memória, sanitização e barreiras de envio/fiscal. O assert de não chamar o segundo provedor sai porque esse provedor deixa de existir; há prova de ausência de rede sem chave em `ia-provedor`.
- `tests/ciclo-comprovante.test.ts`: mock do cliente muda para `completarOpenAi`; asserts intactos.
- `tests/contexto-resposta-medico.test.ts`: mock do cliente muda para `completarOpenAi`; asserts intactos.
- `tests/resposta-medico-ia.test.ts`: mock do cliente muda para `completarOpenAi`; asserts intactos.
- `tests/passo12-servidor.test.ts`: mock e fixture da chave passam para OpenAI; asserts intactos.
- `tests/servidor-ciclo-comprovante.test.ts`: mock, configuração/restauração e cenário de ausência de chave passam para OpenAI; asserts intactos.
- `tests/servidor-comunicacao-medico.test.ts`: mock e configuração/restauração de chave/modelo passam para OpenAI; asserts intactos.
- `tests/servidor-emissao-comprovante.test.ts`: mock e fixture da chave passam para OpenAI; asserts intactos.

A remoção do cenário NVIDIA diminui um caso e os dois casos novos de CRM acrescentam dois: total esperado após este commit, 760 aprovados e 3 ignorados.

## Atualização de evidência e escopo

O usuário informou uma validação independente em clone de `ab233d7`: `npm ci`, `npm run typecheck` e `npx vitest run`, com 59 arquivos, 759 aprovados, 3 ignorados, 19,85s. Esse resultado foi informado pelo usuário, não executado por este agente. Os dois timeouts locais ocorreram antes de qualquer mudança e passaram no reteste; não constituem regressão introduzida neste trabalho. Nenhum timeout será alterado.

Escopo atualizado do commit 2: além das duas FKs com cascade, acrescentar RLS em `public.conversa_mensagens` e `public.conversa_resumos` e `revoke all` das duas tabelas para `anon, authenticated`, sem políticas públicas. O usuário informou que está tratando a aplicação no Supabase separadamente. Nenhuma migration será executada no Codex.

Durante a validação do commit 1, o teste de comprovante apontou que sua fixture ainda configurava o modelo de texto para uma imagem. A fixture/restauração de `tests/servidor-ciclo-comprovante.test.ts` foi corrigida para `openaiVisaoModel`; o assert exato de chave/modelo foi preservado. Isso verifica a separação de modelos por finalidade no servidor.

## Validação do commit 1

`npm run typecheck`: exit 0, sem diagnósticos. `npm test`: compilação de testes passou; execução inicial teve 759 aprovados, 3 ignorados e a única falha de fixture de modelo visual descrita acima (180,73s). Após corrigir a fixture, `npx vitest run`: exit 0. Nenhum timeout foi alterado.
```text
RUN  v4.1.12 /workspace/notomedia


 Test Files  59 passed (59)
      Tests  760 passed | 3 skipped (763)
   Start at  14:12:07
   Duration  119.36s (transform 11.79s, setup 5.64s, import 125.63s, tests 40.90s, environment 51ms)
```

Verificado: grep case insensitive por `llama|integrate.api.nvidia` em `src` e `.env.example` sem resultados (exit 1 por ausência de correspondências); `git diff --check` limpo. Hipótese/não exercitado: credencial OpenAI real, qualidade das respostas e deploy. Nenhum banco real ou envio real foi utilizado.

## Commit 2 — FK e RLS

Commit 1: `b2987fb114b879b0511516d44e42962d690da461`.

A migration existente recebeu exatamente duas FKs `references public.medicos(id) on delete cascade` e os três comandos de RLS/revoke especificados no complemento. O restante do SQL foi preservado. Não há migration nova ou política pública; nenhum comando SQL foi executado. A suíte verde imediatamente anterior está registrada acima; a validação final após os três commits abrangerá também este arquivo.

Verificado por comparação textual: duas substituições e três comandos acrescentados; `git diff --check` limpo. Não verificado: aplicação e privilégios efetivos no Supabase, tratados fora do Codex pelo usuário.
