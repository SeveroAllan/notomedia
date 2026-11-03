# Cofre — correção da cadeia de migrações (revisão, não aplicada)

A homologação está na versão anterior e **nenhum SQL foi aplicado**. PR #22 já integrado na branch de preparação, mas deploy retido. Não rodar manualmente DDL fora do repositório.

## Ordem de aplicação, somente após autorização

1. Confirmar que `public.contas` e `public.medicos` existem e que o backup e o ambiente são os corretos. Se a migração original `20261020-cofre-links.sql` já foi aplicada, **não a executar novamente**.
2. Executar `20261104-cofre-links-bootstrap.sql`. Se ambas as tabelas não existirem, cria as estruturas originais; se ambas já existirem, preserva tudo e verifica colunas/chaves. Estado parcial ou incompatível aborta para revisão, sem DROP.
3. Executar `20261105-cofre-links-por-conta.sql`. Adiciona `destino_telefone`, permite `concluido` na auditoria e habilita `conta_id` exclusivo de `medico_id`. Reaplicável.
4. Verificar RLS, REVOKE para `anon`/`authenticated`, permissões backend, auditoria e links legados; somente depois considerar publicação da versão nova. Manter IA pausada até validação.
5. Validar o fluxo real de Cofre/WhatsApp/navegador em homologação **após novo OK**, sem testes pagos sem autorização.

A migração de outubro permanece **intocada** e é usada literalmente pelo teste de upgrade. O bootstrap não substitui a antiga em ambientes que já a aplicaram.

## Segurança, dados e reversão

Não semear médicos, não reatribuir consultas, não copiar tokens e não apagar links/auditoria. A coluna `destino_telefone` é opcional para compatibilidade com código antigo. O CHECK atualizado aceita os quatro eventos legados e `concluido`. A titularidade é exclusiva: um link pertence **ou** a um médico **ou** à conta. Nenhum privilégio de acesso é concedido a `anon` ou `authenticated`; backend segue com acesso de serviço.

**Não fazer rollback destrutivo automático.** A versão antiga pode continuar usando links por médico, mas não entende links por conta. Se precisar reverter o deploy, manter o esquema expandido e pausar novos links por conta. Remover coluna ou constraints exige plano separado de migração dos links por conta, expiração de tokens e backup verificado. Se pré-verificações falharem, a transação aborta e não há aplicação parcial.

## Testes automatizados e pendências

`tests/cofre-migracao-conta.test.ts` aplica o arquivo **20261020 original** com dados legados, depois bootstrap e upgrade, incluindo reaplicação e auditoria `concluido`. `tests/cofre-migracao-zero.test.ts` começa sem as duas tabelas e verifica criação, upgrade, RLS, negação de titular duplo/vazio e reaplicação. Os testes PostgreSQL só executam quando `NOTO_SCHEMA_TEST_DATABASE_URL` estiver configurada no CI, usando bancos descartáveis.

Ainda falta prova real, após autorização, da estrutura específica de homologação, aplicação dos scripts no projeto correto, acesso pelo navegador/WhatsApp, e persistência do Cofre.
