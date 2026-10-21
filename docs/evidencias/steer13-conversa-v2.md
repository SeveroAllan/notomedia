# STEER 13 — conversa v2

Branch criada em `6a05883`; nenhum código do `9deb944` foi aplicado.

## Etapa 1 — interface textual do link (`70bfb1b`)

`LinksCofre.solicitarLinkCofre` aceita `fala` do chamador e acrescenta a URL ao final. O fallback legado permanece para chamadores anteriores. Duas linhas de implementação alteradas; transação, criação/invalidação de token, prazo, limite, gates, auditoria e transporte intactos.

Teste novo de interface confirma a fala, URL final e rejeição do segundo uso do mesmo token. Nenhuma asserção de execução/trava removida ou relaxada.

Validação: `tsc --noEmit` limpo; foco de cofre 56 passaram/3 ignorados; suíte serial sem o arquivo ambiental: 68 arquivos, 1249 passaram/3 ignorados, 241,83s. Saídas locais `work/steer13-etapa1-*`.

A execução completa reproduziu dois timeouts do Chromium em `tribemd-sync-janela`. A rodada concorrente também estourou timeouts em testes de lote/onboarding; a repetição serial passou sem mudar timeouts/testes. O primeiro comando de baseline começou antes da alteração, mas carregou o novo teste de interface ainda com implementação antiga em cache: esse teste falhou nessa rodada e passou no foco e no gate serial. Não se apresenta essa rodada como baseline verde.

## Etapa 2 — interface de resultado do lote (`a416651`)

A contagem pode ser narrada por callback com período, números e pergunta de confirmação assinada. Sem callback, o texto e o fluxo anteriores permanecem. Nenhuma condição de preparo, confirmação, TTL, reserva ou executor mudou; nenhum SQL protegido mudou. Os dois testes novos conferem contagem, preparo, ausência de confirmação e registro da pergunta somente quando há consultas elegíveis.

Validação: `tsc --noEmit` limpo; gate serial sem o arquivo ambiental: 68 arquivos, 1251 passaram/3 ignorados, 384,08s (`work/steer13-etapa2-*`).

## Etapa 3 — decisão única da conversa

A conversa ativa usa um decisor, histórico/resumo do contrato existente, fatos estruturados e ações fechadas. O servidor valida a ação e só admite uma segunda chamada após resultado de ferramenta (incluindo recusa assinada). Resumo permanece separado. A introdução do primeiro link vem da primeira decisão; o servidor valida os fatos obrigatórios antes de chamar LinksCofre. Link ativo não cria outro token. Aliases de TribeMD e calendário relativo usam normalização/cálculo puro; em 21/10/2026, semana retrasada inicia em 05/10, semana passada em 12/10 e mês passado em 01/09.

A cascata de classificadores sai do caminho V2. Compatibilidade com flag desligada continua usando o fluxo anterior. A interpretação de confirmação individual e de lote reutiliza a decisão única, passando pelas mesmas validações determinísticas existentes. A pergunta de lote observada antes da IA fica vinculada pelo ID já aceito pelo executor; mudança concorrente da pergunta não reaproveita autorização. A assinatura fiscal, TTL de 48h, reserva e SQL não foram alterados.

Listas usam o formatador determinístico existente; a IA só fornece moldura, sem receber nomes ao vivo nos resultados. O texto mascarado continua indo à memória pelo contrato atual. A contagem zero recebe diagnóstico somente de IDs/contagens para distinguir ausência de consultas de consultas já faturadas. Nenhum cache/cadastro de paciente ou migration foi criado.

Métricas: prompt estático anterior 21.810 caracteres; atual 1.873. Linhas: conversador 187 → 118; processar comunicação 291 → 160; server 1.003 → 1.073. No fluxo anterior havia até quatro chamadas por mensagem; V2 faz uma sem ferramenta e no máximo duas com resultado, sem contar resumo. Testes medem esse orçamento, inclusive na confirmação fiscal.

O inventário por arquivo e título dos testes substituídos está em [steer13-testes-substituidos.md](steer13-testes-substituidos.md). Testes de execução de cofre, lote, emissão, worker, transporte, reserva e memória foram preservados. As fixtures de integração foram adaptadas ao protocolo novo, à ausência dos avisos/frases removidos e ao menor número de chamadas. As verificações de valores, autorização, gates, máscara e dedup permanecem. Novos cenários cobrem data+Tribe, manual por etapas, link ativo, recusa, fora de escopo, sync parcial, zero consultas/todas faturadas, ação inválida, credencial antes da IA, isolamento de nomes e mudança concorrente da pergunta fiscal.

### Escolhas conservadoras e limites

- O contrato de memória permanece intacto: mesmos limites, consultas, IDs e resumo. Não aumentei a janela nem regravei marcas antigas; o consumidor filtra a marca sintética legada da apresentação ao modelo.
- A pergunta positiva do lote conserva o texto fiscal assinado anterior; a IA narra resultados sem alterar escopo/valor da autorização. O aviso fiscal contido nessa pergunta não foi removido. Para aviso conversacional de homologação, a evidência vem do histórico/resumo disponível; não há garantia de lembrança perpétua depois que essa evidência sair da janela.
- Classificadores legados permanecem para caminhos fora da conversa V2. Reenvio fiscal a paciente não foi exposto entre as ações novas; o executor existente permanece intacto.
- Sync fria pode atrasar a resposta; não acrescentei aviso fixo antecipado nem alterei a sincronização.
- Os cenários usam modelo/serviços falsos e fixtures isoladas. Tom e qualidade com OpenAI real não foram comprovados; nenhuma agenda, banco, emissão ou envio real foi executado.
- A busca por “Vi que você ainda não conectou a agenda” não identificou essa frase fixa no src; nenhuma mudança de lembrete fora da conversa foi feita.

### Evidência do gate

A primeira rodada completa desta etapa apontou oito falhas: sete de compatibilidade do caminho legado (contexto RAM/sanitização restaurados no código, sem editar esses testes) e uma expectativa de log de credencial na fixture nova. Chromium passou nessa rodada. Nenhum timeout foi alterado.

Rodada de integração posterior: `tsc --noEmit` limpo, Vitest completo serial 69 arquivos, 1155 passaram/3 ignorados em 318,66s, sem falha ambiental (`work/steer13-etapa3-gate2-*`). O teste isolado de troca concorrente de pergunta passou (1/1). Gate final executado novamente com o código congelado; resultado abaixo.

### Verificado versus não comprovado

Verificado em fixtures: ações fechadas e assinadas, orçamento de chamadas, calendário de São Paulo, alias de agenda, conservação do período, marca manual com declaração atual, primeiro link contextual, link ativo sem criação, dados mascarados, dedup/reentrega e confirmação vinculada. O diff contra `6a05883` está vazio em `src/whatsapp`, `src/io/postgres`, `src/io/fiscal`, `src/worker`, `src/agenda`, `memoria-conversa.ts` e migrations.

Não comprovado aqui: qualidade das respostas com OpenAI real, conexão/portal real, emissão SEFIN e entrega real. Nenhum desses serviços foi chamado. A validação de naturalidade em homolog fica para a bateria do usuário após revisão; não houve deploy nem merge.

Gate final (código congelado): `npx tsc --noEmit` limpo; `npx vitest run --maxWorkers=1`: **1155 passaram, 3 ignorados e 1 falhou**, 68 arquivos passaram/1 falhou, 259,70s. A única falha foi o timeout de 5000ms em `tribemd-sync-janela.test.ts`, cenário Chromium “não retrocede”, arquivo e implementação intactos; aplica-se a exceção ambiental definida para esse arquivo. Os demais testes passaram, incluindo a regressão nova de pergunta alterada durante a IA. Nenhum timeout/teste do Chromium foi modificado. A rodada final não é apresentada como suíte integral verde. Saídas locais: `work/steer13-etapa3-final-tsc.log`, `work/steer13-etapa3-final-vitest.log` e `work/steer13-corrida.log`.
