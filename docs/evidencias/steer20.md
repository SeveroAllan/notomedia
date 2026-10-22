# STEER 20 — confirmação pendente do lote

Base: origin/feat/conversa-v2, 37adbffa89c3229c74307a1e80010b02ec1d1997.

## Causa e correção

`server.ts` já encaminhava `parametros.confirmacao` para `ConversaLoteRetroativo.responder` e retornava `jaRespondida: true`. Quando o modelo omitisse esse campo, a ferramenta não era chamada e a fala não assinada seguia ao médico. Além disso, o conversador recusava `fala: []` mesmo com classificação válida.

- Prompt: item 7 exige a classificação da resposta à pergunta exata, com ação nula; a regra fixa deixa claro que a emissão depende da confirmação registrada pelo sistema. Exemplo de “Pode.” com classificação e fala vazia. Exemplos ilustrativos foram compactados para preservar o teto; itens 2b, 9, 10 e 11 e o exemplo “Certo.” continuam. Tamanho final: 6.477 caracteres.
- Conversador: aceita fala vazia com confirmação estruturada apenas diante de lote aguardando confirmação, ação nula/nenhuma e sem resultado de ferramenta. Fora disso, preserva a proteção de resposta vazia.
- Conversa: mensagem do médico com lote aguardando e sem classificação pede uma única correção (`preencha parametros.confirmacao sobre a pergunta pendente`). Se faltar novamente, descarta toda a fala do modelo e reenvia a pergunta do servidor. Reutiliza a pergunta exata, em um balão, preservando quantidade, total e ambiente; não extrai números nem inventa novo escopo. Sem pergunta disponível, usa o erro técnico já existente.
- Mantido o teto de duas chamadas: a correção de anúncio também verifica o orçamento antes de tentar novamente. A confirmação segue exclusivamente pelo executor existente e sua resposta oficial, via `jaRespondida`; nenhuma fala paralela do modelo é enviada.

Sem alteração em `server.ts`, cofre, lote, emissão, worker, SQL, gates, reservas, TTL, confiança ou vínculo da pergunta. Nenhum teste existente foi removido ou teve suas asserções alteradas.

## Testes adicionados

- `tests/conversador-medico.test.ts`: aceita fala vazia com classificação somente no estado pendente; prompt exige `DEVE preencher parametros.confirmacao`, remove a proibição enganosa e respeita 6.500 caracteres.
- `tests/processar-conversa-medico.test.ts`: três cenários com zero, uma ou duas omissões. Verifica orçamento, encaminhamento da classificação, pergunta reenviada sem efeito quando necessário e ausência da afirmação inventada tanto no envio quanto na memória.
- `tests/servidor-conversa-livre.test.ts`: os mesmos três cenários pelo servidor, com `acoesPermitidas=['nenhuma']`, resposta “Pode.” e `ConversaLoteRetroativo.responder` real. Banco e transporte são fixtures. Confirma chamada ao método e ao registro existente quando há classificação; após duas omissões, mantém o lote aguardando e envia só a pergunta. Não executa worker ou emissão.

## Evidência

- Antes: `npx tsc --noEmit` limpo; `npx vitest run --maxWorkers=1`: 69 arquivos, 1.200 passaram, 3 ignorados (94,93 s).
- Reprodução antes da implementação: os oito testes novos falharam, sem mudar o código de produção (`-t 'STEER 20'`; demais cenários não selecionados).
- Após a implementação: tsc limpo; arquivos focados completos: 164 passaram, zero falhas (6,47 s).
- Gate completo final: `npx tsc --noEmit` limpo; `npx vitest run --maxWorkers=1`: 69 arquivos, 1.208 passaram, 3 ignorados, zero falhas (73,86 s). Nenhum arquivo foi excluído por falha ambiental.

Verificado: encaminhamento real da confirmação no wiring existente, supressão da fala não assinada, pergunta segura após duas omissões e teto de chamadas, com fixtures sem rede. As travas fiscais continuam cobertas pelos testes anteriores. Não foi feito replay com OpenAI real, envio real, consulta a banco real, deploy ou merge. A frequência de omissão do modelo em homolog ainda depende do reteste; o bloqueio determinístico cobre a omissão mesmo quando o prompt falha.
