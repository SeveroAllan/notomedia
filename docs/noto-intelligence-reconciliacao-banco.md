# Noto Intelligence — reconciliação do banco (NÃO aplicar diretamente)

Projeto Supabase novo: `orsrfydizyylyycmyjcd` (São Paulo).

## Estado confirmado
- Migração `noto_identity_whatsapp_otp_core`: contas, usuarios, otp_verificacoes, medicos, secretarias, secretaria_medico, contadores, contador_medico.
- Migração `noto_pilot_agenda_references_readonly`: noto_medico_agenda_referencias.
- Nove tabelas vazias; RLS habilitada e privilégios de anon/authenticated revogados.
- Não executar `schema_nf_saude.sql` diretamente: contém CREATE TABLE já existentes, enums que divergem das colunas text atuais, dependência `pgsodium` e premissa de Supabase self-hosted.

## Bloqueios antes da próxima migração
1. Comparar todos os scripts de `scripts/migrations` com o estado real, em ordem de dependência. A baseline antiga não representa integralmente o modelo multi-médico atual.
2. Revisar `usuarios` e `medicos`: a conta pode ter múltiplos médicos; `medicos.usuario_id` deve permanecer opcional para profissionais gerenciados por outra pessoa. Confirmar cardinalidade de identidade WhatsApp por conta e não atribuir consultas por suposição.
3. Revisar o cadastro no `SupabaseAuthAdminService`: o código atual cria usuários técnicos via Admin API e também tenta registrar `phone` e `phone_confirm`. Validar que nenhuma etapa dependa de SMS ou de envio convencional de e-mail.
4. Não armazenar chave privada de certificado, OTP em claro ou segredo de integração em tabelas públicas. Definir uso de Vault/Storage e política de rotação compatíveis com Supabase hospedado.
5. Preparar migrações incrementais para planos, assinaturas, perfil fiscal, certificados, agenda, pacientes, solicitações e notas, consentimentos e auditoria; todas com RLS, REVOKE e verificações estruturais antes do COMMIT.
6. Testar em banco descartável sem `contadores`/`contador_medico` preexistentes e manter validação do corpo de funções ativa. Não usar `CREATE TABLE IF NOT EXISTS` como substituto de verificação de estrutura.
7. Não habilitar worker de emissão, deploy, Evolution real ou migração destrutiva até CI e smoke tests do OTP e isolamento aprovados.

## Ordem recomendada
A. Verificação de esquema e contratos TypeScript/SQL.
B. Migrações incrementais versionadas com testes.
C. Revisão das permissões backend vs RLS (sem conceder acesso direto a anon/authenticated).
D. Aplicação no Noto Intelligence, conferência de índices, FKs e privilégios.
E. Configuração das credenciais exclusivamente no ambiente de destino, nunca no repositório.
F. Testes de OTP WhatsApp, múltiplos médicos e isolamento; worker fiscal permanece desligado.

Este documento é um plano de reconciliação, não uma declaração de compatibilidade ou conclusão do banco.
