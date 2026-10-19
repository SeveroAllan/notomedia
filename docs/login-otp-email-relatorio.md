# Login por OTP de e-mail — canal extra de teste

19/10/2026. Base: `962f4ec`, branch `passo-12`, checkout `/workspace/notomedia`.

Implementação concluída com flag desligada por padrão. Nenhum envio real, migração aplicada, fetch, pull ou push foi realizado durante esta tarefa. A `main` permaneceu em `962f4ec`. O push do passo 12, solicitado separadamente antes desta implementação, não publicou os commits abaixo.

## Commits de implementação

- `4ae51af` — núcleo do canal de e-mail, flags, HMACs, persistência/auditoria e schema proposto; testes das regras e do adaptador PostgreSQL.
- `3a9803b` — rotas HTTP extras, confirmação da identidade, remetente Resend atrás de interface, configuração e testes da integração.

Este relatório é registrado em uma etapa de documentação separada; seu SHA é informado na entrega final.

## Comportamento

O WhatsApp continua sendo o padrão. As rotas, casos de uso, regras de hashing/expiração e criação de conta do OTP por WhatsApp não foram alterados. Os 630 testes existentes continuam passando; nenhuma expectativa antiga foi modificada. A única alteração na infraestrutura de testes existente trava a nova flag desligada, limpa a allowlist/remetente e remove a credencial Resend do ambiente de testes.

O novo canal exige simultaneamente:

1. `LOGIN_OTP_EMAIL_ENABLED=true` explícito. Ausência, `false`, `1` ou `TRUE` não habilitam.
2. Endereço na `LOGIN_OTP_EMAIL_ALLOWLIST`.
3. Endereço exatamente `severoallan2019@gmail.com` após remover espaços externos e normalizar caixa. Acrescentar outro endereço à configuração não amplia o público deste experimento. Aliases com `+` ou pontos diferentes são recusados.
4. Uma única conta local ativa para esse e-mail, vinculada a uma identidade Supabase Auth com o mesmo e-mail confirmado.
5. Remetente e credencial configurados, ou remetente falso injetado nos testes.

Flag desligada ou endereço não permitido são recusados antes de consultar banco/identidade ou chamar o remetente. Essas recusas de entrada não criam registro de auditoria. Os eventos do fluxo admitido são auditados por hash, motivo fixo e data.

## API adicional

As rotas antigas continuam sendo `/api/auth/otp/solicitar` e `/api/auth/otp/verificar`, com telefone e WhatsApp.

O canal extra usa somente:

```text
POST /api/auth/otp/email/solicitar
{"email":"severoallan2019@gmail.com"}

POST /api/auth/otp/email/verificar
{"email":"severoallan2019@gmail.com","codigo":"<código recebido>"}
```

Solicitação aceita devolve `ok` e `expiraEm`, sem devolver código ou e-mail. Verificação aceita devolve a sessão no formato da aplicação. HTTP 404 indica canal desligado; 403, endereço não permitido; 400, solicitação recusada; 401, verificação recusada; 500, falha interna sanitizada. A falha interna devolve somente `otp_email_indisponivel` e registra `LOGIN_OTP_EMAIL_FALHOU`, sem corpo de requisição ou exceção do provedor.

Não foi adicionado seletor de canal à interface de login. O canal extra é exercitado pelas rotas acima; a interface existente continua usando WhatsApp.

## Segurança e auditoria

- Código criptograficamente aleatório de seis dígitos, com o gerador existente.
- Expiração de cinco minutos, cooldown de 60 segundos e limite de cinco tentativas, reutilizando constantes e regras do OTP existente. Como no WhatsApp atual, o instante exato de expiração ainda é aceito; um milissegundo depois é recusado.
- `email_hash = HMAC-SHA256(APP_PEPPER, JSON.stringify(['login_otp_email', emailNormalizado]))`.
- `codigo_hash = HMAC-SHA256(APP_PEPPER, JSON.stringify(['login_otp_email', email_hash, codigo]))`, usando o hash/comparador de tempo constante já existente. O hash fica vinculado ao canal e destinatário.
- Código consumido antes da geração da sessão; falha da sessão não permite reutilização.
- Identidade revalidada na verificação e comparada com o `authUserId` associado ao OTP na solicitação.
- Advisory lock por hash de destinatário serializa solicitação, tentativas, consumo e auditoria entre processos. Concorrência não duplica envio aceito ou sessão nos cenários testados.
- Falha do remetente mantém o registro e o cooldown, sem confirmar o envio. Um código cujo envio não foi confirmado não autentica.
- Erros livres do provedor, e-mail, código e token não entram na auditoria ou nos logs novos. A auditoria tem apenas `email_hash`, evento fixo e data, além do ID técnico do registro.
- Os registros de OTP também guardam apenas hash do destinatário, hash do código, ID opaco da identidade e estado/tempos. A busca lê o e-mail do cadastro existente, sem copiá-lo para essas novas tabelas.

O endereço informado no escopo aparece apenas como string de destino nos fakes e como limite explícito do experimento. Cadastros, identidades, telefones, tokens e credenciais usados nos testes são fictícios. Nenhum e-mail foi enviado ao endereço de teste.

## Configuração para futura homologação

A configuração entregue continua fechada:

```dotenv
LOGIN_OTP_EMAIL_ENABLED=false
LOGIN_OTP_EMAIL_ALLOWLIST=
LOGIN_OTP_EMAIL_FROM=
```

Para uma homologação futura, após revisão e aplicação manual do schema proposto pelo dono do ambiente, as variáveis necessárias são:

```dotenv
LOGIN_OTP_EMAIL_ENABLED=true
LOGIN_OTP_EMAIL_ALLOWLIST=severoallan2019@gmail.com
LOGIN_OTP_EMAIL_FROM=<remetente validado no Resend>
RESEND_API_KEY=<segredo do provedor>
APP_PEPPER=<segredo estável já usado pela aplicação>
```

Banco e Supabase usam as configurações existentes `DATABASE_URL`, `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`. O serviço precisará alcançar `api.resend.com` por HTTPS. Nenhuma dessas credenciais foi configurada nesta execução e a flag não foi ligada no ambiente real.

A infraestrutura Resend já tinha `RESEND_API_KEY` prevista no projeto; o novo adaptador não adiciona dependências. O remetente só aceita sucesso do HTTP como confirmação de aceitação pelo provedor, sem registrar seu corpo. Sem chave ou remetente configurado, falha fechado e não chama HTTP. Nos testes, o transporte HTTP do adaptador também é falso.

## Schema apenas proposto

`scripts/migrations/20261022-login-otp-email.sql` cria, de forma idempotente:

- `public.login_otp_email`: hashes, identidade opaca, expiração, tentativas e estado de envio/consumo.
- `public.login_otp_email_auditoria`: hash do destinatário, evento fixo e data.

Inclui validação de hashes de 64 hex, limite de tentativas, FK para a identidade Auth, índice para a última solicitação, RLS e revogação de acesso público/anon/authenticated. Não altera `otp_verificacoes`, usada pelo WhatsApp. Nenhuma instrução dessa migração foi executada; com a flag desligada o servidor não acessa as novas tabelas.

## Evidência antes e depois

Antes, no HEAD `962f4ec`:

```text
npm run typecheck
> tsc --noEmit
[código de saída 0]

npm test
Test Files  46 passed (46)
Tests       630 passed (630)
```

Depois:

```text
npm run typecheck
> tsc --noEmit
[código de saída 0]

npx tsc --noEmit -p tsconfig.test.json
[código de saída 0]

npm test
Test Files  51 passed (51)
Tests       680 passed (680)
```

São 50 testes novos: 29 de regras/segurança, 4 de persistência/schema, 6 de identidade, 6 HTTP e 5 do remetente. Os testes foram escritos e registrados falhando antes das implementações correspondentes. Logs locais: `work/otp-email/antes-testes.log`, `antes-typecheck.log`, `core-red.log`, `postgres-red.log`, `integracao-red.log`, `etapa1-testes.log`, `integracao-green.log`, `integracao-typecheck.log`, `integracao-tests-typecheck.log` e `depois-testes.log`.

Verificado: flag ausente/desligada, allowlist estrita, recusa mesmo se um endereço extra for configurado, fluxo completo falso, WhatsApp com flag ligada/desligada, HMACs, expiração, cooldown, tentativas concorrentes, consumo único, falhas de envio/sessão/auditoria, identidade não confirmada/ambígua/divergente, ausência de e-mail/OTP/token nos dados gravados e logs novos.

## Arquivos tocados

Código/configuração:

- `.env.example`
- `src/config.ts`
- `src/otp/login-otp-email.ts` — novo núcleo e interfaces do canal extra.
- `src/io/postgres/postgres-otp-repositorio.ts` — adaptador adicional, mantendo a classe WhatsApp intacta.
- `src/io/resend/enviar-otp-email.ts` — novo remetente, com transporte substituível.
- `src/io/supabase/supabase-auth-admin-service.ts` — busca adicional que exige identidade confirmada.
- `src/server.ts` — duas rotas extras e injeção opcional do remetente falso.
- `scripts/migrations/20261022-login-otp-email.sql` — proposta não aplicada.

Testes:

- `tests/ambiente.ts` — proteção das variáveis novas e credencial Resend.
- `tests/fakes/banco-otp-email.ts` — banco falso compartilhado pelos testes do adaptador e HTTP.
- `tests/login-otp-email.test.ts`
- `tests/login-otp-email-postgres.test.ts`
- `tests/login-otp-email-identidade.test.ts`
- `tests/login-otp-email-http.test.ts`
- `tests/login-otp-email-remetente.test.ts`

Documentação: `docs/login-otp-email-relatorio.md`.

## Limites, hipóteses e o que ficou fora

Não houve verificação contra PostgreSQL, Supabase Auth ou Resend reais. A migração foi testada como proposta textual, sem aplicação; transações, concorrência e persistência foram exercitadas com SQL falso na fronteira. A entrega real e a configuração do remetente precisam de homologação futura autorizada.

O e-mail editável do cadastro não é prova de identidade. Contas criadas pelo WhatsApp cujo e-mail no Auth continua sintético não passam a aceitar este canal automaticamente. É necessário que já exista uma conta ativa única cujo e-mail de contato e e-mail confirmado no Auth coincidam com o endereço permitido. Provisão, alteração ou vinculação dessas identidades ficou fora do escopo; não foi feita associação por nome ou telefone.

Também ficaram fora: novo cadastro por e-mail, alterações na tela de login, conversão das contas existentes, mudança no OTP WhatsApp, envio real, aplicação de migração, ampliação de destinatários, deploy, fetch, pull e push dos commits desta tarefa. A liberação é de configuração do canal de teste e não depende nem altera o ambiente fiscal das notas.
