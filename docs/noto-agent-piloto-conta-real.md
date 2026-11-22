# Noto Assistente — piloto com conta real (PR #12)

## Objetivo e estado atual

Esta revisão **prepara** o reconhecimento de uma conta Noto já existente por um
telefone de teste, sem cadastrar pessoas fictícias e sem acessar pacientes ou notas.
**Nenhuma ligação ao banco operacional, migração, alteração de conta, deploy ou
merge foi executado.** O estado do cadastro desse telefone continua **não verificado**.

O login por OTP, a criação de sessão no Supabase Auth e a conexão do WhatsApp do
consultório são responsabilidades do **aplicativo normal existente**. O processo
isolado do piloto lê somente `usuarios`, `medicos` e, para referências de
agendas, `noto_medico_agenda_referencias`. A ausência de identidade validada
por Auth, cadastro ambíguo ou consulta indisponível exige esclarecimento;
o piloto **não** cria conta, médico, paciente ou nota.

## Achado de segurança: desligar worker não torna o servidor read-only

| Processo/rota do servidor completo | Possibilidade de escrita/efeito |
|---|---|
| `src/worker/iniciar-worker-embutido.ts` | Busca e bloqueia `solicitacoes_nota`; pode emitir NFS-e |
| Timer `cadastroCertificado.recuperar()` em `src/server.ts` | Atualiza/reserva trabalhos de cadastro a cada 5 s |
| `/api/auth/otp/solicitar` e `/verificar` | Grava hash/tentativas OTP; pode criar conta/Auth e gerar sessão |
| `/api/auth/otp/email/*` | Grava OTP/auditoria de login |
| `/api/onboarding/*`, `/api/conta/perfil`, `/api/conta/preferencias` | Cadastro, parâmetros fiscais, certificado, conexões; escrevem |
| `/api/conta/cadastro`, `/api/conta/cofre`, `/c` | Alterações de cadastro, links, consentimento e credenciais |
| `/api/v1/nfse`, `/v2/nfse`, `/v2/nfsen` | Operações fiscais / filas |
| `/api/whatsapp/status` e status/onboarding de WhatsApp | Podem chamar integração de reconciliação; não presumir apenas SELECT |

Por isso **não usar `npm start` no serviço piloto**. Mesmo com
`NOTO_WORKER_EMBUTIDO_ATIVO=false`, o servidor completo preserva rotas de
escrita e recuperação de cadastro. Com `NOTO_AGENT_PILOTO_DATABASE_URL`
presente, o startup do servidor completo agora falha fechado.

A flag `NOTO_WORKER_EMBUTIDO_ATIVO=false` foi adicionada em defesa em
profundidade: o worker retorna antes de criar repositórios, clientes, timers ou
executar `buscarETravarProximoItem`. O servidor também evita chamá-lo.
Seu padrão continua ativo para não modificar involuntariamente a produção.

## Processo isolado: `npm run start:piloto-agente`

Para não depender de trocar o comando manualmente no Easypanel, use a imagem
construída com **`Dockerfile.piloto-agente`**, cujo `CMD` já é
`npm run start:piloto-agente` e cujo processo executa com usuário não root.
O `Dockerfile` padrão do repositório ainda inicia `npm start` e **não
deve ser usado no piloto**. Configure o serviço isolado com esse Dockerfile,
réplica única e auto-deploy desligado; nunca compartilhe o ambiente de
execução com o serviço fiscal. O CI também constrói essa imagem para
verificar o empacotamento.

Entrada: `src/agente/piloto-start.ts`. Importa somente um pequeno app
Express (`src/agente/piloto-app.ts`), adaptadores de status local e cliente
Evolution, **sem importar `src/server.ts` ou o pool PostgreSQL global**.

**Rotas publicadas:**
- `GET /health`;
- `POST /webhook/evolution`, com segredo exclusivo, instância exclusiva e
  número de teste exatamente único na allowlist.

**Rotas ausentes:** toda rota OTP, cadastro, certificado, agenda mutável,
Cofre HTTP/link, emissão, fila e webhook operacional do aplicativo normal.
Não importa worker embutido nem inicializa recuperação automática de cadastro.

**Requisitos para um ambiente isolado, depois da autorização:**

```dotenv
NOTO_AGENT_ATIVO=true
NOTO_AGENT_ENVIO_ATIVO=true
NOTO_AGENT_DIAGNOSTICO_ATIVO=true
NOTO_AGENT_TRACES_ATIVOS=false
ENVIO_REAL_ALLOWLIST=<UNICO_NUMERO_DE_TESTE>
NOTO_AGENT_PILOTO_DATABASE_URL=postgresql://<ROLE_SOMENTE_SELECT>:<SEGREDO>@<HOST>/<BANCO>
EVOLUTION_ASSISTANT_URL=https://<EVOLUTION_DE_TESTE>
EVOLUTION_ASSISTANT_GLOBAL_API_KEY=<CHAVE_EXCLUSIVA>
EVOLUTION_ASSISTANT_INSTANCE_NAME=<INSTANCIA_ASSISTENTE_DE_TESTE>
EVOLUTION_ASSISTANT_WEBHOOK_SECRET=<SEGREDO_EXCLUSIVO>
OPENAI_API_KEY=<CHAVE_IA_DO_TESTE>
OPENAI_TEXTO_MODEL=gpt-4o-mini
COFRE_DIRETORIO=<VOLUME_SOMENTE_LEITURA_OU_OMITIR>
COFRE_CHAVE=<CHAVE_SOMENTE_SE_VOLUME_AUTORIZADO>
```

`NOTO_AGENT_PILOTO_DATABASE_URL` **deve usar uma credencial diferente** de
`DATABASE_URL`, nunca superuser, nunca a conexão de escrita da aplicação,
e nunca `SUPABASE_SERVICE_ROLE_KEY`. O PostgreSQL recebe
`default_transaction_read_only=on` na abertura da conexão e, **antes de
abrir o webhook**, verifica que o role não tem privilégio de escrita em
nenhuma tabela, view ou objeto externo acessível e não possui SELECT além
das tabelas explicitamente necessárias. Rejeita superusuário, BYPASSRLS,
CREATEROLE, CREATEDB e REPLICATION.

**Importante:** a verificação de permissões é uma proteção adicional.
A segurança primária exige um usuário PostgreSQL dedicado com concessões
mínimas e sem permissões herdadas excessivas. Se privilégios PUBLIC do banco
real impedirem um role estritamente restrito, **não remover grants da
produção para fazer o teste passar**: criar um acesso de leitura isolado,
uma réplica autorizada ou outra interface restrita, com revisão do DBA.
Não conectar até a aprovação dessas permissões.

Se o Cofre local estiver montado com o mesmo formato e chave em volume
**somente leitura**, a consulta lê o estado sem acessar a internet. Sem
o volume, informa indisponibilidade, sem fingir conexão/desconexão. Não
montar a página do Cofre nem expor suas credenciais.

## Jornada normal de login e boas-vindas

No app normal já existente, o usuário entra no painel, solicita e confirma
o OTP e recebe sessão Supabase Auth. A revisão adiciona **duas flags
desligadas por padrão**:

- `NOTO_AGENT_LOGIN_CONTA_EXISTENTE_APENAS=true`: somente para o número
  exato da allowlist, depois de validar o OTP, usa SELECT sem efeitos para
  localizar o usuário/conta existente. Se não existir ou for ambíguo,
  retorna `conta_existente_nao_encontrada`, sem chamar criação de conta;
  outros usuários preservam o login normal.
- `NOTO_AGENT_BOAS_VINDAS_OTP_TESTE_ATIVAS=true`: depois da verificação
  bem-sucedida do OTP e **somente** para conta preexistente e um número
  autorizado, envia mensagem inicial da instância assistente de teste.
  Exige também ambas as flags do agente ligadas e a flag de conta existente.

**As boas-vindas são disparadas após o OTP validado**; isso não confirma
que uma *instância WhatsApp do consultório* foi conectada. O pareamento
dessa instância é outro fluxo existente. Não ativar essas flags no servidor
completo conectado a um banco novo para o piloto sem revisar todo seu modo
de execução: ele preserva rotas de escrita normais.

O serviço piloto só atende números cujas consultas retornarem uma
identidade `usuarios.auth_user_id` ativa vinculada à conta. Não deduz
identidade do conteúdo das mensagens nem usa cadastro fictício.

## Prova de ferramentas e respostas

Habilitar `NOTO_AGENT_DIAGNOSTICO_ATIVO=true` somente no serviço isolado.
Os logs estruturados registram uma referência HMAC para mensagem e resposta,
código e duração de cada ferramenta do agente, totais de tokens e estado do
envio. Não gravam conteúdos de mensagens, dados do médico, telefone, IDs
brutos, pacientes, senhas, argumentos de tools nem exceções originais.
Comparar com a captura local do WhatsApp e verificar códigos reais:
`CONTA_AUTORIZADA`, `STATUS_CONECTADO`, `STATUS_INDISPONIVEL`,
`DEPENDENCIA_PROFISSIONAL`, etc.

Traces SDK OpenAI, se ativados, utilizam
`traceIncludeSensitiveData=false`. Revisar privacidade e retenção antes
de habilitar qualquer exportação.

## Critérios de aceitação antes de conectar o banco operacional

1. `npm ci && npm run typecheck && npm test` totalmente verdes.
2. Teste unitário comprova **zero chamadas a query/connect** com worker OFF,
   inclusive se as flags de emissão estiverem verdadeiras.
3. Testes HTTP comprovam que o piloto não expõe rotas com escrita.
4. Teste do handshake de banco recusa role com qualquer permissão de escrita,
   SELECT extra ou conexão não read-only.
5. Teste OTP prova que nenhuma conta nova é criada no modo de teste e que
   a mensagem inicial só é enviada para um destinatário permitido.
6. Revisar credenciais, volumes e política do banco com o responsável técnico.
7. **Somente após autorização expressa**, iniciar acesso read-only para
   verificar se a conta de teste existe e se está ligada ao Auth normal;
   depois realizar o reteste WhatsApp com logs seguros.

Nenhum desses testes de código comprova previamente o conteúdo da base real.
**Não há autorização nesta alteração para criar/migrar roles, conceder
privilégios, consultar o banco real, acessar pacientes ou fazer deploy.**
