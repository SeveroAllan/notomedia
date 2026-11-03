# Entrega do link seguro — diagnóstico e plano controlado (sem envios reais)

## Fatos verificados em código e ocorrências comunicadas

A ocorrência recente relata: o token de 32 bytes gerado para a conta correta é
persistido somente por SHA-256 em `cofre_links.token_hash`, dura 15 minutos e
não foi consumido. A chamada `/message/sendText/{instance}` contendo a URL
recebeu aceite e o estado da Evolution chegou a `SERVER_ACK`, sem
`DELIVERY_ACK` ou `READ`. Seis balões sem URL tiveram leitura confirmada.
Duas ocorrências anteriores retornaram `ERROR` nos balões com URL.
O evento `aberto` na auditoria é registrado por `GET /c/:token`, incluindo
pré-visualização ou scanners, e **não prova clique ou abertura pelo usuário**.

O código versionado em `src/io/evolution/evolution-api-client.ts` usa
`POST /message/sendText/{instance}` com `{number,text}`, sem `linkPreview`
explícito. A chamada responde `sucesso: true` ao receber HTTP 2xx e pode
retornar `key.id`. Não acompanha o dispositivo. Os dois caminhos
`LinksCofre.solicitarLinkCofre` e `solicitarLinkConta` enviavam uma
mensagem composta **apenas pela URL** como último balão, e usavam `enviado`
na auditoria já no aceite. O Agent anotava `LINK_ENVIADO` e tratava como
tarefa concluída. **Isso explica a afirmação indevida, não a causa da
falta de entrega.**

A versão do Noto no `package.json` é `notomed-whats@0.1.0`. Segundo
verificação controlada comunicada pelo operador, a Evolution do assistente
está em **2.4.0-rc2**. Essa versão **não é fixada no repositório**: Evolution roda
em serviço externo configurado por `EVOLUTION_ASSISTANT_URL`,
`EVOLUTION_ASSISTANT_GLOBAL_API_KEY`/`EVOLUTION_ASSISTANT_API_KEY` e
`EVOLUTION_ASSISTANT_INSTANCE_NAME`; a configuração executada no Easypanel
não pertence ao repositório. Conferir versão da **instância emissora**
(e não a Evolution oficial separada para OTP), tag/digest da imagem,
webhook ativo, Redis e estado da sessão por inspeção autorizada; não
registrar segredos nem acessar o serviço sem autorização.

## Evidência controlada comunicada pelo operador (03/11/2026)

Na **mesma instância do assistente Evolution 2.4.0-rc2**, com o mesmo
destinatário autorizado e a **mesma URL pública inofensiva
`https://example.com/`**:
- Com `linkPreview:true`, a mensagem ficou em `SERVER_ACK`, sem
  `DELIVERY_ACK` nem `READ`; não chegou no aparelho.
- Com `linkPreview:false`, houve `DELIVERY_ACK` e `READ`; o
  operador confirmou que recebeu e leu a mensagem.

A comparação isolou o fator prévia **nessas condições** e justifica
preparar sua desativação **somente no balão da URL segura**. Não demonstra
que o domínio Easypanel está bloqueado, nem garante entrega de links
reais do Cofre ou de todas as mensagens. O teste com token verdadeiro
está pendente de autorização separada.

## Nova evidência diretamente comparável (22/10/2026)

O issue **#2762 da Evolution**, publicado em 22/10/2026, descreve um
teste na versão **2.4.0-rc2** (Baileys): duas chamadas
`POST /message/sendText/{instance}` com **mesma URL, remetente, domínio
e destinatário**, alterando apenas `linkPreview`.
Com `true`, a mensagem permaneceu em PENDING e não foi entregue;
com `false`, chegou. O relato inclui uma hipótese de diferença na
estrutura `contextInfo.externalAdReply`; **não demonstra que a
versão instalada no Noto é essa nem que esse seja o defeito de nossa
instância**. A versão e o payload efetivo do assistente continuam
desconhecidos. A prioridade diagnóstica passa a ser **preview x
caminho Baileys na versão real**, antes de atribuir ao domínio.

Referência: https://github.com/evolution-foundation/evolution-api/issues/2762

Também há ocorrência em **2.3.7** onde encaminhamento com JID
`@s.whatsapp.net` falha em `ERROR` e o mesmo contato pelo identificador
`@lid` funciona. Isso motiva examinar, **sem mudar o envio**, o
mapeamento de destinatário PN/LID nos logs/versionamento reais.
Referência: https://github.com/evolution-foundation/evolution-api/issues/2689

**Atenção ao webhook:** a documentação oficial confirma que, ao
habilitar `webhookByEvents=true`, `MESSAGES_UPDATE` será enviado à rota
`/messages-update` acrescentada à URL, **não** ao receptor atual
`/webhook/evolution`. Assim, o plano atual de ativação só é
compatível com `webhookByEvents=false` e URL base correta; qualquer
outra opção requer nova revisão de roteamento.
Referência: https://github.com/evolution-foundation/evolution-docs/blob/main/docs/02-Configuration/Webhooks.md

## O que a documentação atual autoriza afirmar

- `sendText` com `text` na raiz do corpo e opção `linkPreview`
  é compatível com Evolution API v2. Existem relatos específicos de
  indisponibilidade/variação de preview em 2.3.6. **Não presume que desligar
  preview conserte um SERVER_ACK sem DELIVERY_ACK.**
- `MESSAGES_UPDATE` é evento de mudança de status. Correlacionar
  `data.keyId` (ou `data.key.id` conforme versão) ao `key.id` retornado
  no envio, respeitando `instance`, `fromMe` e destinatário.
- `SERVER_ACK` = aceite do servidor WhatsApp; `DELIVERY_ACK` =
  confirmação de entrega ao dispositivo; `READ` = leitura informada;
  `ERROR` = erro registrado da mensagem. Estados podem pular etapas
  ou chegar fora de ordem. **Sem confirmação após N minutos não é ERROR**.
  A confirmação de leitura pode não existir se o usuário a desativar.
- Evolution v2.3.7 tem relatos em que uma instância retorna PENDING e
  depois ERROR enquanto outra na mesma instalação entrega normalmente.
  Logo, mesmo uma diferença entre texto e URL não identifica
  automaticamente bloqueio de domínio.
- `/message/sendButtons`, listas e templates são recursos condicionais
  ao canal, versão e tipo de conta. Não se presume suporte a botão/CTA
  do WhatsApp Cloud API em Baileys. Enviar preview ou mídia externa com
  URL sensível também introduz possíveis acessos não humanos; não é
  fallback autorizado.

Fontes: https://github.com/evolution-foundation/evolution-api/releases ;
https://github.com/evolution-foundation/evolution-api/issues/2262 ;
https://github.com/evolution-foundation/evolution-api/issues/2633 ;
https://github.com/evolution-foundation/evolution-api/blob/main/src/validate/instance.schema.ts ;
https://github.com/evolution-foundation/evolution-docs/blob/main/docs/02-Configuration/Webhooks.md .

## Correção de honestidade e recibos, SEM mudar o meio de envio

O aditivo desta PR altera **somente o parâmetro `linkPreview:false`**
no `POST /message/sendText` que transporta o balão da URL segura, tanto
para conta sem médicos quanto para vínculo legado por médico. O cliente
aceita o parâmetro opcionalmente e continua emitindo **apenas
`{number,text}`** nas demais mensagens, incluindo balões de orientação.
Não muda domínio, URL, número, instância, canal nem oferece reenvio
automático. Mantém token de uso único, hash, validade de 15 minutos e
senha informada exclusivamente na página HTTPS.
`LINK_ACEITO_PARA_ENVIO` substitui `LINK_ENVIADO` no diagnóstico:
aceite HTTP não conclui a tarefa nem justifica ✅. O agente não pode
afirmar recebimento sem prova. Novo evento passivo `messages.update`
é tratado com validação do segredo/instância e só atualiza um recibo
pertencente à conta, sem enviar mensagens.

A nova tabela `public.cofre_links_entregas` tem somente link_id, ID
opaco da mensagem, instância, HMAC do destino, estado e horários.
**Não guarda token, URL, corpo da mensagem, senha ou telefone bruto**.
`20261107-cofre-links-estado-whatsapp.sql` exige a reconciliação
`20261106` antes de ser aplicado. Mantém RLS e revogação de
`anon/authenticated`. Uma falha de persistência do recibo **não autoriza
uma segunda tentativa de envio**; é aceitação sem correlação,
que precisa de revisão manual. A ausência de status atualizado não
invoca uma fila de reenvios.

### Estado que o Noto pode comunicar

| Comprovação | Estado seguro | Mensagem ao usuário |
| --- | --- | --- |
| HTTP 2xx/ID | `ACEITO_API` | Pedido aceito; ainda não sei se foi entregue |
| `SERVER_ACK` | `AGUARDANDO_ENTREGA` | Servidor recebeu; aparelho não confirmou |
| `DELIVERY_ACK` | `ENTREGUE` | WhatsApp confirmou entrega ao aparelho |
| `READ` | `LIDO` | Foi registrada leitura, não abertura do link |
| `ERROR` | `ERRO_COMPROVADO` | Falha registrada, sem reenvio automático |
| Tempo sem callback | `SEM_CONFIRMACAO` | Sem confirmação; atraso não prova erro |

`aberto` é evento HTTP GET à página, NÃO delivery/read do WhatsApp e
NÃO uma ação de autenticação. O formulário só consome o token em POST
válido e mantém a senha exclusivamente na página segura.

## Plano de teste (somente APÓS autorização de mensagens reais)

**Pré-condições de leitura, sem enviar**: registrar versão exata,
imagem/tag/digest, canal WHATSAPP_BAILEYS vs Cloud API,
`EVOLUTION_ASSISTANT_INSTANCE_NAME`, URL do gateway (sem credenciais),
estado da sessão, configuração de `webhookByEvents` e se
`MESSAGES_UPDATE` está habilitado. Verificar o caminho do evento e seu
formato real. Não habilitar fallback, não alterar domínio ou canal.

O experimento exige controle explícito pelo usuário, intervalo curto,
destinatário único da allowlist e **URLs inofensivas, sem tokens reais**.
Separar fatores, mantendo um único fator diferente por rodada:

1. Controle: mensagem de texto sem URL e mesmo remetente/destinatário.
2. Formato: URL **de teste** sozinha versus frase + **mesma URL** no
   `sendText`, com mesmas opções. Comparar IDs e estados finais.
3. Preview: com versão verificada que suporte `linkPreview`,
   comparar `true` versus `false`, sem mudar domínio e sem preview
   manual do URL real do Cofre.
4. Domínio: no mesmo formato/canal, comparar dois domínios
   controlados com a mesma página **pública inofensiva**. Qualquer
   domínio alternativo (inclusive próprio) requer aprovação antes
   de configurar. `easypanel.host` é apenas hipótese; observar DNS,
   TLS, redirecionamentos e reputação sem abrir `/c/<token>`.
5. Caminho: somente se domínio/formato/preview não explicarem,
   comparar a mesma URL inofensiva por `sendText` direto à instância
   Baileys e pelo caminho intermediário previamente aprovado,
   sem assumir Cloud API, botão ou template.

Para **cada mensagem**: guardar sem conteúdo o ID da resposta,
HTTP, ID da instância, estado `PENDING/SERVER_ACK/DELIVERY_ACK/READ/ERROR`
e timestamps; registrar captura do aparelho do remetente/destinatário
quando disponível. Se status não chegar, usar `SEM_CONFIRMACAO`
(sem chamar ERROR). Não repetir tokens verdadeiros nem testar
links consumidos ou vencidos. Comparar amostras com mesmo
destinatário e janelas separadas para não confundir anti-spam/rate limits.

**Critério de aceitação**: o Noto só afirma entrega quando há
`DELIVERY_ACK` ou `READ` correlacionado ao ID, instância e contato
do link; nenhuma tarefa finalizada ou ✅ com apenas HTTP 2xx; nenhum
reenvio automático, nenhum vazamento de URL/token; eventos estranhos
ou de outra conta/instância ignorados.

## Ordem e limites

1. Revisar a PR e a migração `20261107`, sem aplicá-la.
2. Após outro OK, aplicar `20261106` (se ainda não aplicado), depois
   `20261107`, antes de publicar o código; não aplicar migrations no escuro.
3. Habilitar `MESSAGES_UPDATE` **somente após inspeção e aprovação da
   configuração Evolution existente**, preservando `MESSAGES_UPSERT`
   e segredo do webhook; `byEvents` determina a rota.
4. O ensaio com `https://example.com/` foi feito pelo operador e
   reportado antes deste aditivo; **nenhuma mensagem de teste foi
   enviada durante o desenvolvimento**. Somente após autorização específica,
   testar o link real do Cofre em conta e médico legado. Não alterar
   domínio, canal, formato de balões ou configuração da Evolution.

**Provas automatizadas adicionais**:
`tests/cofre-link-preview.test.ts` intercepta `fetch` localmente,
inspeciona o corpo JSON enviado à rota `sendText` nos caminhos por
`conta_id` e por `medico_id`, exige `linkPreview:false` **somente**
no terceiro balão, confirma ausência da opção nos balões normais,
preservação de hashes, validade de 15 minutos, uso do callback de recibo
e ausência de preview em envio comum de texto e mídia. Não há tráfego
externo nem necessidade de rodar IA.

Em rollback do código, preservar a tabela de recibos sem leitura pública;
nunca apagar tokens ou links em uso nem alterar o Cofre persistente.
