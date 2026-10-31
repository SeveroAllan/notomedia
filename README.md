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
- Navegador virtual para logar e ver agendas (TribeMD).
- Cofres de agenda e certificado: credenciais, cookies e certificados
  criptografados por conta no painel, com conexão, leitura da agenda,
  reconexão, alteração, desconexão e exclusão.

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

O card TribeMD e a seção **Cofre** substituem Google Planilhas no painel. O acesso
é vinculado à conta Supabase; o usuário autoriza a leitura ao salvar as credenciais.
Configuração e limites: [cofre TribeMD](docs/implementation/cofre-tribemd.md).
