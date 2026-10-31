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


## Noto Agent — Entrega A (experimental)

O novo agente de leitura entra pelo webhook `POST /webhook/evolution`, **somente**
para a instância `EVOLUTION_ASSISTANT_INSTANCE_NAME`, com evento
`messages.upsert` e cabeçalho `x-webhook-secret`. O Noto Oficial continua
reservado para OTP, e as instâncias dos consultórios não acionam o agente.

A funcionalidade está **desligada por padrão**. Para um teste autorizado em
ambiente isolado, configure `NOTO_AGENT_ATIVO=true`,
`NOTO_AGENT_ENVIO_ATIVO=true`, `EVOLUTION_ASSISTANT_WEBHOOK_SECRET`
com valor próprio e `ENVIO_REAL_ALLOWLIST` com os números de teste.
Nunca use o segredo/API key do Noto Oficial como segredo do assistente.

O agente resolve a conta pelo telefone cadastrado do remetente; números que
apontem para mais de uma conta não são atendidos. Sua única ferramenta lê o
estado das conexões TribeMD e Amplimed **por profissional autorizado**. Além disso,
o agente se apresenta e orienta o início: sem cadastro, direciona ao painel; sem
profissional, pede o cadastro; sem conexão, pergunta qual agenda usa; quando a
agenda já está conectada, não solicita uma nova conexão. Ao escolher TribeMD ou
Amplimed, orienta a usar a seção Cofre, sem solicitar senha pelo WhatsApp.
**O envio automático de links de conexão não foi habilitado neste piloto.**
Não lê pacientes, não verifica notas pendentes e não emite ou cancela NFS-e.
Uma resposta de estado não significa que as consultas foram conciliadas.

A prevenção de repetição de mensagens e o contexto das últimas perguntas nesta entrega são **apenas em memória,
para uma réplica**. Esse contexto é perdido em reinicializações, não substitui a memória contínua e não armazena mensagens do usuário. Não habilitar para usuários gerais até implementar a
persistência de conversas/objetivos e a deduplicação durável da Entrega B.
Nenhum deploy ou migração foi executado por esta alteração.
