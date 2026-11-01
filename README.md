# Noto — aplicativo único

Painel, cadastro, WhatsApp, API de NFS-e, PDF e processamento fiscal executam no
mesmo aplicativo, iniciado com `npm start`. O worker da fila é embutido; não há
comando ou serviço separado de worker, Noto Fiscal ou Noto IA nesta versão.

## Ferramentas

- Login e cadastro com OTP (Noto Oficial) e autenticação Supabase.
- Conexão com WhatsApp: pareamento por código/QR, persistência da sessão e
  monitoramento no painel.
- Upload e validação de certificado A1.
- Extração automática de parâmetros fiscais a partir dos dados do certificado
  (XML de referência), com revisão e confirmação no painel.
- API de pesquisa de nome completo, CRM e RQE (OpenSerp), com cache no Supabase.
- API de emissão fiscal atual (`/api/v1/nfse`, `/v2/nfse`, `/v2/nfsen`): fila,
  assinatura, transmissão, armazenamento do XML autorizado e conversão PDF.
- Navegador virtual para logar e ver agendas (TribeMD e Amplimed).
- Cofres de agenda e certificado: credenciais, cookies e certificados
  criptografados por conta no painel, com conexão, leitura da agenda,
  reconexão, alteração, desconexão e exclusão. A escolha entre TribeMD e
  Amplimed usa a agenda conectada mais recente.

Os motores antigos de candidatos, pedidos, aprovação conversacional, varredura,
assistente e webhooks de conversa foram removidos. A fila desta base consome
apenas solicitações de origem `api`. `npm test` roda verificação de tipos e a
suíte de testes das ferramentas mantidas.

## Executar

Node 22+, `npm ci`, variáveis do ambiente descritas em `.env.example` e `npm start`.
O Dockerfile inclui Chromium/Xvfb para o TribeMD. Senhas e chaves devem ficar no
ambiente/gestor de segredos; volumes e chaves de cofre existentes precisam persistir.
Não criar outros processos de emissão para acompanhar este aplicativo.

As variáveis `AGENTE_FISCAL_ATIVO` e `PREPARACAO_FISCAL_ATIVA` ainda controlam
proteções da fila e validação fiscal. Preservar os valores atuais. As tabelas e
migrações existentes foram preservadas; esta limpeza de código não executa
exclusões no banco.

## Cofre e próximas integrações

Os cards TribeMD e Amplimed e a seção **Cofre** substituem Google Planilhas no painel. O acesso
é vinculado à conta Supabase; o usuário autoriza a leitura ao salvar as credenciais.
Configuração e limites: [cofre TribeMD](docs/implementation/cofre-tribemd.md).


## Noto Assistente — Entrega A (OpenAI Agents SDK; piloto)

Esta entrega substitui o antigo classificador de JSON por **um único agente real** executado com
`@openai/agents@0.21.0` e **Zod 4**. O runtime gerencia o loop modelo →
ferramenta → resultado → decisão, com limite de seis turnos por mensagem e prazo de
20 segundos. Cada ferramenta usa schema validado pelo SDK; o backend resolve
conta e profissional e nunca aceita IDs escolhidos pelo modelo.

O webhook é `POST /webhook/evolution`, somente para
`EVOLUTION_ASSISTANT_INSTANCE_NAME`, evento `messages.upsert`, com cabeçalho
`x-webhook-secret` igual a `EVOLUTION_ASSISTANT_WEBHOOK_SECRET`.
O número remetente precisa constar em `ENVIO_REAL_ALLOWLIST`; instâncias
alheias e números que apontam para múltiplas contas são ignorados. O Noto
Oficial continua isolado para OTP.

**Para teste isolado autorizado**, use `NOTO_AGENT_ATIVO=true`,
`NOTO_AGENT_ENVIO_ATIVO=true` e `OPENAI_API_KEY` válida; o modelo é
`OPENAI_TEXTO_MODEL`, com fallback para `gpt-4o-mini`. Esses dois flags estão
desligados por padrão. O SDK usa a API Responses da OpenAI; a antiga chave
NVIDIA não aciona o novo runtime. O fallback sem OpenAI não consulta dados
privados e não afirma que a conexão está ativa.

A leitura de estado do Cofre foi separada dos links públicos. O módulo
`src/cofre/status-interno.ts` consulta o status local, sem link, URL pública,
login externo ou requisição HTTP de entrada. A ausência de `COFRE_ORIGEM`
desabilita a geração dos links, **não** a leitura interna. Uma fonte
indisponível recebe estado explícito `indisponivel`; jamais é convertida em
"desconectada". A interface HTTP do Cofre continua exigindo autenticação,
origem e autorização próprias.

As três ferramentas **somente de leitura** são:
- `consultar_contexto_conta`: identifica se existe cadastro e mostra apenas
  os profissionais da conta autorizada.
- `consultar_status_agendas`: verifica conexões TribeMD e Amplimed já existentes
  pelo cofre; sem atendimentos, pacientes, notas ou valores.
- `orientar_conexao_agenda`: reconhece a escolha de agenda e confere a próxima
  dependência (conta, profissional, conexão ou reconexão) antes de orientar o
  uso do **Cofre** no painel existente.

O Noto pode se apresentar sem cadastro e perguntar qual agenda o usuário utiliza,
interpretar respostas curtas, identificar a profissional correta e evitar pedidos de
reconexão quando já existe uma agenda conectada. Ele **não cria cadastros
pelo WhatsApp e não envia automaticamente links ou credenciais** nesta entrega.
Senha/token recebido é bloqueado antes do modelo. Nenhuma ferramenta de emissão,
cancelamento ou alteração fiscal foi disponibilizada.

### Diagnóstico seguro do piloto (sem migração)

`NOTO_AGENT_DIAGNOSTICO_ATIVO=false` por padrão. Para um teste isolado e
autorizado, habilite a flag e consulte os logs do serviço Noto (acesso restrito).
Cada execução aceita gera uma linha JSON identificada por
`[Noto Agent diagnóstico]`:
- `mensagemRef`: HMAC truncado sobre instância, ID da mensagem e telefone,
  com o segredo do webhook; não registra os identificadores originais.
- `respostaRef`: HMAC do texto efetivamente encaminhado à Evolution. Permite
  conferir a resposta exata com o mesmo segredo, sem guardar a resposta.
- `agente.ferramentas[]`: **nome fixo**, **código fixo** e duração em ms de
  cada ferramenta realmente executada, na ordem.
- `agente.codigo`, `agente.duracaoMs`, `conta`, `envio` e
  `agente.uso.{requisicoes,tokensEntrada,tokensSaida,tokensTotal}`.
  Quando não há telemetria de consumo, os valores são `null`, não estimativas.

**Nunca** entram nos logs: mensagem, resposta, nome ou ID do profissional,
telefone, parâmetros/resultado completos da ferramenta, senha, token de
autenticação ou exceção original. A comparação com a conversa do WhatsApp
deve usar o horário do log e a referência HMAC; a captura do WhatsApp continua
com o operador, não armazenada pela ferramenta. Configure retenção curta,
permissões de acesso aos logs e evite encaminhá-los para serviços públicos.

`NOTO_AGENT_TRACES_ATIVOS=false` por padrão; quando explicitamente ativado,
o Agents SDK gera traces adicionais com `traceIncludeSensitiveData=false`.
Esses traces complementam os códigos locais: é necessário revisar o
destino, o acesso e a política de retenção antes de ativá-los. A memória
curta e a deduplicação de eventos são apenas em RAM, limitadas a uma réplica
de teste; a Entrega B deve implementar persistência, isolamento e idempotência
distribuída antes de habilitar para usuários gerais.

**Validação:** `npm ci`, `npm run typecheck` e `npm test` no GitHub
Actions. Testes usam o `ScriptedModel` do próprio SDK para verificar o
loop de ferramentas, autorizações, nomes ambíguos e onboarding sem modelo remoto.
A execução real inicial via WhatsApp revelou repetição de onboarding e diagnóstico de Cofre insuficiente; estas correções exigem **novo teste integrado**, mesmo com o CI verde. Nenhum deploy, migração ou merge foi executado por esta alteração.
