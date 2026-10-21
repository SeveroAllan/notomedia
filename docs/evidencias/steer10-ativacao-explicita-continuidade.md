# STEER 10 — ativação explícita e continuidade manual

Base: c4024c4, branch feat/conversa-etapa1.

## Diagnóstico

O caminho anterior aceitava `semAgendaDigital=true` diretamente da composição da fala. O servidor persistia a marca sem verificar uma declaração na mensagem atual. Uma única resposta errada da IA à saudação era suficiente para gravar a marca e condicionar os turnos seguintes. As fixtures com histórico vazio reproduziram esse caminho tanto para `oioi` quanto para um pedido genérico de emissão.

Não foi usado banco de homolog nem acessada a chamada original da OpenAI. Portanto, a evidência comprova o defeito de confiança no protocolo, não a causa interna da geração do modelo naquele request. Os leitores continuam isolados pelo identificador do médico; não foi constatado vazamento entre médicos.

## Mudança

Somente o conversador muda em produção. Quando há proposta de ativar o modo manual ou contexto manual já registrado, uma revisão restrita por OpenAI verifica separadamente:

- se a fala ATUAL declara explicitamente ausência de agenda digital, inclusive resposta à pergunta sobre agenda;
- se a candidata reapresenta lista de dados, explicação de retroativas/histórico ou confirmação já recebida, inclusive por paráfrase.

A ativação exige JSON estrito da revisão, confiança >= 0,9 e evidência literal não vazia presente na mensagem atual sanitizada. Histórico, resumo e exemplos do prompt não bastam para gravar a marca. O sinal proposto pela composição é substituído pelo resultado dessa verificação; só o sinal verificado chega ao gravador existente. Saudações e pedidos genéricos não devem ativar manual nem receber a orientação de papel.

Com manual já conhecido, o revisor é instruído a continuar o atendimento sem recomeçar a orientação, mesmo se o primeiro pedido de dados saiu da janela recente. Uma candidata rejeitada por ativação indevida, repetição literal ou repetição de orientação recebe uma única regeneração; a nova fala continua sujeita ao schema, limites, sanitização e gates anteriores. Rejeição persistente, resposta inválida ou falha da revisão usam o fallback existente sem gravar marca nem executar ação da candidata descartada. Não foi adicionado classificador de intenção por palavras/regex.

Há uma chamada de revisão por candidata no caminho manual (até duas quando há regeneração). Conversa normal sem proposta de manual e sem contexto manual não faz essa chamada. Não houve alteração de emissão, envio, lote, migrations, Hub, repositório, flags, allowlist ou dedup. Marcas antigas já persistidas não são apagadas por esta entrega.

## Evidência

- Baseline: quatro arquivos relacionados, 244 passaram / 3 ignorados, 18,90 s.
- Teste primeiro: quatro regressões falharam / 160 passaram (duas mensagens sem agenda conhecida, orientação parafraseada em três turnos e evidência tomada do histórico).
- Primeira integração do contrato de revisão: sete fixtures antigas falharam porque só forneciam resposta de composição; 282 passaram / 3 ignorados. As fixtures passaram a fornecer também o JSON da revisão. A expectativa antiga de pedir a lista inteira novamente foi substituída por uma pergunta de um único dado. Asserts de ausência de ações, sanitização, marca, memória e limite de uma regeneração foram preservados; contagens distinguem agora composição e revisão.
- Rodada relacionada após ajuste: cinco arquivos passaram, 289 passaram / 3 ignorados, 44,85 s.
- Rodada final: `npx vitest run tests/conversador-medico.test.ts tests/processar-conversa-medico.test.ts tests/memoria-conversa-medico.test.ts tests/cofre-links.test.ts tests/servidor-conversa-livre.test.ts --maxWorkers=1` — cinco arquivos passaram, 292 passaram / 3 ignorados, 123,42 s, exit 0. `npx tsc --noEmit` — saída vazia, exit 0. Logs brutos locais: `work/steer10-*.log`.

Fixtures cobrem: saudação com histórico vazio e marca falsa proposta pela IA; pedido genérico de emissão perguntando agenda; três turnos sobre papel com lista aparecendo uma única vez; parâfrases rejeitadas; evidência que só existe no histórico recusada; confiança abaixo/em 0,9; resposta explícita curta à pergunta sobre agenda; indisponibilidade da revisão sem ativação; ausência de novos links/ações. Os testes de caminho manual antigos mantêm suas travas com o novo contrato.

## Verificado e limites

Verificado com fixtures isoladas: encadeamento, evidência literal, limiar de confiança, revisão limitada, bloqueios de ação e proteção da marca. Nenhuma chamada real a OpenAI, agenda, banco ou WhatsApp.

A identificação semântica de declaração explícita e de paráfrases permanece na IA revisora; as fixtures controlam sua resposta e não provam acerto do modelo real. A revisão não amplia ferramentas nem autoriza emissão. O teste em homologação continua necessário. O gate completo fica com o solicitante. Sem deploy ou merge.
