# Assistente contextual do Noto

## Contrato do produto

Implementação própria, inspirada em padrões de contexto contínuo, memória e
trabalho paralelo estudados na Briglia. Nenhum código da Briglia foi incorporado.

A jornada desejada é: cadastro e vínculo WhatsApp por OTP; conversa sobre agenda;
identificação e associação dos profissionais; certificado por link seguro;
preparação automática; levantamento dos atendimentos; autorizações de emissão e
entrega; acompanhamento até autorização fiscal, PDF e entrega confirmada.
Essa ordem expressa dependências. Informações antecipadas, correções, mudanças de
assunto e tarefas demoradas não reiniciam a jornada.

O núcleo existente continua como autoridade para cadastro, certificados,
parâmetros, pesquisas, cofre, agendas, emissão e PDF. O novo código deste
incremento está exclusivamente em arquivos novos.

## Base de integração e piloto desligado

Esta branch parte exatamente de `1dbe650` da
`tmp/homologacao-pr6-pr7-pr8-ste100`. Foi trazido somente o incremento
`e551ede` da `work`, com ajustes nos arquivos novos. Não foi feito merge da
`work`, `main` ou `feat/conversa-v2`.

O processo é independente e permanece desligado. Este trabalho não aplica
migrações, muda variáveis na VPS, reconfigura webhook ou publica em homologação.
A branch não liga o piloto pelo simples fato de ser implantada no aplicativo
principal: o comando padrão continua sendo `npm start`.

Os ajustes de compatibilidade usam `completarOpenAi`, o contrato de reasoning
para modelos `gpt-6`, acesso de leitura aos médicos da mesma conta sem exigir
usuário próprio e as travas de operação em homologação, flag e allowlist de
telefone. A instância do assistente não é configurada como canal exclusivo OTP.

Os motores de conversa, memória, permissões, foco do operador, agenda e links
seguros já existentes na homologação permanecem como estão. Este piloto tem
memória própria e não migra ou substitui a conversa já ativa. Para um piloto
futuro, reservar uma instância exclusiva que não seja atendida simultaneamente
pelos motores existentes.

## Primeiro incremento implementado

Um processo independente atende `POST /webhooks/assistente` e usa a instância
dedicada do assistente na Evolution. O webhook original continua disponível
para a função atual. Os dois processos podem compartilhar a mesma VPS e banco.

O webhook novo valida segredo, instância, evento, conversa privada e remetente.
Ignora ecos, grupos e histórico. Aceita telefone direto e LID acompanhado do
telefone; dois telefones conflitantes são rejeitados. Apenas texto é tratado.
O remetente precisa corresponder a exatamente um usuário ativo cadastrado, com
identidade de autenticação, incluído na lista explícita de usuários piloto.
Números ambíguos, desconhecidos e usuários fora do piloto não recebem resposta.
Conta e usuário são resolvidos no backend; não são aceitos do modelo ou payload.

Cada entrada é persistida transacionalmente com uma chave da instância e da
mensagem. Reentrega do mesmo evento não cria outro pedido ou mensagem.

O agente usa o cliente OpenAI existente. A saída JSON é validada por Zod antes
de qualquer gravação. Pode responder, propor atualização de agenda, período e
nomes informados, e pedir consulta de preparação de médicos permitidos.
Não há ferramenta de emissão, aprovação fiscal, entrega de nota, criação de
médico ou conexão de agenda nesta versão. O modelo não recebe certificados,
credenciais ou XML pela ferramenta de preparação.

O especialista de preparação reutiliza `consultarStatusOnboarding`. Seu resultado
contém indicadores do checklist, fonte e horário da consulta. O significado desses
indicadores é o da base existente; não se acrescenta uma nova validação de
certificado nem se interpreta prontidão como autorização para emissão.

## Contexto e memória

`assistente_memorias` guarda agenda, período e nomes de profissionais declarados.
Informações ausentes numa resposta não apagam valores anteriores. Correções
explícitas podem substituir valores; a extração continua sendo uma proposta do
modelo e nunca atualiza cadastro profissional ou perfil fiscal.

`assistente_mensagens` conserva entradas, mensagens de resultado e respostas
confirmadas pelo transporte. O contexto usa as últimas 20 mensagens até o evento
em processamento, memória estruturada e até 10 trabalhos recentes permitidos.
Não existe compactação automática ou busca semântica nesta etapa. Mensagens
antigas continuam no banco; preferências não representadas nos três campos
estruturados podem sair do contexto recente. A interface para recuperação e
resumos com referências às fontes é um próximo incremento.

`assistente_trabalhos` mantém entradas, consultas e saídas, inclusive após
reinício. Cada decisão conserva a versão de memória proposta no resultado do
trabalho, ligada à chave da mensagem original. Isso permite revisar sua origem.
Essa trilha registra decisões e resultados, sem armazenar raciocínio interno.

Nesta etapa a memória é privada por usuário dentro da conta. Compartilhar fatos
entre membros da conta exige definir quais fatos e quem pode consultá-los;
não há compartilhamento implícito de conversas.

## Concorrência, retomada e comunicação

Há três filas persistentes: `conversa`, `preparacao` e `envio`. Cada uma tem uma
passagem independente. Uma consulta em execução não bloqueia uma nova conversa.
A versão inicial executa um trabalho de cada tipo por processo; múltiplos
especialistas simultâneos e limites por conta são evoluções posteriores.

Conversas do mesmo usuário são ordenadas e possuem exclusão no banco. Leituras
e chamadas de modelo podem ser retomadas após uma reserva de três minutos.
Token novo invalida a gravação do consumidor antigo. Concluir uma conversa grava
memória, trabalhos e resposta a enviar na mesma transação.

Uma consulta concluída persiste resultado e cria uma continuação da conversa na
mesma transação. O modelo recebe esse evento como resultado do sistema, não
como uma nova autorização do cliente.

Antes de enviar pelo WhatsApp, a saída fica `incerto`. Apenas resposta com ID de
mensagem confirma o envio e entra no histórico como fala do Noto. Timeout, falha
ou interrupção não reenviam automaticamente. Uma saída incerta bloqueia as
saídas seguintes daquele usuário para evitar inversão e duplicação. Essa escolha
prefere revisão operacional a repetição de mensagens quando falta confirmação.

Erros de modelo ou consulta ficam `falhou`, com código interno e aviso simples
ao cliente, sem pedir investigação técnica. Nesta etapa o acompanhamento de
falhas é operacional por logs/banco; não existe especialista de recuperação
automática. Não se apresenta esse aviso como resolução do pedido.

### Diagnóstico de execução interrompida

O piloto relatado respondeu ao “oi” e falhou ao processar “Amplimed”, antes de
salvar a agenda ou executar preparação. O registro antigo guardou somente um
erro genérico. Não é possível reconstruir sua causa com essa evidência.

Para novas falhas, o worker registra a etapa exata, classe, código técnico e
mensagem com dados sensíveis ocultados. Preserva status HTTP quando o cliente
compartilhado o fornece e SQLSTATE/restrição quando disponíveis. Erros de
contrato registram caminho do campo e código da validação, sem valores ou
chaves inesperadas. JSON inválido não tem seu conteúdo copiado para o erro.
Não se guardam corpo bruto do provedor, detalhes de linhas SQL ou credenciais.

O mesmo diagnóstico vai para o log JSON e `resultado.diagnostico` do trabalho.
Se gravar a falha no banco também falhar, o log conserva o erro original e
registra separadamente a falha em `registrar_falha`. Envios incertos recebem
diagnóstico sem mudar seu estado ou permitir nova tentativa. Falhas ao reservar
trabalho ficam apenas no log, pois ainda não há um trabalho reservado.

O aviso agora é: “Não consegui concluir esse pedido. A execução parou e não
está sendo retomada automaticamente.” Registrar a falha não agenda recuperação,
não pede repetição da mensagem e não confirma resultado. Esse texto vale para
novas falhas; saídas já persistidas não são reescritas ou reenviadas pelo ajuste.
Nenhum trabalho antigo é reaberto automaticamente. Os erros 429/503 dos testes
são cenários simulados, não um diagnóstico da falha real com “Amplimed”.

Validação do ajuste: execução direta da suíte antes com 1760 aprovados e 20
ignorados, sem banco de teste. Depois, com PostgreSQL descartável e os testes de
banco habilitados: 1783 aprovados e 8 ignorados. Foram adicionados 11 testes de
diagnóstico, fluxo de erro e persistência; os outros 12 testes de banco já
existiam. Tipagem de produção e dos testes da assistente aprovada. `npm test`
permanece bloqueado pelo TS7006 herdado descrito ao final deste documento.
Não houve chamada paga, mensagem real, migração nova ou reativação do piloto.

Consulta de diagnóstico, somente pelo backend:

```sql
select id, tipo, estado, resultado->'diagnostico' as diagnostico
from assistente_trabalhos
where estado in ('falhou','incerto')
order by atualizado_em desc;
```

## Permissões

O usuário ativo consulta os médicos da mesma conta, sem filtro de papel e
sem exigir `medicos.usuario_id`. Isso preserva o contrato do operador na base
de homologação, inclusive médicos adicionados à clínica sem login próprio.
Este piloto é restrito à conta de origem; não incorpora delegações externas.
Não altera as permissões dos fluxos existentes. O acesso é somente leitura e
não autoriza emissão ou entrega.

Vínculos são consultados antes de executar a preparação, novamente antes de
publicar seu resultado e antes de aceitar o planejamento do modelo. Respostas
guardam os médicos presentes no contexto; o envio revalida esse conjunto e o
telefone/estado ativo do destinatário. Mudanças de acesso podem bloquear a saída.
As verificações são pontuais: não revogam uma chamada externa que já começou.

As tabelas novas têm RLS habilitada e acesso direto revogado para `public`,
`anon` e `authenticated`. O serviço usa a conexão de backend. Não há ferramenta
de SQL, shell ou acesso arbitrário ao navegador disponível para o modelo.

## Capacidades que vêm depois

| Etapa | Incremento | Condição para concluir |
| --- | --- | --- |
| 1 — esta entrega | Conversa, memória, fila, consulta de preparação e retorno | Testes de isolamento, concorrência, retomada, comunicação e serviço HTTP |
| 2 | Vínculos de agenda e médicos, link seguro para A1, preparação automática | Usar conectores e fluxos existentes com permissões e resultados rastreáveis |
| 3 | Atendimentos e candidatos à emissão | Identidade estável do atendimento, dados e pendências por médico |
| 4 | Autorizações específicas e recorrentes | Escopo, autor, vigência, ambiente, revogação e validação determinística |
| 5 | Emissão e acompanhamento | Identidade fiscal antes do envio, reconciliação de resultado incerto, PDF e entrega independentes |
| 6 | Antecipação e memória mais ampla | Leitura contínua autorizada, resumos com fontes e recuperação de contexto antigo |

Os requisitos de reconciliação serão mapeados contra as capacidades já existentes
antes de escrever adaptadores. Esta entrega não altera a fila fiscal, não importa
solicitações legadas e não modifica nenhuma autorização atual.

MCP é opcional: os contratos das ferramentas precedem a escolha do protocolo.
Não se trazem da Briglia o acesso geral ao computador, autonomia sem escopo ou
suposição de proprietário único. A memória orienta o agente; regras e registros
operacionais comprovam o que pode executar e o que efetivamente terminou.

## Ativação do piloto

1. Revisar e aplicar **uma vez**, com conexão de backend, a migração
   `scripts/migrations/20261026-assistente-contextual.sql`. É aditiva e
   transacional; não executar migrações históricas por causa deste incremento.
2. Configurar no processo separado:

   - `ASSISTENTE_ATIVO=true`, somente no processo piloto separado;
   - `NOTO_AMBIENTE_OPERACAO=homologacao`;
   - `ENVIO_MEDICO_REAL_ATIVO=true`;
   - `ENVIO_REAL_ALLOWLIST` contendo somente os telefones autorizados;
     para o piloto combinado, `5551993527271`;
   - `ASSISTENTE_USUARIOS_PILOTO`: UUIDs de `usuarios.id`, separados por vírgula;
   - `ASSISTENTE_MODELO`: modelo OpenAI que suporte a saída JSON usada;
   - `DATABASE_URL` e `OPENAI_API_KEY` existentes;
   - `EVOLUTION_ASSISTANT_URL`, `EVOLUTION_ASSISTANT_API_KEY`,
     `EVOLUTION_ASSISTANT_INSTANCE_NAME` e `EVOLUTION_ASSISTANT_WEBHOOK_SECRET`;
   - segredo do webhook com ao menos 24 caracteres;
   - `ASSISTENTE_PORTA` opcional, padrão `3101`;
   - `ASSISTENTE_HOST` opcional, padrão `127.0.0.1`; em contêiner separado,
     usar a interface necessária à rede interna e proxy reverso;
   - `PREPARACAO_FISCAL_ATIVA` coerente com o processo atual do Noto.

   Segredos são fornecidos pelo gerenciador de ambiente da VPS. Não colocar
   valores em arquivos versionados. A conexão nova usa a configuração TLS do
   driver PostgreSQL, sem desativar verificação de certificado.
3. Executar na raiz do repositório:

   ```sh
   node --import tsx src/assistente/servidor.ts
   ```

4. Verificar `GET /health` e configurar a instância exclusiva do assistente para
   enviar eventos `messages.upsert` a `/webhooks/assistente` com o header
   `x-webhook-secret`. Evitar que outro processo responda à mesma instância.
5. Validar a conversa piloto e a consulta de preparação com os provedores reais.
   Nenhuma emissão precisa ser feita para validar esta primeira etapa.

Interromper o processo separado desativa o assistente. Entradas, memórias e
trabalhos persistem. Reservas de leitura expiradas são retomadas ao reiniciar;
envios incertos exigem conferência no provedor antes de qualquer ação manual.

Consulta operacional de pendências, restrita ao backend:

```sql
select id, usuario_id, tipo, estado, atualizado_em
from assistente_trabalhos
where estado in ('falhou','incerto')
   or (estado='executando' and lease_ate<now())
order by atualizado_em;
```

## Validação reproduzível

`npm test` executa a suíte existente e os testes de contrato/worker/entrada.
Os testes PostgreSQL são opcionais no fluxo padrão e exigem um banco local
descartável chamado `assistente_teste`, indicado por
`ASSISTENTE_TESTE_DATABASE_URL`. O teste rejeita outro nome de banco e hosts
diferentes de `localhost`/`127.0.0.1`. Cria e remove um schema exclusivo.
Não apontar para um banco de aplicação.

```sh
ASSISTENTE_TESTE_DATABASE_URL=postgres://USUARIO:SENHA@127.0.0.1:PORTA/assistente_teste npm test
```

O usuário do teste precisa criar schemas e os papéis `anon` e `authenticated`
quando ausentes. O teste usa tabelas-base mínimas para validar a migração e o
SQL novo; isso não prova compatibilidade com todas as migrações de uma VPS.
O teste funcional percorre entrada, memória, especialista e respostas com banco
real e provedores simulados. Outro teste inicia o servidor real e verifica HTTP,
autenticação e descarte de usuário desconhecido. Nenhum acessa OpenAI,
Evolution ou SEFIN reais.

Validação da portabilidade sobre `1dbe650`:

- Dependências instaladas com `npm ci --cache /tmp/noto-npm-cache`, usando o
  lockfile da homologação sem mudanças em manifestos ou versões.
- Antes de portar: `npm test` falhou na compilação por TS7006 em
  `tests/servidor-conversa-livre.test.ts:724` (parâmetro `c` implicitamente `any`).
  O mesmo erro permaneceu após instalar as dependências corretas.
- A execução direta de `vitest run` na base, antes de portar os arquivos, passou:
  113 arquivos aprovados, 1 ignorado, 1741 testes aprovados e 8 ignorados.
- Os testes originais não foram alterados para contornar esse erro.
- Depois, com os testes PostgreSQL do incremento habilitados: 116 arquivos
  aprovados, 1 ignorado, 1772 testes aprovados e os mesmos 8 ignorados. São 31
  testes novos aprovados, incluindo compatibilidade OpenAI, bloqueio do canal
  OTP, travas de envio e acesso por conta a médico sem usuário próprio.
- `npm run typecheck` passou. A compilação de todos os fontes e dos três arquivos
  novos de testes também passou com uma configuração temporária que seleciona
  apenas esses testes. Essa checagem não substitui o `npm test` integral.
- `npm test` continua bloqueado pelo mesmo TS7006 herdado, em
  `tests/servidor-conversa-livre.test.ts:724`. Nenhuma asserção ou configuração de
  teste versionada foi enfraquecida para contornar a falha.
- Nenhuma configuração ou tabela da homologação foi alterada. O piloto continua
  desligado. A migração nova é exercitada apenas em PostgreSQL descartável.
- `.ua/`, já presente no workspace, não integra o commit.

Esses resultados locais não comprovam integração com o modelo escolhido,
payloads reais da Evolution ou dados/migrações da VPS. A validação operacional
continua pendente de ativação explícita e separada.
