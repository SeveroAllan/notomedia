# Link do cofre

Caminho adicional ao painel: `/c/<token>` valida sem consumir (inclusive previews),
`POST /c/<token>/enviar` consome antes de chamar o cofre atual. A URL só sai pelo
WhatsApp vinculado, com as flags e allow-list existentes. Nunca registrar URLs
`/c/*` em access logs do proxy, APM ou analytics. Não registrar corpo do webhook.
Os eventos criado, aberto, enviado e expirado guardam apenas o ID do link e horário.
Expiração é efetiva no banco aos 15 minutos; sua auditoria é gravada ao acessar
um link expirado ou ao substituí-lo. Uma falha não reabre o token.

A IA só classifica o pedido de conexão. Código verifica conta ativa, estado do
cofre, telefone e limite de 3/h antes de criar e enviar. Mensagens com indicação
de credencial e qualquer resposta enquanto existe link pendente são interceptadas
antes da memória e da IA; pedem outro link dentro do limite. Senhas arbitrárias
sem rótulo fora desse contexto não são distinguíveis de texto comum.

Aplicar `scripts/migrations/20261020-cofre-links.sql` **somente após o yes do Allan**.
Nenhuma alteração de Easypanel ou banco de produção faz parte desta entrega.

## Persistência A (implementada, preservada)

Arquivos `.enc` em `COFRE_DIRETORIO`, pela interface atual do cofre. O volume
`tribemd` em `/dados/tribemd` de noto-homolog e as variáveis existentes continuam
sendo usados. Conforme verificação informada por Allan, não há volume de backup.
Depende de backup do volume e de uma única réplica; perda do volume perde os cofres.

## Persistência B (proposta, não implementada)

Manter a mesma interface do cofre, trocando apenas a persistência de
`PerfisTribemd` por `cofre_credenciais(medico_id, agenda, envelope bytea, versao,
atualizado_em)`. AES-256-GCM no app, nonce novo por registro, AAD com médico e
agenda; `COFRE_CHAVE` exclusivamente no ambiente. Envelope versionado para rotação.
RLS ligada sem policies, acesso só service role. Migrar os `.enc` existentes com
validação antes de remover os originais. Depende do yes do Allan e de testes próprios.

Entra no backup do banco, sobrevive a redeploy e permite várias réplicas (também
será necessário substituir a trava de arquivo). Só o banco vazado não abre os
envelopes; banco e chave vazados juntos abrem. Supabase Vault não é recomendado
neste caso: manter a chave no mesmo projeto reduz a separação entre chave e dado.

## Verificação desta entrega

Base `d7319f4`: `npm ci` e `npm test` → 53 arquivos, 688 testes aprovados.
Depois: `npm test` → 54 arquivos, 711 aprovados e 3 condicionais de PostgreSQL.
`COFRE_TESTE_POSTGRES_LOCAL=1 npx vitest run tests/cofre-links.test.ts` → 26/26,
incluindo os 3 condicionais, com PostgreSQL 16 descartável em 127.0.0.1:55432.
Esse modo cria e remove um banco fictício próprio; nunca lê DATABASE_URL.
`npm run typecheck` e `git diff --check` passaram. O repo não tem lint configurado.
Nenhum teste antigo foi alterado. Uma rodada simultânea teve timeout de 5s num
teste fiscal antigo; a suíte isolada passou sem alterar seu teste ou timeout.
WhatsApp e portal TribeMD reais não foram acessados; produção e Easypanel não
foram alterados. A migration foi validada apenas no banco local descartável;
aplicação em Supabase aguarda o yes do Allan.
