# STEER 11 — recuperação das guardas sem fallback genérico

Base: 7212f2a, branch feat/conversa-etapa1.

## Causa verificada

O conversador lançava `RESPOSTA_REJEITADA` após a segunda rejeição. Esse erro, falhas da revisão e erros ao ler o JSON da regeneração caíam no mesmo catch, que devolvia o fallback sem log. A fixture das cinco falas reproduziu o sintoma: oi normal, fallback no pedido genérico, orientação manual correta, fallback nas duas perguntas seguintes.

Isso comprova o defeito dos caminhos de falha. Sem o log da chamada real da OpenAI, não é possível identificar qual guarda/erro ocorreu em cada request do homolog. A nova observabilidade diferencia esses caminhos.

## Mudança

O schema e os gates continuam iguais: candidata inválida nunca é aceita nem executa ação. Rejeição por JSON/schema, repetição literal, orientação repetida, declaração não confirmada, falha da revisão ou proposta do próprio fallback recebe uma única regeneração. Se ainda rejeitar, ou se a regeneração falhar, há uma pergunta útil baseada apenas no contexto confiável: qual agenda usa quando desconhecida, um dado do paciente no manual já conhecido/declaração verificada, ou uma pergunta sobre o que conferir com agenda conectada. A alternativa não executa ação, não promete emissão/envio e evita repetir a última pergunta.

A declaração só acompanha a alternativa se já foi confirmada pela revisão com evidência literal atual e confiança alta. Falha da revisão não cria marca. A lista completa de dados não reaparece na alternativa manual. O caminho existente de link ativo continua intacto.

O fallback literal permanece para falha técnica inicial sem candidata, como API indisponível ou IA não configurada. Agora registra `CONVERSA_FALLBACK_USADO` com etapa e categoria fixa de erro. Também há `CONVERSA_GUARDA_REJEITOU`, `CONVERSA_REVISAO_FALHOU`, `CONVERSA_REGENERACAO_FALHOU` e `CONVERSA_ALTERNATIVA_USADA`. Nenhum desses logs copia texto do médico/modelo, `Error.message`, issues do schema, nome, CPF, telefone ou credencial. As categorias são internas; médico não vê códigos.

Um único arquivo de produção alterado: conversador. Sem mudança em emissão, envio, lote, migrations, Hub, flags, allowlist, transporte, dedup ou repositório.

## Testes e evidência

- Baseline relacionado: quatro arquivos, 251 passaram / 3 ignorados, 22,14 s.
- Testes primeiro: quatro regressões falharam / 167 passaram, incluindo as cinco falas exatas na ordem, ação fiscal inválida, fallback proposto pela IA e ausência de log técnico seguro.
- Primeira integração: 274 passaram / 3 ignorados; 22 expectativas antigas exigiam justamente o fallback removido para guardas. Foram atualizadas conforme o novo contrato, sem relaxar schemas, limites, ações ou assert de reentrega.
- Rodada final: `npx vitest run tests/conversador-medico.test.ts tests/processar-conversa-medico.test.ts tests/memoria-conversa-medico.test.ts tests/cofre-links.test.ts tests/servidor-conversa-livre.test.ts --maxWorkers=1` — cinco arquivos passaram, 296 passaram / 3 ignorados, 60,12 s, exit 0. `npx tsc --noEmit` — saída vazia, exit 0. Logs brutos locais em `work/steer11-*.log`.

Alterações nos testes antigos:

- Saídas inválidas/ação ou intenção fora do protocolo continuam rejeitadas, agora com alternativa sem ação e no máximo duas composições.
- Pedido fiscal continua sem ferramenta fiscal, sem alegar sucesso; a pergunta alternativa depende do estado real de conexão.
- Segunda resposta repetida/inválida continua sem terceira tentativa, agora com pergunta útil.
- Falha da revisão continua sem ativar manual/marca e tenta uma regeneração antes da alternativa.
- No processador, regeneração válida é enviada e persistida; erro técnico inicial continua com fallback. No servidor, quatro balões continuam inválidos e não são enviados; a alternativa substitui o fallback, preservando gate e dedup da entrega.

A fixture principal usa exatamente: `oi`; `quero emitir minhas notas`; `não tenho agenda digital, uso agenda de papel mesmo`; `minha agenda é de papel, não tem sistema. como eu emito a nota assim?`; `ok, e o que eu mando primeiro?`. Força declaração indevida, rejeição repetida, revisão inválida e JSON inválido na regeneração. Exige cinco respostas úteis distintas, zero fallback, lista completa uma única vez, marca só a partir da declaração explícita e nenhum link/ação executado.

## Verificado e limites

Fixtures verificam recuperação, limite de tentativas, manutenção da marca explícita e dos bloqueios, conteúdo persistido, dedup, logs por categoria e ausência de dados pessoais no log. Falas e revisões de IA são controladas; a bateria real continua necessária para aferir o modelo. A alternativa determinística é usada somente quando a guarda não consegue produzir uma candidata válida. Nenhuma chamada real de OpenAI, banco, agenda ou WhatsApp. Suíte completa fica para o gate do solicitante. Sem deploy ou merge.
