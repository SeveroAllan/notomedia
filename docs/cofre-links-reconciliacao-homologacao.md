# Homologação — reconciliação real do Cofre (revisão antes de publicar)

## Diagnóstico e ponto de partida

O banco de homologação informado não contém `public.cofre_links` nem
`public.cofre_links_auditoria`. No repositório, a migração **histórica e não
alterada** `20261020-cofre-links.sql` cria as tabelas, mas omite
`destino_telefone` e só admite `criado`, `aberto`, `enviado`,
`expirado`. O código anterior já insere `destino_telefone` e grava
`concluido`; assim, **aplicar só o SQL de 20261020 não é suficiente**.

O código da PR #22 também passa a criar links por `conta_id` para uma conta
sem médicos. A migração anterior `20261105-cofre-links-por-conta.sql`
pressupõe as tabelas já existentes e, sozinha, **não resolve** os dois
pontos de partida acima.

## Caminho único versionado

**Arquivo novo:** `scripts/migrations/20261106-cofre-links-reconciliar-homologacao.sql`.

O arquivo deve ser executado **uma vez no banco-alvo, em transação completa**,
após a revisão e autorização da homologação. É também reaplicável.

- **Banco sem tabelas do Cofre:** cria as duas com todos os campos que o
  código utiliza, FKs, PK, unicidade do hash, auditoria de cinco eventos,
  `destino_telefone`, RLS e acesso apenas do backend.
- **Banco com 20261020 aplicado:** adiciona `destino_telefone`, habilita
  `conta_id` com FK, mantém os links e seus hashes/timestamps, substitui
  somente o CHECK de auditoria para aceitar também `concluido`. Não
  regrava nem elimina links e eventos anteriores.
- **Banco com 20261105 aplicado:** conserva os vínculos já existentes,
  refaz as validações estruturais e mantém o comportamento por conta/médico.
- Titular obrigatório e exclusivo: **exatamente um** de `medico_id` ou
  `conta_id`, nunca ambos. Os antigos links com `medico_id` continuam
  válidos: a aplicação antiga não depende da coluna `conta_id`.
- Verificações **antes do COMMIT** da estrutura, PKs, unique,
  `medico_id`/ `conta_id` e respectivas FKs, RLS, CHECKs e REVOKE.
  Incompatibilidade inesperada aborta a transação, sem conclusão parcial.
- Revoga privilégios `PUBLIC`, `anon` e `authenticated`. O backend
  usa a conexão PostgreSQL privilegiada ou `service_role`, com grants
  explícitos; não há política de escrita/leitura de links pela interface.

**Pré-requisitos:** `public.contas`, `public.medicos`, papéis de acesso
Supabase `anon` e `authenticated`; o script verifica isso, não cria
usuários/contas/médicos nem aplica migrations anteriores de outras áreas.

## Ordem após sua aprovação (NÃO executada)

1. Identificar o banco **correto** da homologação, confirmar por consulta
   somente de leitura a presença/ausência das tabelas e das FKs em
   `contas`/`medicos`. Fazer backup/snapshot do banco e registrar
   qual versão de aplicação está em execução. **Não usar produção ou outro
   projeto Supabase.**
2. Com a IA e novas conexões ainda pausadas, aplicar **somente**
   `20261106-cofre-links-reconciliar-homologacao.sql` pelo mecanismo
   controlado de migração. Não aplicar `20261020` como bootstrap
   obrigatório; o arquivo novo já cobre o estado vazio. Se o antigo já
   foi aplicado, não o reaplicar. `20261105` não é pré-requisito do
   reconciliador; ele incorpora a alteração por conta.
3. Validar, com leitura do catálogo PostgreSQL e sem credenciais expostas,
   as duas tabelas, o CHECK de titular, os cinco eventos da auditoria, as
   FKs e a ausência de privilégios `anon/authenticated`. A versão antiga
   segue compatível durante essa etapa.
4. Só então, **em aprovação separada**, publicar a imagem de homologação
   preparada; validar os volumes, `COFRE_DIRETORIO`, `COFRE_CHAVE`
   e `COFRE_ORIGEM` exclusivos e HTTPS, a allowlist, emissão bloqueada
   e worker fiscal desligado. Não alterar produção.
5. Com outro OK para o teste real, fazer o login TribeMD pela página
   segura, verificar leitura dos profissionais por navegador,
   confirmação explícita por WhatsApp e persistência após reinício.

**Nenhuma DDL avulsa**: se a inspeção encontrar uma estrutura divergente,
parar, revisar e commitar ajuste versionado antes de executar. As
migrações históricas ficam intactas para rastreabilidade.

## Reversão e preservação

- **Antes do COMMIT / em erro:** PostgreSQL reverte todas as mudanças.
- **Depois do COMMIT, antes de publicar:** a aplicação antiga pode
  continuar a usar `medico_id` e `destino_telefone`; não é necessário
  desfazer o esquema para reverter código.
- **Depois de criar links por conta:** **não fazer DROP de `conta_id`,
  tabelas, CHECK ou chave criptográfica** — isso apagaria/invalidaria links
  e estados. Para voltar temporariamente à aplicação antiga, deixar o
  esquema aditivo no lugar e suspender novos links por conta; qualquer
  rollback destrutivo precisa de plano e backup revisados.
- Preservar volume e segredo do Cofre da homologação entre deploys;
  os dados criptografados no disco não são a mesma coisa que a tabela
  de links/auditoria no banco.

## Validação automatizada

`tests/cofre-links-reconciliacao-real.test.ts` usa PostgreSQL 16
descartável e os **arquivos SQL reais do repositório**:

- Estado sem tabelas → criar, inserir link de conta sem médicos,
  gravar cinco eventos, verificar segurança, integridade, titular e
  reaplicar sem mudanças.
- **Executar `20261020` literalmente**, sem coluna extra nem CHECK
  alterado no fixture → confirmar falha prévia em `concluido`,
  inserir dados legados → reconciliar duas vezes → verificar todos os
  dados preservados, `concluido` aceito e escrita/leitura pelos contratos
  antigos e novos.
- Esquema incompatível → erro e rollback integral.
- O teste preexistente `cofre-migracao-conta.test.ts` também foi
  corrigido: seu ponto de partida agora é o SQL `20261020` real, não
  uma tabela recriada manualmente com campos ausentes na versão antiga.

**Pendente de teste real:** conferir catálogo e eventuais divergências do
banco correto antes de executar; abrir link, login no navegador, retomada,
descoberta e confirmação no WhatsApp. Tudo depende de autorização explícita.
