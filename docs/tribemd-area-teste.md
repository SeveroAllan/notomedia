> Base unificada: o leitor e a área protegida foram preservados. As suítes mencionadas abaixo descrevem validações anteriores; seus arquivos foram removidos na limpeza solicitada em 17/10/2026.

# TribeMD: área protegida de teste no Noto

Branch: `fix/tribemd-login-area-teste`. Base do repositório: `bbe97e2`.
Referência histórica inspecionada: `b3019f8^`, anterior à remoção do piloto.
Somente `tribemd-display.ts` e `tribemd-rede.ts` foram recuperados e adaptados;
o agente antigo não foi reativado. A área pode ser montada no servidor Noto
ou executada pelo comando independente para desenvolvimento.

## O que foi alterado

- Login: `https://app.tribemd.com/login?continue=/atendimentos/agenda`.
- Agenda: `/atendimentos/agenda`; pacientes: `/pacientes`.
- Subapp Express em `/desenvolvedor/tribemd/`, no mesmo processo e porta do
  Noto. É montado antes dos parsers gerais e tem autenticação própria. Não chama
  emissão, login, parâmetros, IA ou banco do Noto. O modo independente permanece
  disponível para desenvolvimento.
- Página protegida por HTTP Basic, inclusive HTML, JavaScript e capturas.
  Usuário da área: `teste`; senha: `TRIBEMD_TESTE_TOKEN`.
  Essa chave administrativa autoriza todas as clínicas desta área de teste;
  não é uma implementação de acesso multiusuário para clientes.
- Chromium com janela em Xvfb; imagem atualizada a cada segundo durante a sessão,
  com inputs, textareas e campos editáveis ocultados. Sem porta VNC/DevTools.
- Uma sessão ativa por processo, com expiração de vinte minutos. Cada clínica tem
  seu próprio envelope e bloqueio de perfil. O botão de encerrar apaga resultados,
  fecha navegador/Xvfb e preserva apenas a autenticação criptografada.
- Chave AES-256-GCM externa ao volume, nonce aleatório, AAD vinculado à clínica,
  escrita atômica e arquivos `0600`. Senha/e-mail são descriptografados apenas
  para uso; não são devolvidos pela API. Strings JS não permitem garantia de
  sobrescrita física da memória, mesmo depois de remover suas referências.
- Persistência de cookies próprios e das chaves de autenticação
  `bipp-user-token` / `bipp-instituicao`, encontradas no bundle público.
  Caches de pacientes, IndexedDB, resultados e capturas não são persistidos.
  Não se usa um diretório Chromium permanente contendo cookies abertos.
- Botão separado para excluir perfil e credenciais, com a sessão já encerrada.

## Ativar no mesmo app no Easypanel

Usar o branch `fix/tribemd-login-area-teste` no **app web existente do Noto**
e reimplantar. Manter o comando normal `npm start`, o domínio e a porta atuais.
O Dockerfile existente já instala Chromium e Xvfb; não é necessário outro app,
domínio ou porta. Não houve alteração nas dependências ou no Dockerfile.

Na seção **Ambiente** do app atual, adicionar:

```dotenv
TRIBEMD_TESTE_ATIVO=true
TRIBEMD_TESTE_ORIGEM=https://seu-dominio-do-noto
TRIBEMD_TESTE_TOKEN=
TRIBEMD_TESTE_CHAVE=
TRIBEMD_TESTE_DIRETORIO=/dados/tribemd
```

Preencher os dois segredos diretamente no gestor de segredos do Easypanel.
Adicionar um **volume persistente** em `/dados/tribemd` no mesmo app para que
os cookies sobrevivam à reimplantação. Depois, abrir:

```text
https://seu-dominio-do-noto/desenvolvedor/tribemd/
```

| Variável | Requisito |
| --- | --- |
| `TRIBEMD_TESTE_ATIVO` | `true` para ativar. Ausente ou `false`: apenas a área retorna 404, sem criar navegador. |
| `TRIBEMD_TESTE_ORIGEM` | Origem HTTPS do Noto, sem caminho. A barra final é aceita e normalizada. |
| `TRIBEMD_TESTE_TOKEN` | Segredo administrativo aleatório de 32–256 caracteres; senha do usuário HTTP Basic `teste`. |
| `TRIBEMD_TESTE_CHAVE` | Segredo: 32 bytes aleatórios codificados em base64, estável entre implantações. Não reutilizar o token. |
| `TRIBEMD_TESTE_DIRETORIO` | `/dados/tribemd`, em volume persistente. |
| `CHROMIUM_EXECUTABLE_PATH` | Opcional; `/usr/bin/chromium-browser` é o padrão da imagem Alpine. |
| `XVFB_EXECUTABLE_PATH` | Opcional; padrão `Xvfb`. |

Se a configuração estiver ausente ou inválida ao ativar, **somente a área**
retorna 503 com `TRIBEMD_TESTE_NAO_CONFIGURADO`; o Noto continua iniciando.
Desativar exige `TRIBEMD_TESTE_ATIVO=false` e reiniciar o app. O navegador só é
iniciado quando o operador abre uma sessão; o encerramento do Noto também fecha
Chromium/Xvfb. A área compartilha CPU, memória e disponibilidade com o Noto.

A proteção HTTP Basic é exclusiva dessa área e não usa o login OTP do Noto.
Nenhuma credencial de IA, Evolution ou banco é necessária para o teste.
As configurações existentes dessas integrações permanecem no app para os
outros recursos do Noto. Não instalar replay/analytics nesta página nem loggers
que capturem corpo, Authorization ou respostas de `/desenvolvedor/tribemd`.

O proxy HTTPS confiável do Easypanel deve definir `X-Forwarded-Proto` e preservar
Host. O subapp confia em um salto de proxy, sem alterar essa configuração do
app principal. Não publicar a porta do processo diretamente na Internet.
HTTP sem TLS só é aceito para testes em `localhost`/`127.0.0.1`.

### Modo independente opcional

Continua disponível com `node --import tsx scripts/tribemd-area-teste.mjs`.
Só nesse modo se usam `TRIBEMD_TESTE_HOST` (padrão loopback) e
`TRIBEMD_TESTE_PORTA` (padrão 3100). Essas variáveis não alteram a porta do Noto.

## Usar a área

No app Noto, abrir `/desenvolvedor/tribemd/` (no modo independente, `/`).
Autenticar como `teste`, informar o identificador da clínica
e clicar **Abrir navegador**. Acompanhar a tela antes de enviar credenciais.
Digitar e-mail/senha TribeMD e clicar **Entrar e salvar criptografado**.
Depois de entrar, usar **Abrir agenda e ler** ou **Abrir pacientes e ler**.
Na próxima execução, o perfil será restaurado; se expirou, é necessário login.
**Usar credencial salva** é uma ação explícita, sem repetição automática.

A mesma clínica deve ser usada por uma réplica apenas. O bloqueio em disco
impede duas instâncias simultâneas quando compartilham o volume. Se o processo
for morto sem limpeza, pode sobrar um arquivo/diretório `.lock`; só removê-lo
após confirmar que nenhum processo usa aquele perfil. Perder/rotacionar a chave
sem recriptografar os envelopes exige excluir o perfil e autenticar novamente.

## Leitura e limites

A coleta só navega para agenda e pacientes. `/inicio` é permitido como destino
intermediário de autenticação, sem extração nessa página. Não são abertos prontuários,
edição, criação, exportação ou fichas individuais. GET/HEAD/OPTIONS próprios
são permitidos; ações reconhecidas em GET são bloqueadas. O único POST permitido
é um envio explícito de `/api/usuarios/login`, durante autenticação. Depois disso,
POST/PUT/PATCH/DELETE e WebSockets continuam bloqueados. Terceiros são
bloqueados, inclusive trackers, com uma única exceção de leitura: o JSON público
`https://bipp.nyc3.cdn.digitaloceanspaces.com/bipp/static/constantes.json`.
Esse arquivo é necessário para o TribeMD concluir o login. Apenas GET/HEAD
como fetch/XHR são permitidos, com parâmetro público de cache `t` opcional;
cookies, Authorization e chaves de API fazem a requisição ser bloqueada.
Referer é removido. Nenhum outro arquivo ou domínio de CDN foi liberado.
Não se contornam bloqueios de borda. MFA e layouts de desafio não reconhecidos
podem exigir parar o teste; não há resolvedor automático nem controle genérico.

Nas tabelas, a extração lê somente colunas reconhecidas de nome, data e situação,
em até cem linhas visíveis por tabela, no máximo cinco tabelas.

Na leitura simples da agenda em calendário, o leitor observa o GET exato `/api/atendimentos/agenda`
feito pelo próprio portal no navegador autenticado. Não dispara um cliente de API
separado nem abre cartões. Apenas ao clicar **Abrir agenda e ler**, lê a resposta
JSON transitória e seleciona `pacientes.nome`, situação e data dos primeiros cem
atendimentos. Situações `8` (atendido) e `10` (finalizado) foram confirmadas no
modelo JavaScript público. Datas futuras ou inválidas são descartadas.
O resultado informa intervalo do GET, total e eventual corte de cem registros.
Na leitura simples, CPF, telefone, observações e outros campos presentes na
resposta são ignorados pelo extrator e não aparecem no resultado, no perfil ou
no diagnóstico. A ação adicional de dados das consultas está descrita ao final.

O corpo bruto fica transitoriamente na memória do processo/navegador. Há limite
de 2 MiB para aceitar o JSON, verificado pelo tamanho declarado e pelo buffer
recebido; não é um limite de download por streaming. O buffer é sobrescrito após
a leitura, sem garantia de apagar cópias internas ou strings do runtime.
Somente o resultado mínimo é reutilizado na sessão, até nova consulta, navegação
ou encerramento. Nada é enviado à IA, ao banco ou a logs.
A data é a parte de calendário fornecida pelo portal; não se infere fuso horário.
`origemData` distingue `datahora_atendimento` de `datahora_marcada` quando esta
última for usada como alternativa em um registro concluído.

Uma coluna explícita de “última consulta” é identificada como tal. Uma data de
consulta com status realizado é marcada como **consulta realizada observada**;
não comprova ser a última de todo o histórico. Nesse caso, `ultimaConsulta`
fica nula e a data aparece apenas em `dataConsultaObservada`. Agendado, cancelado, data futura
ou inválida não viram consulta realizada. Homônimos não são mesclados.

A agenda é lida pelo intervalo já carregado pelo portal, sem percorrer o histórico.
A página atual é reaproveitada no caminho bem-sucedido. Após uma falha, um novo
clique de leitura recarrega explicitamente o destino, sem reenviar a senha.
Trocas de filtro substituem a resposta anterior, inclusive durante espera por
cabeçalhos/corpo. Não se abre ficha individual nem se mesclam homônimos.
A identificação da última consulta real de todo o histórico permanece pendente
de validação autenticada. O formato do calendário real também precisa ser
confirmado após reimplantar; os testes locais usam respostas controladas.

## Diagnóstico: como ler

`LOGIN_HTTP_ERRO` conserva etapa, status do documento e status de cada chamada
fetch/XHR. Uma página 200 pode conter uma API 404. O observador não publica
corpos, parâmetros, tokens, cookies ou cabeçalhos brutos. `cookiePresente` e
`autorizacaoPresente` são apenas booleanos; presença não comprova sessão válida,
e ausência de cookie pode ser normal numa API com Bearer.

`cf-mitigated: challenge` vira `desafio_cloudflare`;
`x-amzn-waf-action: challenge/captcha` vira sinal fixo correspondente.
Uma infraestrutura Cloudflare ou um 404 isolado não comprova bloqueio de borda.
Diagnósticos ficam apenas no JSON protegido, sem log ou contexto de IA.
Não se inicia trace, HAR, vídeo ou replay de sessão. Capturas são respostas
transitórias, sem arquivos no produto. O navegador pode usar arquivos temporários
próprios durante a execução; Playwright os remove no fechamento normal.

## Resultado verificado neste ambiente — 17/10/2026

| Passo | Resultado |
| --- | --- |
| HTTP público de `/login?continue=/inicio` | 200. |
| HTTP público de `/login?continue=/atendimentos/agenda` | 200. |
| HTTP público de `/atendimentos/agenda` | 200; não comprova acesso autenticado. |
| Rotas no JavaScript público | `/inicio`, `/atendimentos/agenda` e `/pacientes` existem. A hipótese de `/inicio` ser só mock não foi confirmada. |
| Formulário público | Rótulos “E-mail ou CPF” / “Senha”; envio para `/api/usuarios/login`. |
| Chromium com janela e Xvfb | Executado em páginas controladas. |
| Login, leitura, captura e restauração por clínica | Verificados em fixture, sem conta real nem pacientes reais. |
| Chamadas mutantes e isolamento de outra clínica | Verificados em fixture. |
| Diagnóstico 404 + sinais de borda | Verificado em resposta controlada; não é evidência de bloqueio real. |
| Abertura real com Chromium | Falhou em TLS do proxy do ambiente, antes do formulário. Nenhuma credencial enviada. Não foi desativada verificação TLS. |
| Login e última consulta reais | Não confirmados: confiança TLS do navegador e credenciais da clínica ainda necessários. |
| Publicação no Easypanel | Não realizada; não há sessão administrativa autenticada nesta tarefa. |

**Validação direcionada:** quarenta e um testes passaram, sem falhas ou testes pulados,
incluindo painel no prefixo integrado, captura, reabertura do perfil,
criptografia, diagnóstico, configuração incompleta e isolamento do parser.
O teste de prefixo falhou antes da correção e passou depois.
O script de inicialização também foi executado: 401 sem chave e 200 em HTML,
JavaScript e API autenticados. `npm run typecheck` passou. A suíte inteira do
Noto não foi executada.

Comandos:

```sh
npm run typecheck
CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
XVFB_EXECUTABLE_PATH=/tmp/tribemd-xvfb/usr/bin/Xvfb \
node --import tsx --test src/desenvolvedor/tribemd-teste.test.ts
```

Os caminhos acima são os usados na máquina Debian de desenvolvimento. O Xvfb
foi extraído de pacote Debian verificado pelo apt, sem alterar a imagem do Noto.
Na imagem Alpine, usar os executáveis indicados na tabela de configuração.

As instruções `install_script` e `start_skill` foram salvas como rascunho do
ambiente cloud. Revisar/salvar nas configurações e publicar o ambiente é uma
ação separada; não reimplanta o Noto no Easypanel nem comprova uma restauração nova.

## Diagnosticar configuração sem expor segredos

Se aparecer `TRIBEMD_TESTE_NAO_CONFIGURADO`, o JSON agora lista `pendencias` com
o nome da variável e a regra rejeitada, sem seu valor. URL com barra final é
normalizada; caminho como `/desenvolvedor/tribemd/` dentro de
`TRIBEMD_TESTE_ORIGEM` continua inválido: a variável é apenas a origem do Noto.

No terminal do mesmo app web em que adicionou as variáveis, executar:

```sh
node --import tsx scripts/diagnosticar-tribemd.mjs
```

Esse comando não inicia o app, banco, navegador ou IA. Mostra somente `ativo`,
`configuracaoValida` e as pendências. É seguro compartilhar esse JSON; não
compartilhar o conteúdo de `.env` ou a tela com os valores do ambiente.

`TRIBEMD_TESTE_CHAVE` exige 32 bytes aleatórios codificados em base64 canônico
(44 caracteres terminando em `=`). Uma senha de 32 caracteres ou uma chave em
hexadecimal não tem esse formato. Não substituir uma chave válida já usada
para criptografar perfis; é necessária para recuperar os cookies existentes.

## Login responde 200, mas permanece em confirmando_login

O diagnóstico real enviado pelo usuário mostrou POST `/api/usuarios/login`
com HTTP200 e leitura do CDN falhando. O código público do TribeMD mostra que
o fluxo de login aguarda `atendimento/reloadConstantes`, que lê
`bipp/static/constantes.json`. A política anterior bloqueava esse domínio.
HEAD sem autenticação nesse arquivo retornou HTTP200 e application/json.

Foi reproduzido com Chromium/Xvfb em uma fixture que exige esse JSON após o
login: antes da correção houve timeout mesmo com API200; depois, o fluxo
concluiu. A correção autoriza apenas esse recurso público, nas condições acima.
Isso não confirma a conclusão do login da conta real; é preciso reimplantar
o branch e abrir uma nova sessão para validar no TribeMD.

Falhas causadas pelo próprio guard agora aparecem como
`falha: "bloqueada_politica"`, em vez de `conexao`. Bloqueio pelo cliente sem
marcação do guard aparece como `bloqueada_cliente`. A existência de
`infra_cloudflare` sozinha não prova desafio ou recusa de acesso.

## SPA já entrou, mas o piloto retorna LOGIN_NAO_CONFIRMADO

Depois da correção do CDN, o diagnóstico real mostrou `/api/usuarios/me` e
`/api/usuarios/info` com HTTP200, além do início da leitura da agenda. Isso
mostra avanço, mas não permite inferir, somente pelos códigos HTTP, qual era
a estrutura final da tela ou se uma requisição sem status falhou.

Foram reproduzidos três falsos negativos do detector antigo: formulário de
senha oculto mantido no DOM, ícones junto ao texto de navegação e menus que
aparecem depois da mudança de rota. A confirmação agora espera uma condição
única da SPA: origem e rota privadas conhecidas, ausência de senha visível e
links, controles ou títulos visíveis reconhecidos. Ícones não invalidam um
link cujo destino privado é conhecido. Menu oculto sozinho não confirma login;
um título reconhecido e visível pode confirmar a página com menu recolhido.
Não se aguarda toda a leitura da agenda para reconhecer a autenticação.

Se a confirmação falhar, `diagnostico.tela` informa somente categoria da página,
booleanos e contagens de senha visível/oculta, links e títulos reconhecidos.
Não inclui os textos, valores dos campos, nomes ou URLs privadas.
`rede.chamadas[].aguardandoResposta=true` significa que não havia status HTTP
nem falha no momento do registro; não é confirmação de erro da chamada.
A captura de diagnóstico é um retrato daquele momento, não uma consulta de
rede atualizada depois do encerramento da observação.

O fluxo permanece com um único envio de senha. O botão **Confirmar login /
verificação concluída** reavalia a tela atual sem reenviar credenciais. A
correção foi verificada com fixtures; o resultado da conta real ainda deve
ser confirmado após reimplantar o branch e abrir uma nova sessão.


## CONTROLE_INDISPONIVEL depois de abrir a agenda

O relatório do usuário chegou à etapa `leitura_agenda`, iniciada apenas após
confirmar login. O leitor anterior procurava tabela, apesar de a agenda usar
calendário, e ainda reutilizava o diagnóstico de rede do login. O painel tratava
qualquer falha como intervenção de login e permitia clicar na imagem/Confirmar;
o navegador já autenticado recusava essas ações com `CONTROLE_INDISPONIVEL`.

Agora a API publica `autenticado` a partir do navegador. Uma falha de leitura com
sessão autenticada fica em `falha_leitura`: leitura pode ser repetida e controles
de login ficam desativados. Erros de ações são exibidos separadamente, preservando
o erro e diagnóstico principal. HTTP401 na agenda invalida a autenticação;
HTTP403/503 não a invalidam por si só. Encerrar e reabrir continua disponível.
O diagnóstico de leitura tem fases `leitura_agenda` ou `leitura_pacientes`;
`reutilizada:true` indica a chamada já iniciada/carregada pelo portal antes do
clique de leitura. Parâmetros e corpo não aparecem nesse diagnóstico.

Testes Chromium/Xvfb cobrem calendário sem tabela, ausência de reload no sucesso,
HTTP401/403/503, retry503→200 sem novo envio de senha, desativação dos controles
e manutenção do diagnóstico. Fixtures adicionais cobrem status, datas, campos
ignorados, formato vazio/desconhecido, limites e substituição/encerramento de
consulta enquanto cabeçalhos ou corpo anteriores estão pendentes.
A conta real não foi acessada neste ambiente; o resultado informado pelo usuário
é a evidência do avanço do login, sem confirmação local do conteúdo da agenda.


## Dados das consultas atendidas e finalizadas

A ação **Ler agenda e dados das consultas** primeiro lê o recorte da agenda e,
para os estados Atendido (`8`) e Finalizado (`10`), consulta os detalhes no mesmo
navegador autenticado. A leitura simples anterior permanece disponível.
A coleta usa apenas GET em `/api/atendimentos/{id}` e, quando necessário para
completar o cadastro, `/api/pacientes/{id}`. Esses caminhos e os nomes dos campos
foram identificados nos modelos JavaScript públicos do próprio portal, cuja
função de leitura por ID usa esses endpoints. Ainda não são uma API pública
contratada nem uma garantia sobre a resposta da conta real.

O vínculo exige ID da consulta e ID do paciente obtidos da agenda; não busca por
nome nem mescla homônimos. IDs das respostas devem coincidir e o status da
consulta é revalidado antes de exportar os campos. Registro que mudou para
outro status ou paciente fica com código de pendência, sem coletar o novo cadastro.
Nenhum editor, prontuário, histórico clínico ou comando de gravação é aberto.

O objeto `dados` em cada consulta contém:

- `nomeCompleto` e `cpf` (somente dígitos, quando o formato for reconhecido).
- `contato`: `celular`, `telefone`, `email`, com valores ausentes como `null`.
- `valorConsulta`: campo `valor` do atendimento, em decimal com duas casas.
- `valorCobrado`: campo `valor_cobrado`, separado do valor da consulta.
- `pendencias` e eventual `codigo`, sem mensagens brutas nem conteúdo clínico.

Zero monetário é preservado. CPF com formato reconhecido não implica validação
cadastral ou de dígitos verificadores. CPF divergente entre as duas fontes é
omitido e sinalizado. Campos válidos do atendimento são preservados quando o
cadastro complementar não fornecer substitutos. Valores não comprovam pagamento,
recebimento, elegibilidade fiscal ou ausência de nota fiscal.

O leitor reaproveita apenas os cabeçalhos necessários da chamada autenticada de
agenda, na mesma origem fixa; não envia cookies/tokens a outro servidor nem segue
redirecionamentos. A seleção de campos ocorre dentro do navegador, antes de
retornar ao processo Noto. Corpos de detalhes têm limite de 2 MiB por leitura,
verificado durante o streaming; timeout de oito segundos por GET e sessenta
segundos para o conjunto, limitado aos cem registros do recorte. Pendências e
registros ainda não processados constam no resumo `detalhes`.
Os resultados continuam apenas na RAM da sessão, sem IA, banco, arquivos ou logs.
Encerramento, expiração e nova leitura removem o resultado anterior.

Nesta ampliação foram executadas a checagem de tipos TypeScript e a checagem de
sintaxe do JavaScript do painel/leitor. Não foram adicionados ou executados testes
neste turno. Os 41 testes descritos acima correspondem à versão anterior.
A forma efetiva das respostas dos detalhes na clínica e a completude dos campos
precisam ser confirmadas pelo operador após reimplantar o branch.

### Sincronização sob demanda em homologação

`app.locals.sincronizarAgendaHomologacao(medicoId, agora?, janelaDias=90)`
verifica `medico_perfil_fiscal.ambiente=homologacao` antes de abrir o portal.
É a mesma função usada pela consulta de pendências da conversa e, para TribeMD,
antes da seleção de consulta pelo comprovante. Não há cron nem rota pública nova.
A janela aceita de 1 a 365 dias; o padrão é 90. O navegador retrocede pelo botão
reconhecido da agenda e observa apenas os GETs disparados pelo portal. Intervalo
incompleto, paginação sem avanço, lacuna ou recorte truncado produzem erro; nunca
são apresentados como zero pendências.

Na escrita, o telefone e suas variantes brasileiras resolvem `pacientes.id`.
Quando não existe cadastro, cria-se paciente mínimo com nome nulo e origem
`agenda_tribemd_sync`; nome, CPF e credenciais do portal não entram nesse cadastro.
O upsert mantém a chave `(medico_id, fonte, id_externo)`. O resultado transitório
original continua indo ao critério determinístico do comprovante, sem mudar suas
regras de vínculo, ambiguidade, confirmação ou emissão. Falhas ficam em registros
marcados `NOTO_ERRO`, com contexto sanitizado; a conversa recebe texto humano.

### Retorno ao WhatsApp após salvar o acesso

O POST de envio do link seguro retorna HTML 202 com **Acesso salvo** e o botão
preto **Voltar para o WhatsApp**, usando os tokens de `src/ui/index.html` e Geist.
O número do deep link é lido da identidade da instância assistente na Evolution;
nunca usa o telefone do médico ou outra instância. Se essa leitura falhar, o botão
apenas abre o WhatsApp; a continuação automática não depende dele.

A conclusão real do navegador chama `LinksCofre.concluir`. O evento usa o ID e a
agenda da linha consumida do link, e passa pelo pipeline da conversa. Com acesso
validado, o Noto confirma o recebimento, verifica a agenda e informa o resultado.
Uma falha identificada de acesso orienta revisar login/permissão na área segura da conta;
falha técnica usa mensagem de instabilidade, sem código ao médico. O evento tem
reserva idempotente, memória com autor Noto e até três balões; não cria fala fictícia
do médico nem libera emissão fiscal. Flags, homologação e allowlist são verificadas
antes da continuação e novamente no transporte. Sem mensagens ao paciente.

Captura local renderizada com Chromium em viewport móvel 390×844, Geist carregada,
sem credenciais e com telefone fictício no destino do botão:
[acesso-salvo.png](evidencias/acesso-salvo.png).
