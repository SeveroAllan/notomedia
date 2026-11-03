# Decisão arquitetural — agenda sob demanda, sem cadastro de pacientes

Status: proposta para implementação consolidada. Não executar deploy nem ativar emissão antes de testes e autorização.

## Decisão
- TribeMD/Amplimed continuam sendo a fonte de verdade dos pacientes e das datas de consultas.
- Subagente de agenda lê a origem sob demanda e entrega ao fiscal apenas os campos necessários para o processamento da NFS-e, em memória e por canal interno autenticado.
- **Não persistir** cópia de pacientes, agendamentos, slots, mensagens contendo dados clínicos ou dados do tomador em tabelas operacionais. Desativar escrita/leitura de `pacientes`, `agendamentos`, `agenda_slots`, `pagamentos` e quaisquer fluxos de sincronização que materializem essas informações.
- Não apagar tabelas existentes até mapear dependências e migrações, para evitar perda e quebra. Elas existem no novo banco, porém estão vazias. Corrigir a migração 06 ainda não aplicada para **não** criar `agenda_slots` e `pagamentos` sem necessidade.
- Metadados fiscais legalmente obrigatórios, XML e recibos podem exigir retenção protegida. Não confundir ausência de cadastro de paciente com ausência total de dados pessoais em documento fiscal.

## Contrato agenda → fiscal (efêmero)
`{contaId, medicoId, origemAgenda, referenciaConsulta, inicioConsulta, fimConsulta?, profissionalIdentificado, dadosTomador, descricaoServico, valorCentavos, comprovacaoAtendimento}`

Os dados do tomador são acessados apenas no momento da emissão e não devem aparecer em logs, telemetria, prompts persistidos ou histórico conversacional.

## Idempotência
- Exigir `medicoId` confirmado, `origemAgenda`, `referenciaConsulta` estável e data/hora da consulta; **data isolada não identifica uma consulta**.
- Gerar identificador opaco com HMAC-SHA256 de campos canônicos e segredo de servidor versionado. Nunca usar hash simples de CPF/telefone; não persistir payload original da agenda.
- Persistir somente `medico_id`, `origem_agenda`, `chave_idempotencia`, `versao_chave`, `estado`, `solicitacao_id`, `nota_id`, timestamps e referência fiscal não sensível quando necessária. Índice UNIQUE por médico, origem e chave.
- Concorrência: reserva transacional da chave antes de chamar a SEFIN; se já existir, recuperar o estado e reconciliar com o provedor. O índice local não substitui consulta de estado da SEFIN após timeout.
- Definir tratamento para consulta sem referência estável, reprocessamento, mudança de horário, duas consultas do mesmo paciente no mesmo dia e várias consultas agrupadas em uma nota. Na ambiguidade, pedir confirmação e não emitir automaticamente.

## Plano de implementação em lote
1. Auditar todos os pontos de persistência, logs, filas e workers que hoje usam `pacientes`, `agendamentos`, `solicitacao_nota_agendamentos`, `whatsapp_conversas` e `whatsapp_mensagens`.
2. Criar tipos e contrato do subagente de agenda, validador fiscal e emissor; adaptar TribeMD/Amplimed.
3. Criar migração corretiva aditiva para tabela mínima de idempotência, RLS/REVOKE, FK e índice UNIQUE, mantendo compatibilidade com esquema já aplicado. Não aplicar a migração 06 original como está.
4. Refatorar repositórios e fluxos para não escrever pacientes/consultas no banco. Evitar que filas armazenem payload do tomador.
5. Testar consultas repetidas, horários alterados, consultas distintas no mesmo dia, médicos diferentes, timeout SEFIN, retries concorrentes e falta de identificação do profissional.
6. Rodar typecheck, Vitest, testes de integração e revisão de privacidade; só então planejar migração única no novo projeto e deploy em homologação, mediante autorização.

## Observação
O projeto novo já tem tabelas `pacientes` e `agendamentos` criadas pela migração 03. Não inserir dados nelas. Remover estruturas legadas apenas depois de comprovada ausência de dependências.


## Decisão conversacional contextual — múltiplas consultas no mesmo dia
Quando o agente detectar **duas consultas distintas do mesmo paciente no mesmo dia**, não deve pressupor se a emissão será agrupada ou separada. Deve perguntar ao operador autorizado, em linguagem natural:
1. Deseja emitir **uma nota para cada consulta** ou **uma nota agrupando as consultas**?
2. Depois da resposta, deseja usar a escolha **somente neste caso** ou **sempre que ocorrer situação equivalente**?

- **Somente neste caso:** decisão efêmera vinculada à operação atual, sem preferência durável.
- **Sempre:** persistir regra de preferência **sem dados do paciente**, com `conta_id`, contexto, decisão, versão, `autorizado_por`, data/hora e opção de revogação. Se houver escopo médico específico, incluir `medico_id`.
- Aplicar a preferência apenas em cenário semanticamente equivalente; caso exista diferença relevante, conflito de regras, médico não identificado ou impedimento fiscal, perguntar novamente.
- A autorização para agrupar **não substitui** confirmação fiscal, idempotência por consulta e verificação de que cada atendimento ainda não foi faturado.
- Preferências podem ser alteradas pelo operador autorizado; registrar trilha de auditoria sem dados clínicos ou do tomador.
- A interação deve continuar no WhatsApp, sem criar tela de configuração.
