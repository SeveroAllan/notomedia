# Diagnóstico da rodada de 03/11: conversa, leitura TribeMD e recibos Evolution

**Escopo:** revisão de código em branch dependente da PR #29. Não houve acesso ao
portal, Evolution, Supabase, mensagens reais ou IA paga nesta investigação.
Não alterar `main`, domínio, prévia desligada, chaves, allowlist ou banco.

## Evidência observada x causas ainda desconhecidas

- **Link**: chegou ao destinatário, a página segura recebeu as credenciais e
  o login TribeMD foi confirmado. O aceite de envio às 08:19:05 e mensagens
  posteriores dizendo "Já solicitei o link" ou "Assim que estiver disponível"
  estão desalinhados. O texto livre da IA não continha estado do último
  link, e a ferramenta só devolvia aceite no próprio turno, sem garantia
  contra futuro verbal no retorno. **Aceite não era entrega**.
- **Leitura**: `conectado=true` comprova autenticação, **não** descoberta
  clínica. `nomesDaLeituraAutenticada` retornava `[]` tanto para leitura
  parcial, agenda limitada, detalhes ausentes/pendentes quanto para nomes
  não encontrados ou reprovados. O resultado detalhado em memória expirou
  após cinco minutos: **a causa específica do último acesso é irrecuperável
  dos dados disponíveis**. Não presumir ausência de profissionais,
  falha de seletor ou atendimento pertencente ao único médico cadastrado.
- **Recibo**: `cofre_links_entregas` ficou em `ACEITO_API` apesar de a
  pessoa ter recebido/aberto/usado a página. Isso **não autoriza** elevar
  artificialmente o estado do WhatsApp. O caminho recebido depende de
  `MESSAGES_UPDATE` habilitado na **instância emissora**, URL correta,
  `webhookByEvents`, segredo `x-webhook-secret` conferido, objeto de
  evento interpretável, `keyId` correspondente e JID PN que possa
  ser correlacionado pelo HMAC. **Nenhum desses pontos foi verificado no
  serviço ativo**; não atribuir a causa sem a próxima evidência.

## Cada problema em sua camada

| Problema | Local | Modificação e motivo |
| --- | --- | --- |
| Conversa no tempo errado | `agent.md`, `src/agente/agente.ts`, `src/agente/webhook.ts` | Postura contextual; o código fornece estado seguro do último link lido na conta e bloqueia promessas de envio futuro após aceite ou encerramento genérico durante onboarding. Não altera prova de entrega nem cria recibo. |
| Conexão sem nomes | `src/agenda/diagnostico-descoberta.ts`, `src/cofre/router.ts`, `src/server.ts` | Captura agregados no callback **antes do TTL**. Retém bloqueio da confirmação até leitura completa, mas distingue cobertura, limite, detalhes pendentes, contagens, nomes filtrados e fonte sem nomes. Mensagem orienta a próxima etapa em vez de supor agenda vazia ou interromper conversa. |
| Recibos estagnados | `src/agente/webhook.ts`, `src/whatsapp/status-entrega-link.ts`, `src/whatsapp/repositorio-entrega-link.ts`, `src/server.ts` | Rota-base e `/messages-update` usam o mesmo segredo/isolamento; eventos recebem classificação com códigos fechados e logs sem conteúdo. Distingue auth recusada, schema, fromMe, PN/LID, mensagem sem ID, sem correlação, repetido e atualização. O SQL evita reescrever timestamp em eventos repetidos. |
| Execução padronizada | `.agents/skills/noto-acesso-agendas/SKILL.md`, `src/agente/instrucoes.ts`, três Dockerfiles | Reutiliza `CofreTribemd`, `FonteAgenda`, `CofreAmplimed`, leitor de filtro e ferramentas já existentes. A skill é **carregada em runtime** e copiada nas imagens. Não é promessa de capacidade, nem substitui provas de navegador. |

### Dados permitidos nos logs de leitura

Somente `cobertura` (enum), `agendaLimitada` (booleano),
`detalhesDisponiveis`, `detalhesPendentes`,
`consultasLidas`, `consultasComProfissional`,
`nomesExtraidos`, `nomesValidados`, `nomesFiltrados`,
`leituraConfiavelParaDescoberta` e `causas` (enums).
Não são registrados senha, token, URL, CPF, nomes de pacientes, nomes
dos profissionais, IDs de consulta, conteúdo clínico ou resposta do
portal. Não se pode recompor a leitura da ocorrência passada a partir
desses contadores. No servidor, só um operador ativo e autorizado da
conta deve receber o resumo por WhatsApp.

### Limites das mudanças

- `x-webhook-secret` continua obrigatório; **não** aceitar `apikey`
  no payload como autenticação alternativa. A configuração ativa da
  Evolution pode enviar cabeçalho diferente: verificar, não desabilitar
  segurança. A própria Evolution pode enviar
  `webhookByEvents=true` para `/messages-update`, caminho aceito
  agora pelo mesmo handler; isso não altera a configuração do serviço.
- Um JID exclusivamente `@lid` não identifica de forma confiável o PN
  para comparar com o hash do número de destino. Sem `remoteJidAlt` ou
  `remoteJid` PN verificável, o recibo permanece não correlacionado.
  Não derivar número a partir de LID nem unir contas por palpite.
- `ATUALIZADO` registra avanço real. `SEM_CORRELACAO` pode decorrer de
  ID/instância/número divergente, mas não informa qual sem evidência de
  logs externos. `DUPLICADO_OU_SEM_AVANCO` não é uma falha comprovada
  de transporte. Falta de callback nunca se transforma em `ERROR`.
- `aberto` do Cofre não prova quem fez o GET; o POST válido consome
  o token. Recebimento/uso relatado pelo usuário não é substituto
  de `DELIVERY_ACK`/ `READ` correlacionado.
- Não acrescenta migração nem modifica a pendente `20261107`, e não
  reenvia links. `linkPreview:false` permanece somente no balão
  seguro, nos caminhos conta e médico, conforme PR #29.

## Nova rodada depois de autorização separada

1. **Somente leitura operacional**: confirmar se o evento
   `MESSAGES_UPDATE` está ativo na instância do assistente, o valor
   `webhookByEvents`, a URL de destino e o cabeçalho autenticador.
   Sem exibir segredos ou payloads brutos.
2. Verificar para uma nova mensagem **autorizada** se houve requisição
   recebida, autenticação aceita, parsing válido e atualização
   correlacionada. Nunca reproduzir/consumir link antigo nem fabricar
   status retrospectivo.
3. Comparar no momento do login seguro os códigos agregados da leitura
   e a fase de callback. Não persistir consultas, pacientes ou dados
   clínicos. Se parcial, compreender cobertura e pendências antes de
   decidir tecnicamente por reconsulta; nenhuma consulta nova ao portal
   nesta revisão.
4. Confirmar se Noto informou aceite como aceite, conexão após prova e
   prosseguiu para a identificação segura dos médicos; verificar que
   conta sem médicos e conta com vários médicos permanecem isoladas.

**Revisão ≠ autorização para merge, migração ou publicação.**

Referência pública para roteamento por evento:
https://github.com/evolution-foundation/evolution-docs/blob/main/docs/02-Configuration/Webhooks.md
