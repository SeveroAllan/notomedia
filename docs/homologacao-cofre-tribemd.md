# Cofre TribeMD — homologação isolada (pré-revisão)

**Não implantar nem realizar login real antes da autorização.** Não requer migração.

## Imagem
Build: `docker build -f Dockerfile.homologacao -t noto-homolog-cofre:review .`.

A imagem roda **`npm run start:homologacao`** (não `npm start`), com Chromium, Xvfb, bibliotecas do sistema e Playwright-core. `start:homologacao` força `NOTO_PILOTO_RESTRITO=true`. Permanecem obrigatórios **um único telefone na allowlist**, Evolution isolada, HTTPS público, `NOTO_WORKER_EMBUTIDO_ATIVO=false`, `AGENTE_FISCAL_ATIVO=false`, `PREPARACAO_FISCAL_ATIVA=false` e emissão desligada.

**Não usar o Dockerfile.piloto-agente**: esse processo apenas lê perfis anteriores e não oferece login novo na TribeMD via página segura.

## Cofre exclusivo
No orquestrador, após aprovação, criar **volume nomeado próprio**, por exemplo:

`noto_homolog_cofre:/dados/noto-homolog-cofre`

Sem volume compartilhado com produção ou piloto, nem bind mount de `/dados/tribemd`. Uma única réplica, acesso de escrita restrito ao serviço e backup criptografado do volume. O diretório efetivo de perfis é `COFRE_DIRETORIO/cofres-contas-v1`.

Configurar **no gerenciador de secrets**, nunca no Git:

| Variável | Configuração requerida |
| --- | --- |
| `COFRE_DIRETORIO` | `/dados/noto-homolog-cofre` no volume dedicado persistente |
| `COFRE_CHAVE` | Chave **nova** de 32 bytes aleatórios base64, gerada fora do repo (`openssl rand -base64 32`). Mantê-la estável entre publicações |
| `COFRE_ORIGEM` | URL pública HTTPS **exata** da homologação, igual a `APP_PUBLIC_ORIGIN`, sem caminho/query |

O Cofre de homologação não aceita os aliases `TRIBEMD_TESTE_DIRETORIO`, `TRIBEMD_TESTE_CHAVE` e `TRIBEMD_TESTE_ORIGEM` como fallback, nem o caminho conhecido `/dados/tribemd`. Não migrar nem copiar perfis existentes. O envelope criptografado AES-256-GCM inclui credenciais e sessão; não trocar a chave sem planejar migração. Sem volume persistente, conexão se perde na nova publicação.

A configuração ausente ou inválida desabilita apenas a conexão; a assistente informa **"integração não configurada neste ambiente"**, não uma falha da TribeMD, e não pede para tentar mais tarde. A senha é informada **exclusivamente** na página segura com link de curta duração, nunca pelo WhatsApp. O link usa consentimento e controles de origem/telefone existentes.

## Checklist para o teste real, somente após autorização

1. Confirmar volume novo montado com permissões de leitura/escrita e a chave secreta estável.
2. Confirmar HTTPS, proxy, origem exata e ausência de logs de `/c/*` ou corpos de credenciais.
3. Pedir link pelo WhatsApp da allowlist; entrar na TribeMD **na página segura** e confirmar leitura, sem pedir senha no chat.
4. Recriar o container/publicar novamente **mantendo o volume/chave** e confirmar persistência e isolamento do piloto.
5. Conferir que worker fiscal/emissão continuam desligados e avaliar separadamente falha de login/2FA/CAPTCHA sem contornar controles.

Testes e Docker build **não comprovam login no portal real, rede, proxy, persistência entre publicações ou MFA**. Também não autorizam tráfego pago ou deploy.
