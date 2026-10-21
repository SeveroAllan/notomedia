# STEER 6 e 6c — pendências após sync e nome ao vivo

Base: `3ccf500` (STEER 5 já publicado). Nenhuma implementação do 6b foi feita: não havia código de persistência de nome/CPF/valor cobrado nem migration/backfill a reverter. A sync mantém paciente mínimo por telefone e valor da consulta, sem ampliar o banco.

Plano executado: transmitir nome transitório pela fonte existente; esperar leitura e salvamento antes de consultar pendências; resolver pelo id externo do atendimento; usar telefone mascarado quando não houver nome; corrigir afirmações de ausência e remover promessa de janela indisponível; auditar somente metadados. Reutilizados fonte, repositório, pipeline e transporte atuais.

A fonte entrega `nomeAoVivo` da listagem semanal, com fallback para nome completo do detalhe. Esse campo não entra no INSERT de consultas nem atualiza pacientes. A ferramenta cruza ids externos com a leitura recém-concluída. O WhatsApp recebe o nome transitório; a memória da resposta troca os nomes por `[PACIENTE]`. Não foram adicionados CPF, valor cobrado, coluna ou tabela.

A sincronização fica serializada por médico e a leitura de pendências aguarda tanto a fonte quanto o salvamento. Leitura incompleta retorna estado próprio e fala de leitura em andamento. Uma leitura completa vazia ainda consulta o banco, em vez de concluir zero antes da consulta. O critério de faturamento continua o mesmo do comprovante.

Zero só é afirmado com resultado confirmado `ok=true`, `total=0` e lista vazia. Resultado positivo contradito pela fala do modelo vira total positivo e identificação segura. A janela continua 90 dias; removida a oferta de períodos anteriores. Auditoria `FERRAMENTA_AGENDA_RESULTADO` contém ferramenta, médico, resultado, motivo, total, quantidade e janela; não contém nomes, CPF, telefones nem conteúdo bruto.

Testes alterados: conversador preserva segurança e cobre sync incompleta, negativa sem zero e remoção da oferta; fonte/repositório cobre nome ao vivo, fallback mascarado e ausência de escrita; cofre verifica novo campo transitório e leitura incompleta; processador/servidor atualizam apenas o texto de zero e leitura em andamento. Novo cenário do servidor bloqueia fonte e INSERT separadamente, comprova ordem antes de listar 173 pendências, ausência de contradição, nome enviado sem persistência e auditoria sem nome. Asserts de faturamento, gates, credenciais, dedup e idempotência preservados.

Antes da implementação, novos testes falharam: 4 falhas, 89 passaram (`work/steer6-red.log`). Primeira bateria após implementação: 2 falhas, 205 passaram; eram o assert antigo que proibia leitura de telefone agora usado mascarado e o fake que não modelava a consulta persistida após sync vazia. Corrigidos sem remover proteção de dados na fala. Bateria relacionada: **208 passaram, zero falhas**. Typecheck final: **limpo**. Teste adicional de oferta indisponível: arquivo do conversador **63 passaram**.

Verificado com banco/fonte/IA/transporte simulados. Não executados banco real, migration, envios reais, merge ou deploy. A leitura ao vivo entregue aqui atende à listagem de pendências. O pipeline fiscal de oportunidade/emissão ainda exige os dados cadastrais e sua revalidação atuais; não foi alterado para aceitar dados transitórios nesta correção. Essa integração fiscal permanece pendente e não deve ser presumida concluída.

Suíte completa: `npx vitest run --maxWorkers=1` — **62 arquivos passaram, 1062 testes passaram, 3 ignorados, zero falhas**, 79,53s. O teste adicional de remoção da oferta foi validado na repetição focada final (63 testes do conversador); não houve mudança funcional depois do início da suíte completa.
