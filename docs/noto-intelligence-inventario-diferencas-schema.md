# Inventário de compatibilidade SQL — Noto Intelligence

Projeto alvo: `orsrfydizyylyycmyjcd`. Branch: `chore/noto-intelligence-schema-reconcile`.

## Comparação reproduzível
O arquivo `schema_nf_saude.sql` declara 28 tabelas. O inventário remoto de `public` retornou 23 tabelas. A diferença inclui **seis tabelas do esquema de referência ainda ausentes**:
- `whatsapp_instancias` — conexão Evolution, instância, conta/médico e status;
- `whatsapp_conversas` — conversa vinculada à instância e médico, contato e paciente;
- `medico_respostas_rapidas` — modelos de respostas por médico;
- `whatsapp_mensagens` — mensagens, payload, direção e processamento;
- `agenda_slots` — horários disponíveis por médico e agendamento;
- `pagamentos` — transações por médico/paciente/consulta.

O banco contém ainda `noto_medico_agenda_referencias`, criada incrementalmente e ausente do esquema de referência.

`PostgresOtpEmailRepositorio` exige outras duas tabelas (`login_otp_email` e `login_otp_email_auditoria`) que não constam no esquema de referência; a migração 05 foi preparada, não aplicada.

## Correção de autenticação
`SupabaseAuthAdminService.buscarPorTelefone` usava `LIMIT 1`, permitindo escolher uma identidade arbitrariamente se diferentes usuários correspondessem a variantes do mesmo telefone. Agora usa `LIMIT 2` e rejeita múltiplos candidatos. Testes de regressão adicionados em `tests/supabase-auth-admin-telefone-ambiguo.test.ts`. **Não executados ainda.**

## Próxima execução segura
1. Comparar cada tabela ausente com consultas SQL de produção antes de criar migração: o esquema de referência usa enums legados e não deve ser aplicado literalmente.
2. Preservar isolamento entre conta, médico, conversa, paciente e pagamento com FKs compostas.
3. Testar TypeScript/Vitest e executar migrações em banco descartável, sem alterar o Supabase de produção.
4. Verificar autorização na aplicação, pois `service_role` ignora RLS.

Sem deploy, emissão ou alterações no banco nesta rodada.
