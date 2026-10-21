# STEER 7 — lote retroativo em homologação, somente simulação

Base `b1b9a09`. Desenho apresentado antes da implementação. Baseline local: `npx vitest run --maxWorkers=1`, 62 arquivos, **1062 passaram, 3 ignorados, zero falhas**, 60,06s (`work/steer7-before.log`).

O pós-conexão aguarda a sync e sua gravação antes de abrir o estado `aguardando_data_inicio`. O classificador OpenAI recebe o relógio de São Paulo e texto sanitizado; a validação determinística exige data civil válida, até hoje e no máximo 90 dias atrás. Sem chave/JSON válido, pede confirmação da data e não consulta/cria seleção.

`contarConsultasPeriodo` lê realizadas do médico desde o início até o instante do evento, exclui `nota_gerada` pelo mesmo HMAC `chaveConsulta` e separa ausência de valor. Números apresentados pelo conversador são formatados deterministicamente a partir desse resultado: não podem ser trocados pelo modelo.

Escolha de implementação: existe um rascunho nas tabelas de lote antes do sim. É necessário congelar os ids exatamente da contagem apresentada; esperar o sim para selecionar novamente incluiria consultas que chegaram depois. Só a confirmação altera o estado para `confirmado`. A seleção não é refeita. Valor individual não é guardado no lote: uma assinatura HMAC do valorConsulta já existente permite detectar divergência no detalhe ao vivo. São guardados ids, hashes, período, totais e estados, nunca nome/CPF/valorCobrado.

Confirmação exige resposta citando o id Evolution da pergunta efetivamente enviada, intenção OpenAI `sim` com confiança >=0,9 e TTL de 48h. CAS no estado, unicidade da resposta, reserva inbound já existente e um lote ativo por médico impedem re-sim/reentrega concorrente. Callback só vincula a pergunta após envio protegido. Sem citação correta, não há confirmação. Recusa forte encerra o rascunho.

O worker embutido tem uma entrada de execução de lote, distinta da fila de emissão real. Reserva o lote com `FOR UPDATE SKIP LOCKED`, cada item atomicamente e tem índice de consulta única para itens processando/simulados. Item incerto após interrupção não é retomado automaticamente; requer conferência, preservando a prevenção de repetição.

A cada item autorizado, lê detalhe fresco pelo navegador/sessão da agenda, encontra o atendimento e descarta o resultado após extrair nome/CPF/valorCobrado em memória. Não faz backfill nem atualiza pacientes. Revalida nome civil, dígitos de CPF e valor, compara assinatura com o valor autorizado e reconsulta `nota_gerada` depois da leitura de rede. Faturada nesse intervalo é pulada. Valor ausente/divergente ou dado incompleto não é simulado. A pergunta de valor é agregada e orienta conferir a agenda.

A integração fiscal desta entrega é **simulada**: usa validação transitória no adaptador fiscal e exige ambiente homologação; não chama `emitir`, não gera DPS/XML/PDF, não grava `nota_gerada` e não envia a pacientes. Resumo diz `Simulei`, nunca `Emiti`. Gravar nota gerada em uma simulação tornaria o histórico fiscal falso. O caminho individual real preexistente não foi liberado/adaptado para emissão real de lotes nesta etapa. Testes não demonstram autorização SEFIN, tributação ou emissão jurídica; isso permanece fora da execução autorizada agora.

Gates: reusa `EMISSAO_COMPROVANTE_HOMOLOGACAO_ATIVA`, conversa livre e `ComunicacaoHomologacao.medicoPermitido` (flag de envio, ambiente homologação e allowlist). Revalida antes de cada item. Não muda valores de flags, allowlist, dedup ou envio a paciente. Perguntas/resumos passam pela reserva global de mensagem e transporte existentes. Nenhum nome/CPF do detalhe vai a log, memória ou tabelas do lote.

Migration **somente preparada**: `scripts/migrations/20261024-lotes-retroativos-homologacao.sql`. Duas tabelas com FK, constraints/índices de unicidade, RLS ativada e revoke de anon/authenticated. Deve ser aplicada manualmente antes de habilitar o fluxo no servidor. Não executada pelo Codex.

Testes novos em `lote-retroativo.test.ts` e `lotes-postgres.test.ts`: data/typos com relógio local e JSON estrito; fluxo data-contagem-confirmação-worker-resumo; sem referência, expirada, recusa/baixa confiança; re-sim/reexecução/concorrência; faturada entre confirmação e execução; sem valor e valor divergente; contratos SQL/HMAC/snapshot/migration; adaptação fiscal sem escrita/transmissão.

Testes existentes ampliados, sem remover asserts: `passo12-cofre` comprova detalhe fresco sem envelope persistido; `passo12-envio-medico` cobre callback com id Evolution, gates e reentrega; `processar-conversa-medico` cobre ordem sync-data, erro incompleto e credencial interceptada antes da IA; `servidor-conversa-livre` liga evento, classificador, citação Evolution, worker e resumo, sem PDF/emissão. A única falha na bateria ampliada era um novo assert que tratava `ler()` como objetos em vez de `string[]`; corrigido para o contrato existente. Nenhuma falha legada foi escondida.

Evidência de teste primeiro do executor: import falhou enquanto o módulo ainda não existia (`work/steer7-red.log`). Bateria relacionada após implementação: **234 passaram, zero falhas**; cenário adicional do servidor: arquivo inteiro **35 passaram**. Typecheck final limpo.

Verificado com fixtures, bancos e transportes falsos. Não verificado PostgreSQL real, portal real, OpenAI real, SEFIN ou Evolution. Não houve migration executada, envio real, merge ou deploy.

Gate completo final: `npx tsc --noEmit` limpo; `npx vitest run --maxWorkers=1` — **64 arquivos passaram; 1101 testes passaram, 3 ignorados, zero falhas**, 80,65s (`work/steer7-full.log`). `git diff --check` limpo.
