# Homologação Noto — trava de US$ 1 por rodada de IA

**Escopo:** testes pagos do assistente via WhatsApp e extração de CRM/RQE no
worker. A trava é no Noto, não depende de alerta da OpenAI. NÃO autoriza
ativar a IA, publicar, aplicar migrações, pesquisar ou enviar mensagens reais.

## Como funciona

- A migração \`scripts/migrations/20261108-noto-piloto-rodadas-ia.sql\`
  prepara o livro-razão compartilhado no PostgreSQL. Aplicá-la depende de OK.
  RLS habilitado, sem acesso \`anon\`/\`authenticated\`; nunca expor reset HTTP.
- O orçamento é **US$ 1,00 por rodada** (1 bilhão de nano-USD).
  Uma rodada **só** inicia com o comando administrativo explícito; restart,
  reconexão, novas mensagens e deploy não resetam o saldo.
- Cada \`Model.getResponse\` do Agents SDK reserva custo máximo antes da
  chamada (inclusive turnos subsequentes com chamadas de ferramentas).
  O cliente OpenAI do piloto usa \`maxRetries:0\`, e o agente limita a saída.
- A extração das fontes da OpenSerp usa o mesmo ledger. O cliente
  \`/chat/completions\` passou a ler \`usage.prompt_tokens\` e
  \`usage.completion_tokens\`; sua retentativa HTTP interna é 1 no piloto.
- Quando a resposta tem usage válido, a reserva é liquidada pelo consumo.
  Sem usage ou após timeout/crash, **a reserva inteira permanece retida**:
  assumir custo zero nessas situações poderia estourar o teto.
- Para \`gpt-4o-mini\` as tarifas configuradas são US$0,15/1M de entrada
  e US$0,60/1M de saída. A pré-reserva considera **128k tokens de entrada
  e 16.384 de saída**, deliberadamente conservadora, mesmo com
  \`maxTokens:1024\` no agente e \`maxTokens:2048\` na extração. Mudança
  de modelo não precificado bloqueia chamadas; revisar tarifa antes
  de aprovar uma rodada em modelo diferente.
- Quando a próxima pré-reserva não cabe no saldo, a rodada pausa
  irreversivelmente. O agente informa isso sem pedir outra chamada à IA;
  o worker pode emitir **um único aviso**, limitado à allowlist.
- Pausa financeira **não conta** como uma das quatro tentativas públicas
  de CRM/RQE. A pesquisa fica pendente para a próxima rodada.
- O processo de piloto isolado com banco **somente leitura** não pode
  reservar orçamento; por segurança, suas chamadas pagas ficam bloqueadas.
  Não atribuir a esse processo uma conexão de banco privilegiada só
  para contornar a trava.

Os valores são controles conservadores para os modelos e chamadas
configurados; não representam o saldo real da conta OpenAI nem custos
não-modelo da infraestrutura/OpenSerp/WhatsApp. Para incluir eventual
tarifação externa da OpenSerp, definir antes uma tabela de preços e
integrar sua reserva ao mesmo ledger; hoje o GET à instância própria
não fornece tokens de modelo.

## Comandos administrativos (APÓS autorização para a migração)

Executar localmente no ambiente de homologação, com
\`NOTO_PILOTO_RESTRITO=true\` e \`DATABASE_URL\`, **sem expor comandos
ou credenciais pelo WhatsApp**:

\`\`\`sh
npm run piloto:rodada -- --status
npm run piloto:rodada -- --confirmar-nova-rodada
npm run piloto:rodada -- --status
\`\`\`

O segundo comando encerra a rodada anterior e cria uma nova. A história
de reservas, erros e consumo não é apagada; o contador novo inicia em zero.
Nenhuma execução automática desse comando é permitida por cron, deploy,
reinício de processo ou evento de mensagem.

## Validação antes de liberar o primeiro teste pago

1. Validar SQL no estado real de homologação **sem aplicar** e confirmar
   integridade de RLS, grants, campos e compatibilidade do ledger.
2. CI de TypeScript, suite completa, 2 gateways pagos com respostas
   simuladas, concorrência entre webhooks e worker, reinício e orçamento
   insuficiente.
3. Revisar a regressão de 03/11 às 18:18 (ferramentas OK mas
   \`FALLBACK_MODELO\`). Não inferir sucesso/fracasso a partir de frase pronta.
4. Com autorização, aplicar SQL e publicar o código verificado, mantendo
   IA e worker de pesquisa pausados até abrir explicitamente a rodada.
5. Iniciar **uma** rodada de US$1 e só então habilitar assistente,
   pesquisa CRM/RQE e envio à allowlist de teste.
6. Executar conversa real de confirmação natural, pesquisa, Cofre,
   retomada e aviso de pausa, com observabilidade sem dados sensíveis.
7. Ao atingir teto, não reativar por mudança de flag: revisar o extrato
   de chamadas (quantidades de tokens e custos) e só iniciar outra
   rodada mediante decisão do responsável.

A PR #44 (memória de objetivos) continua fora de homologação e precisa
de rebase/revalidação sobre a PR #41 atual antes de qualquer publicação.
