# Lote solicitado pela conversa após a listagem de pendências

Base: `be28282df9d8cc3d2dce3f77945a97d73bc76241`, branch `feat/conversa-etapa1`.

Problema: com agenda conectada e período já conhecido, o pedido atual de emissão era classificado como verificação. O médico recebia a mesma lista e nenhum lote era aberto.

## Mudança

O classificador OpenAI existente passa a distinguir pedido atual de emissão de uma nova verificação, incluindo typos e contexto. O campo booleano `emitir` apenas solicita a abertura de uma proposta: nunca confirma, enfileira ou emite uma nota. Quando presente, `verificar` é normalizado para false; mesmo um resultado com ambos true não segue para a listagem comum. Sem executor fiscal disponível, não converte emissão em verificação.

`processarComunicacaoMedico` encaminha esse pedido ao retroativo. O período vem do contexto persistido de pendências (ou de uma data atual interpretada e validada pela mesma regra de início). Com início válido, abre o lote, prepara a contagem real e registra a nova pergunta vinculada com o ID retornado pelo transporte. Sem início válido, pergunta a data. Um novo pedido enquanto aguarda data não cria outro lote nem fica sem resposta.

A preparação da contagem foi reaproveitada em um método do controlador existente. No caminho com período conhecido, a leitura ao vivo ainda acontece para congelar o valor cobrado atual; não se usa cache de paciente nem valor persistido como substituto. Essa leitura pode levar tempo, mas sua lista não é reenviada: o resultado alimenta a contagem e a pergunta de confirmação. O modo sem lista também se propaga à continuação após uma sincronização incompleta. Avisos de demora continuam condicionados à leitura demorada e usam a variação existente.

A resposta a uma pergunta de lote pendente tem prioridade sobre o classificador de verificação. Assim, um “sim” simples continua vinculado à pergunta atual, sem nova listagem/contagem. Permanecem TTL de 48h, confiança >=0,9, rejeição de citação antiga, um lote ativo, dedup e reserva do worker. O pedido inicial de emissão NÃO é a confirmação da nova proposta. O status de um lote já confirmado alterna a formulação com base na última fala persistida, sem repetir texto idêntico consecutivamente.

## Testes

Antes: `npx vitest run --maxWorkers=1`: **67 arquivos, 1165 passaram, 3 ignorados, 0 falhas**, 91,81s.

Testes escritos antes da correção: **10 falharam, 50 passaram** nos dois arquivos unitários. Reproduziram consumo de emissão como verificação, falta de reutilização do período, reenvio de lista na contagem e status repetido. O cenário adicional de segundo pedido sem período também falhou antes de tratar a continuação da pergunta de data.

- `tests/pendencias-medico.test.ts`: emissão tem prioridade mesmo com verificar=true; período conhecido versus ausente; ausência de executor; contagem sem reenviar lista; protocolo OpenAI e contexto para três formulações, incluindo typo. Os testes anteriores e suas travas permanecem.
- `tests/lote-retroativo.test.ts`: período conhecido abre direto na contagem/pergunta; ausência/data inválida pede início; leitura ao vivo é passada à contagem; gate fechado impede execução; pedido inicial não confirma; “sim” posterior usa o ID da pergunta; status consecutivos variam; pedido sem período não fica mudo. Preservados testes de TTL, citação, baixa confiança, idempotência, assinatura, worker e privacidade.
- `tests/servidor-conversa-livre.test.ts`: cenário via webhook com 173 consultas e agenda conectada, em três formulações. Verificação → lista; emissão → lote/contagem/pergunta com o mesmo período; sim simples → confirmação única. Reentrega do mesmo ID não repete confirmação; o sim não relê agenda. Nomes da lista aparecem como `[PACIENTE]` na memória. As fixtures explicitam ausência de confirmações individuais de comprovante e de reenvios pendentes; esses fluxos não são alterados.

Gate final:

- `npx tsc --noEmit`: saída vazia, exit 0.
- `npx vitest run --maxWorkers=1`: **67 arquivos, 1181 passaram, 3 ignorados, 0 falhas**, 137,84s, exit 0.
- `git diff --check`: limpo.
- Evidências locais em `work/lote-conversa-antes.log`, `work/lote-conversa-red.log`, `work/lote-conversa-cenario.log`, `work/lote-conversa-tsc.log` e `work/lote-conversa-depois.log` (diretório ignorado).

O cenário integrado passou nas três formulações. As queries de confirmações individuais/reenvios, que não fazem parte deste cenário, foram explicitadas como vazias nas fixtures. Nenhum assert anterior foi removido ou relaxado; nenhum timeout foi alterado.

## Verificado e limites da evidência

Verificado com fixtures isoladas: roteamento e protocolo, pergunta vinculada, contagem com valores transitórios, bloqueios, não reenvio da lista, dedup e memória mascarada. O classificador usa OpenAI; não foi introduzido reconhecimento de intenção por regex. Os testes de linguagem simulam a resposta da IA e validam seu contrato/prompt; não comprovam comportamento de OpenAI real.

Nenhuma mudança em flags, allowlist, emissão individual, worker fiscal, contato criptografado, dados do tomador, pipeline de entrega ou migrations. Não foi persistido nome/CPF/valor cobrado em cadastro/cache. Nada foi executado contra agenda, banco, OpenAI, SEFIN ou transporte reais. Sem merge ou deploy.
