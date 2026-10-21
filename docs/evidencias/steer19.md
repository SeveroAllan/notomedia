# STEER 19 — anúncio e continuidade

Base: origin/feat/conversa-v2, 6604479. Sem merge, deploy, banco ou serviços reais.

## Escopo e evidência

- Commit 1483ab1: confirmação informa quantidade, homologação e próximo passo; fechamento separa emissão, entrega, falta de contato e ação necessária. Nos dois arquivos de lote, somente composição textual mudou: contadores, condições operacionais, reservas e execução foram preservados.
- Segundo commit: prompt com anúncio contextual antes da ação e responsabilidade pelo próximo passo; exemplos de agenda desconhecida, Tribe e papel restaurados. Itens 2b e 9 e exemplo “Certo.” mantidos. Prompt: 6.305 caracteres, teto 6.500.
- Ação sem fala não executa: o rascunho preserva a ação e pede uma correção com motivo interno `anuncie a acao com suas palavras`. Uma segunda resposta vazia é recusada, sem terceira chamada.
- Listar/iniciar lote envia o primeiro balão da decisão antes da ferramenta, pela comunicação protegida existente. O anúncio usa sufixo `:anuncio`, também na memória, para não consumir a identidade do resultado. A lista continua com até dois balões assinados; anúncio + lista cabem em três. No link, a introdução continua enviada pelo caminho existente, uma única vez.
- Nenhuma frase de anúncio ou regex para julgar seu estilo foi acrescentada. Cofre, SQL, execução fiscal, flags, allowlist, reservas e travas não foram alterados. Nenhum teste foi removido.

## Item 7: alternativa conservadora autorizada

Entregue somente a regra de prompt “quem faz o que a seguir”. Não foi criado `proximoPasso` no schema nem retry por ausência desse campo. Torná-lo obrigatório atingiria também respostas sem ação e narrações de ferramentas; seu retry concorreria com a correção do anúncio e o resultado da ferramenta no orçamento existente de duas chamadas. Mantido esse orçamento, conforme a alternativa permitida no pedido. Portanto, a presença semântica de próximo passo depende do modelo; não é garantia determinística nem foi validada com OpenAI real.

## Testes existentes ajustados

Somente expectativas afetadas pelo novo texto/ordem, sem remover proteção:

- `tests/lote-retroativo.test.ts`: “pergunta data, conta valores reais, confirma e não confirma duas vezes” (anúncio no turno autorizado); “worker emite uma vez com emissor falso, pula faturada após confirmação e agrega ausência de valor”; “fluxo da conversa até o worker mantém valores congelados e produz resumo real com emissor falso”; “resumo conta emissão, entrega e falta de contato separadamente sem nomes nem códigos”; “retomada preserva resultados anteriores e libera a sessão mesmo se o gate lançar”; “lote recuperado continua só os itens prontos e resume também as notas anteriores à queda” (textos novos, mesmos resultados e contagens).
- `tests/conversador-medico.test.ts`: teste de autocorreção/tamanho conserva o teto 6.500; sai apenas o incremento de 900 caracteres específico do STEER 18, substituído pelo teto explícito do STEER 19.
- `tests/processar-conversa-medico.test.ts`: “lote sem elegíveis” (dois cenários) agora verifica anúncio seguido do resultado, com chaves diferentes.
- `tests/servidor-conversa-livre.test.ts`: leitura real protegida; evento de conexão; conclusão aguardando leitura e salvamento; wiring do lote pós-sync; pedido atual após lista (três variantes); data pós-conexão; resultado sem elegíveis (dois cenários); nome-injeção. Incluem o anúncio anterior e deslocam índices da pergunta/identidade Evolution mantendo confirmação vinculada, dedup, privacidade, totais e bloqueios.

Novos testes: ausência do texto antigo de autorização; prompt sem slogans fixos; três ações sem anúncio; três correções únicas antes de executar; segunda resposta vazia sem efeito; ordem anúncio/execução, memória e reentrega sem repetição.

## Gate

- Referência: tsc limpo; 69 arquivos, 1.190 testes passaram, 3 ignorados (118,00 s).
- Primeiro commit: tsc limpo; 69 arquivos, 1.191 passaram, 3 ignorados (97,79 s).
- Durante implementação: o teste novo da confirmação inicialmente procurava o anúncio na última fala após re-sim; corrigido para verificar sua presença no turno autorizado. Focados também detectaram expectativas antigas de ordem/contagem; uma asserção antes da liberação de uma fixture interrompeu a liberação e causou timeouts em cascata. Não houve alteração de timeout ou descarte de falhas.
- Gate final do segundo commit: `npx tsc --noEmit` limpo; `npx vitest run --maxWorkers=1`: 69 arquivos, 1.200 passaram, 3 ignorados, zero falhas (97,15 s). Nenhuma exclusão ambiental foi necessária.
- Uma execução completa iniciada durante a ampliação da cobertura de `fala` ausente terminou com 1.197 passando e três falhas do teste novo contra o schema anterior em cache. Foi repetida com os arquivos estabilizados; o resultado final acima cobre campo ausente, lista vazia e somente espaços.

Verificado por fixtures isoladas: validação, correção única, ordem dos efeitos, memória, idempotência e gates cobertos pela suíte. Hipótese a validar em homolog: naturalidade e variação efetivas das falas do modelo real. Nenhum envio ou emissão real foi executado.
