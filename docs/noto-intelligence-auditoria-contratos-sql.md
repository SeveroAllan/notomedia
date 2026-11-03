# Auditoria inicial de contratos SQL — Noto Intelligence

Branch: `chore/noto-intelligence-schema-reconcile`. Escopo: somente código e testes; sem deploy ou migração aplicada.

## Evidências verificadas diretamente no repositório

| Código | Contrato SQL | Estado |
| --- | --- | --- |
| `src/io/postgres/postgres-otp-repositorio.ts` — `PostgresOtpRepositorio` | `otp_verificacoes` com `telefone,codigo_hash,tentativas,expira_em,verificado_em,criado_em` | Tabela presente no esquema novo; integração ainda não executada |
| `src/io/postgres/postgres-otp-repositorio.ts` — `PostgresOtpEmailRepositorio` | `login_otp_email` e `login_otp_email_auditoria` | Faltavam no banco; migração 05 preparada, NÃO aplicada |
| `src/io/supabase/supabase-auth-admin-service.ts` | `usuarios`, `medicos`, `contas` e `auth.users` | Tabelas presentes; fluxo Auth Admin API ainda não testado |
| `src/otp/login-otp-email.ts` | OTP por e-mail condicionado à flag e allowlist | Não habilitar automaticamente; manter fechado por padrão |
| `scripts/migrations/noto-intelligence-03-atendimentos-notas.sql` | FK composta `(paciente_id,medico_id)` e unicidade de notas | Coberto por teste SQL transacional em `tests/sql/noto-intelligence-contratos.sql` |

## Riscos e pendências

- `buscarPorTelefone` seleciona `LIMIT 1` sem rejeitar candidatos múltiplos. A correção precisa preservar a semântica de variantes de telefone e compatibilidade com o fluxo de onboarding; adicionar teste de ambiguidade antes de alterar.
- `cadastrarNovoMedico` cria identidade no Supabase Auth antes de iniciar a transação PostgreSQL. Uma falha no banco pode deixar identidade órfã. Exige teste e reconciliação segura, sem exclusão automática de usuários existentes.
- `gerarSessaoParaUsuario` utiliza `generateLink` e `verifyOtp` com cliente administrativo e cliente separado; verificar isolamento e token em integração.
- O esquema de atendimentos/fiscal tem apenas o núcleo de tabelas. Outros contratos do repositório, incluindo conversas, pagamentos, storage e workers, NÃO foram auditados integralmente.
- O SQL de teste é propositalmente reversível (`ROLLBACK`); ainda NÃO foi executado por CI. Não afirmar CI verde.

## Ordem recomendada

1. Executar migrações em banco descartável e `tests/sql/noto-intelligence-contratos.sql`.
2. Completar inventário de todos os repositórios SQL e migrações históricas.
3. Corrigir busca ambígua por telefone com teste de regressão.
4. Rodar `npm run typecheck` e `npm test` no commit da branch.
5. Validar Auth/OTP, Storage e autorização real por médico; somente depois considerar aplicação no projeto novo.

**Nenhuma migração foi aplicada ao Supabase nesta etapa. Nenhum deploy e nenhuma emissão fiscal.**
