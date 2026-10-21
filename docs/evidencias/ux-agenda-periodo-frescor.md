# UX: período, pendências e frescor da agenda

Base: `2c676033debf28c1a73b687723f0fe3e9c3572b0`, branch `feat/conversa-etapa1`.

## Comportamento entregue

1. O aviso de agenda conectada só aparece na primeira leitura demorada. O estado já persistido de aviso impede anunciá-lo novamente; leituras rápidas seguem direto ao resultado. O prompt também orienta a não repetir essa informação.
2. Falhas usam o histórico de falas dos últimos **10 minutos**, por médico/conversa, para escolher formulações alternativas. Esse histórico é lido da memória já existente, sem aumentar as quatro mensagens de contexto da IA. A frase genérica deixa de prometer uma intervenção automática inexistente. Uma falha na leitura de pendências inicia **uma única** nova leitura acompanhada em fundo, com reserva idempotente existente; só anuncia verificação em andamento se a leitura realmente estiver pendente. Ao concluir, entrega o resultado sem exigir nova mensagem. Se falhar novamente, encerra com a falha real em linguagem humana. Não reexecuta emissão nem callbacks de lote, nem repete transporte de entrega incerta.
3. Sem início conhecido, pergunta **“Desde quando você não emite notas?”** antes da varredura. Não usa 90 dias como início presumido. Mantém as validações de data, relógio de São Paulo e teto existente do retroativo.
4. Lista agrupada e ordenada por data, por exemplo `Em 06/10/2026: Pessoa B e Pessoa C.`. Cada trecho que precisar de novo balão conserva a data. Mantém até 20 itens, “e mais N consultas”, limites de balões/caracteres, tratamento de nome-injeção e memória com `[PACIENTE]`.
5. A pergunta de entrada/boas-vindas é a pergunta de período. Depois de boas-vindas realmente enviadas, registra a espera pela data. Uma resposta antes da conexão guarda somente o período, sem varrer nem autorizar emissão; esse período é reaproveitado no pós-conexão/lote. A janela enviada à fonte é a diferença em dias civis de São Paulo até o início informado (mínimo de um dia exigido pela fonte). O evento de acesso recebido não varre mais a agenda antes da pergunta.
6. Cache de agenda **somente em RAM**, por médico/instância da aplicação, com **TTL de 10 minutos a partir da conclusão da leitura**. Leitura mais ampla pode atender uma janela menor; janela maior exige nova leitura. Compartilha a mesma leitura concorrente, não guarda falhas, não sobrevive a nova instância e descarta resultados invalidados durante uma leitura. Salvar outro acesso, reconectar, desconectar/excluir ou concluir o evento de conexão invalidam o cache. O gate de homologação é rechecado antes do cache. A listagem de pendências e a exclusão de consultas já faturadas continuam consultando o banco; não são cacheadas. A execução fiscal continua relendo o detalhe ao vivo e conferindo a assinatura.

O cache não grava arquivos, tabelas nem logs de consultas/pacientes. A sincronização mantém a escrita mínima anterior: paciente por telefone e metadados da consulta; não acrescenta nome, CPF ou valor cobrado ao cadastro/cache persistido. Não houve migration ou mudança de flags/allowlist/dedup/gates fiscais.

## Testes novos e ajustes dos anteriores

- `fonte-agenda`: cache quente, TTL, janela, isolamento de médicos e instâncias, concorrência, falha não cacheada e invalidação durante leitura.
- `cofre-conexao`: invalidação real do callback ao salvar/reconectar/desconectar, com navegador falso; leitura comum não invalida o cache.
- `pendencias-medico`: agrupamento/data/máscara, ausência de aviso repetido, pergunta antes de varrer, início respondido sem agenda, recuperação e retorno automático, encerramento de duas falhas sem loop, e nenhuma repetição de callback fiscal após leitura concluída. O teste antigo de “alternar aviso” agora exige somente um aviso; o antigo pós-conexão que varria antes da pergunta agora exige perguntar antes da leitura.
- `servidor-conversa-livre`: integração do cache com isolamento/invalidação/gate de produção e ausência de nome em escrita/log; início desconhecido não lê e resposta de data limita a janela; ajustados texto de acesso, agrupamento e quantidade de chamadas à fonte (uma leitura fresca em vez de duas). O cenário de lote continua cobrindo confirmação vinculada, assinatura e trilha fiscal falsa, iniciando com período desconhecido explícito.
- `conversador-medico`: erros distintos com histórico recente, inclusive fora das quatro mensagens, sem ecoar código/segredo e sem promessa de retorno sem tarefa; atualizados texto humano e formato agrupado, preservando asserts de segurança.
- `memoria-conversa-medico`: consulta de falas recentes exige médico, conversa, autor Noto e janela de dez minutos; sanitização preservada. O fake SQL reconhece essa leitura adicional.
- `decidir-proxima-acao`, `cofre-links`, `lote-retroativo`: textos de entrada/data e última pergunta das boas-vindas; mesma quantidade de balões e regras anteriores.
- `ciclo-memoria-medico`, `contexto-resposta-medico`, `resposta-comunicacao`, `resposta-medico-ia`, `servidor-comunicacao-medico`: somente expectativas/contextos com a nova pergunta de entrada.
- `mensagem-falha-emissao`, `processar-conversa-medico`: texto humano de instabilidade e/ou agrupamento; preservadas decisões, bloqueios e asserts de não exposição de detalhes.

Nenhum assert fiscal, de idempotência, de allowlist, de bloqueio de transporte ou de privacidade foi removido/enfraquecido. Nenhum timeout ou teste de worker foi alterado.

## Saídas de validação

- Baseline antes de editar: `npx vitest run --maxWorkers=1`: **1196 passaram, 3 ignorados, 5 falharam**, 67 arquivos, 249,12 s. Três timeouts de Chromium em `tribemd-sync-janela`; dois cenários de `jornada-onboarding` falharam (primeiro com timeout). Logs locais em `work/ux-instabilidade-antes.log`; esse diretório não é commitado.
- Regressões novas antes do código: **5 falharam, 54 passaram**, 2 arquivos, 6,35 s.
- Primeiro conjunto focado após a mudança: **333 passaram, 14 falharam**, por expectativas da UX antiga e sincronização assíncrona no teste novo. Ajustes mantiveram as proteções existentes. Repetição seguinte: **360 passaram, 1 falhou**, restando a expectativa de janela fixa de 90 dias, substituída pela janela da data informada.
- Conjunto focado ampliado: **390 passaram**, 9 arquivos, 33,73 s.
- Todos os arquivos de teste alterados: **556 passaram, 3 ignorados, 0 falhas**, **16 arquivos passaram**, 70,77 s.
- `npx tsc --noEmit`: **código 0, sem diagnósticos** (`work/ux-agenda-gate-tsc.log`).
- Gate completo `npx vitest run --maxWorkers=1`: **1214 passaram, 3 ignorados, 2 falharam**, **66 arquivos passaram**, 204,23 s. As duas falhas foram timeouts de Chromium em `tribemd-sync-janela.test.ts`, que já falhava no baseline; nenhum outro arquivo falhou nessa execução.
- Repetição isolada de `tribemd-sync-janela.test.ts`: **4/4 passaram**, 19,35 s, com 12,42 s nos testes. O usuário fará a validação desse arquivo com `google-chrome` no gate local.
- Uma segunda repetição integral voltou a ter timeouts de Chromium e apresentou um timeout de 5000 ms no cenário de produção de `worker-comprovante` (o arquivo havia passado no gate completo anterior sobre os mesmos fontes). Essa repetição foi interrompida após a flexibilização do gate para a falha ambiental de Chromium; não é declarada verde nem usada como gate concluído.
- Repetição isolada de `worker-comprovante.test.ts`: **9/9 passaram**, 4,31 s, com 2,49 s nos testes. Nenhum teste de worker, assert ou timeout foi alterado.
- Critério de entrega aplicado conforme a última mensagem do usuário: **typecheck limpo + demais 66 arquivos passando**, registrando a falha ambiental isolada do arquivo de Chromium. A suíte inteira não é declarada 100% verde neste sandbox. Não foi necessário rodar com outro pool.
- `git diff --check`: sem erros.

## Verificado versus não exercitado

Verificado com fixtures isoladas: todos os seis comportamentos acima, validação determinística de período, cache em memória com expiração e invalidação, gates preservados antes das leituras, formatação/máscara e continuação de leitura com resultado ou falha explícita. Nenhuma fonte real de agenda, OpenAI real, SEFIN, WhatsApp real ou banco real foi usado nos testes.

Não exercitado: redação com OpenAI real e latência do portal real. O cache e os trabalhos de leitura em fundo são do processo: um reinício descarta ambos. Não foi introduzido um serviço persistente de retries nem retry fiscal automático.

Sem merge, deploy, alteração do app antigo, COFRE_CHAVE, flags, allowlist ou migrations.
