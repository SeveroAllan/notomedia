# STEER 8 — link ativo e conversa sem agenda digital

Base: 6199517, branch feat/conversa-etapa1.

## Escopo e escolhas

Pedido A usa a alternativa expressamente permitida de informar que o link anterior continua válido. A URL original não pode ser recuperada do hash armazenado; não foi introduzida persistência do token. Não há criação nem promessa de envio de outro link ativo. A resposta factual também cobre o modelo que pede uma ação bloqueada, eliminando a divergência entre fala e execução.

Pedido B altera o prompt para perguntar qual agenda usa quando ainda não informado, sem alegar suporte a iClinic ou outra integração inexistente. Quando o médico informa papel/WhatsApp, o protocolo retorna `semAgendaDigital=true`; o servidor registra uma marca sem dados pessoais no histórico existente. A marca volta ao contexto mesmo depois de sair da janela recente e reconstruir o repositório. Conexão confirmada pelo backend prevalece sobre a marca antiga.

Nesse contexto o modelo deve reconhecer a informação imediatamente, explicar uma única vez a ausência de histórico/comprovantes antigos e oferecer conferência de CPF, telefone, valor e data, um paciente por vez. Não busca nome/CPF em serviço externo nem executa emissão, envio ou lote. A pergunta “Posso emitir?” apenas coleta intenção nesta etapa. CPF/telefone continuam mascarados pela sanitização existente; não foi criado cadastro/cache nem afrouxada a proteção de credencial. A coleta não verifica CPF nem afirma validação fiscal.

Somente três arquivos de produção: conversador, passagem de contexto e repositório da conversa. Sem alteração em transportes, flags, allowlist, dedup, lote, emissão, migrations ou aplicação antiga. O texto e as travas dos envios existentes não mudam.

## Evidências

Baseline relacionado: quatro arquivos, 230 passaram / 3 ignorados, 30,30 s.
Teste primeiro: três regressões falharam / 149 passaram. Reproduziram promessa de envio sem ação, ausência do protocolo manual e ausência da marca persistida.
A primeira rodada após implementação mostrou dois asserts antigos ligados ao texto anterior e um assert novo que também proibia a menção verdadeira ao envio passado. O texto factual foi simplificado para “O link anterior continua válido; pode usar o mesmo.”; a expectativa antiga de texto foi alinhada. A exigência absoluta de agenda foi qualificada como fluxo automático, conforme a nova exceção solicitada, mantendo os asserts de ausência de ferramentas fiscais e proteção de credenciais.

Validação relacionada: `npx vitest run tests/conversador-medico.test.ts tests/processar-conversa-medico.test.ts tests/cofre-links.test.ts tests/memoria-conversa-medico.test.ts tests/servidor-conversa-livre.test.ts --maxWorkers=1` — 5 arquivos passaram, 277 passaram / 3 ignorados (99,13 s), exit 0. `npx tsc --noEmit` — saída vazia, exit 0. A fixture adicional do link ativo foi executada em rodada isolada do arquivo de links; 55 passaram / 3 ignorados (13,60 s), exit 0. Logs brutos locais em `work/steer8-*.log`.

## Verificado versus limite

Fixtures isoladas cobrem link ativo sem criação, reconhecimento e continuidade manual entre turnos, marca fora da janela recente, coleta sanitizada e ausência de ações, pergunta de agenda desconhecida e regressão com agenda conectada apesar de marca antiga. Mantidos os asserts de segurança anteriores, exceto as exigências de proibição absoluta de coleta manual que este pedido substitui pelo fluxo manual restrito à conversa.

Os testes controlam as respostas do modelo: comprovam protocolo, contexto e bloqueios; não provam a naturalidade da OpenAI real. Sem chamadas reais a banco, agenda, OpenAI, emissão ou WhatsApp. A suíte completa fica para o gate do solicitante. Sem deploy ou merge.
