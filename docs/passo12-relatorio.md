# Passo 12 — implementação e evidências

19/10/2026. Base local conferida: `25031c2`, checkout `/workspace/notomedia`. A branch encontrada chamava-se `work`; foi criada `main` local no mesmo commit, conforme o contexto da execução. Nenhum fetch, pull, push, deploy ou migração foi executado. Nenhuma mensagem real foi enviada. Nenhuma integração externa foi chamada pelos testes novos.

## Situação da entrega

A–D estão implementados e separados em quatro commits locais. A suíte completa passou: **630 testes em 46 arquivos**, sem falhas ou testes pulados. Typecheck de código e testes passou. Integrações de agenda, SEFIN e Evolution permaneceram falsas nos testes. As flags novas ficaram desligadas na configuração padrão.

O usuário autorizou explicitamente atualizar as expectativas substituídas e reforçar a cobertura. Foram atualizados somente os contratos que este passo substitui e seus fakes; verificações de recusa fiscal, isolamento, idempotência, rollback e proibição de envios reais foram mantidas.

## O que mudou

| Item | Implementação | Evidência |
| --- | --- | --- |
| A | `FonteAgenda.consultar` depois da extração; resultado apenas em memória; adaptador do cofre aguarda leitura e descarta o resultado. `lerEstado` e `preparar` não leem mais a tabela sincronizada. | `passo12-agenda`, `passo12-cofre`, `passo12-servidor` |
| A | Vínculo pelo telefone do remetente, incluindo `remoteJidAlt` quando o JID é LID. Reutiliza a normalização brasileira, corrigindo DDD 55. Identidade da agenda é externa, sem supor igualdade com o UUID do Noto. | Variações de país/nono dígito, telefone ausente/compartilhado, empate e LID |
| A | Última realizada ainda sem nota; consultas já faturadas são excluídas antes do desempate, sem esconder pacientes que compartilham telefone. Sem candidato único, pergunta ao médico. Erros da fonte conservam os motivos existentes. | Exclusão de faturadas; decisões FONTE_INDISPONIVEL, ACESSO_EXPIRADO e SEM_AGENDA_CONECTADA |
| B | `consulta_chave = HMAC-SHA256(APP_PEPPER, JSON.stringify([medicoId, fonte, idExterno]))`. `comprovante_chave` usa HMAC dos mesmos campos de identidade anteriores, valor/data/pagador. Advisory lock por médico mantido. | Chaves, reprocessamento, comprovantes diferentes da mesma consulta e chamadas concorrentes |
| B | Auditoria em memória e JSONB guarda flags/hashes; nome e CPF do estado ficam nulos; leitura guarda HMACs e as quatro confianças permitidas. Pedido fica somente como hash, tipo e motivo. `preparar` busca por hashes e revalida cadastro/valor antes de reservar. | Inspeção do JSONB e memória, inclusive ausência de nomes, CPF e identificador externo |
| B | Reserva bloqueada ou com erro nunca é liberada por uma nova tentativa automática. A recusa fiscal não marca nota gerada. | Testes novos de reservas e testes existentes do worker |
| C | Flags de médico/paciente `false` e allowlist vazia por padrão. Médico exige flag, perfil fiscal homologacao e telefone na allowlist. Textos são constantes em código. | Matriz de bloqueios e mensagens sem conteúdo arbitrário |
| C | Ações do comprovante, pedido de agenda e avisos de falha/sucesso usam a instância assistente e reserva persistente por médico/ação/chave HMAC antes do transporte. Falha ou resultado incerto consome a tentativa. | Concorrência, repetição e erro de transporte falso |
| D | Comprovante usa `generateDanfsePdf`, o gerador do legado. Erro no PDF preserva a autorização e o XML. | PDF real válido; erro do gerador falso |
| D | Depois da persistência da nota, consulta o destinatário e uma instância própria conectada do médico, excluindo oficial e assistente. Exige flag de paciente, homologacao e allowlist do paciente. Uma tentativa por nota_fiscal_id, armazenado como HMAC. | Matriz de bloqueios, instância errada/desconectada, corrida e falha de entrega |
| D | Sem instância própria ou PDF, avisa o médico pelo mesmo canal protegido. Falha de entrega não desfaz nota e não reemite. | Ordem persistência → entrega; nova chamada ao worker não retransmite |

A regra de valor igual e confiança mínima inclusiva de 0,90 nos quatro campos continua determinística. A IA não escolhe paciente, consulta, valor fiscal, texto ou destinatário. Nome/CPF fiscal vêm do cadastro do Noto. O adendo substituiu o vínculo por CPF/nome: não foi criado fallback por nome ou CPF da agenda.

O menor ajuste no contrato Zod foi adicionar `telefonePaciente?: string` à consulta. `pacienteId` já era string livre, não UUID no schema; não foi necessário relaxá-lo. Fontes antigas sem telefone continuam válidas como contrato, mas não autorizam vínculo para emitir pelo novo caminho.

Datas de consulta que chegam somente como dia preservam o dia civil na descrição fiscal; não se aplica uma conversão de UTC que as leve ao dia anterior em São Paulo.

## Arquivos e propostas

- Contrato e consulta: `src/agenda/fonte-agenda.ts`, `src/fluxos/processar-comprovante.ts`, `src/cofre/{tribemd-cofre,router}.ts` e `src/server.ts`.
- Reservas e auditoria: `src/atendimento/comprovante.ts`, repositórios de atendimento, emissão e histórico PostgreSQL, histórico em memória.
- Envios: `src/whatsapp/comunicacao-homologacao.ts`, configuração, ganchos do servidor/onboarding/worker e geração de DANFSe.
- `scripts/migrations/20261020-emissao-comprovante-sem-consulta.sql`: proposta idempotente dependente da 20261019. Remove FK/colunas antigas, cria chave de consulta obrigatória de 64 hex e unicidade por médico. Se já houver reservas sem HMAC, interrompe sem descartar histórico: backfill offline é trabalho separado.
- `scripts/migrations/20261021-envios-homologacao.sql`: proposta idempotente para reservas de envio, com RLS/revogação de acesso público. Não guarda telefone, texto ou PDF.
- `.env.example`: flags desligadas e allowlist vazia. O setup de testes força essas flags desligadas, além de retirar credenciais e bloquear fetch externo. Nos testes positivos, as opções ficam ligadas apenas em objetos locais que recebem transportes falsos.
- `docs/passo12-modelos-mensagens.md`: textos fixos completos para revisão do Allan antes de ligar flags.
- Oito arquivos novos `tests/passo12-*.test.ts`, com 58 testes.

## Saída real antes e depois

Antes, sem alterações, `npm run typecheck`: código de saída 0.

`npm test` na base `25031c2`, em checkout temporário do mesmo repositório, com sockets HTTP locais liberados:

```text
Test Files  38 passed (38)
Tests       572 passed (572)
```

`npm test`, depois de A–D e dos testes/expectativas autorizados:

```text
Test Files  46 passed (46)
Tests       630 passed (630)
```

O comando também executa `tsc --noEmit -p tsconfig.test.json`, que passou antes de iniciar Vitest. `npm run typecheck` passou após a implementação. O checkout temporário da base foi criado com worktree local, sem fetch nem acesso a outro repositório, e removido depois da validação.

Verificação focada adicional:

```sh
npx vitest run tests/passo12-*.test.ts tests/worker-comprovante.test.ts tests/emissao-worker.test.ts tests/emissor-adaptador.test.ts
```

**78 testes passaram em 11 arquivos** — 58 novos e 20 existentes. Os testes foram acrescentados antes das respectivas mudanças centrais; os logs de falha inicial e sucesso estão preservados nas evidências locais. Testes posteriores ampliaram casos de borda e integração.

### Expectativas substituídas e ambiente de teste

A primeira execução, com sandbox bloqueando sockets locais, teve 554 testes passando, 5 falhando e 13 pulados, com `listen EPERM 127.0.0.1`. Duas tentativas automáticas de liberar esses sockets falharam porque o revisor estava sem capacidade. Uma tentativa posterior foi autorizada; antes e depois completos acima usam esse ambiente liberado. Não houve chamada externa de agenda, SEFIN ou Evolution.

Durante a implementação, 48 expectativas ainda exigiam consulta persistida, auditoria com PII, chave SHA-256 ou ausência de PDF. Depois da autorização explícita do usuário, foram substituídas pelas novas regras, mantendo o número de testes existentes e acrescentando 58 cenários. Em particular:

- leitores agora devem consultar apenas cadastro e receber a consulta pela fonte falsa sob demanda;
- auditorias devem conter flags/HMACs, conservando testes de cópias independentes e isolamento;
- reservas comparam HMACs e revalidam a consulta recebida em memória, sem uma tabela de consultas no banco falso;
- integração de ponta a ponta fornece agenda falsa e verifica assinatura, ambiente de homologação, uma nota, ausência de PII na auditoria e DANFSe;
- o cenário de erro no PDF exige que o gerador seja chamado e que a autorização seja preservada;
- o gancho da decisão recebe o estado transitório como terceiro argumento;
- a infraestrutura de testes também força flags novas desligadas e limpa a allowlist.

## Verificado versus hipóteses e limites

Verificado com fronteiras falsas: ordem extração/agenda, vínculo e recusa de ambiguidades, auditoria sem PII, hashes, reservas e concorrência em modelo de banco, no máximo uma solicitação/nota nos cenários de corrida, recusa fiscal no worker, gate de médico/paciente, entrega única, canais e preservação da nota após falha de PDF/entrega. O handler Express foi invocado diretamente sem abrir servidor HTTP.

Não verificado contra PostgreSQL/SEFIN/Evolution/Tribemd reais. Nenhuma migração foi aplicada, portanto o SQL foi revisado e testado como contrato textual, não executado. As provas de transação/concorrência usam bancos falsos e verificam o uso de advisory lock e unicidades; não substituem um ensaio PostgreSQL isolado autorizado.

O adaptador Tribemd só aceita recorte reconhecido do portal, sem truncamento ou detalhes pendentes, cujo fim alcance o dia corrente. Recorte incompleto vira FONTE_INDISPONIVEL; paciente fora do recorte não ganha consulta inventada. Ainda é hipótese a completude da resposta do portal dentro desse intervalo e a fidelidade dos campos de telefone/status/valor. Precisam de validação em homologação com dados fictícios. A fonte atual pode fornecer apenas o dia: consultas do mesmo paciente no mesmo dia são tratadas como ambíguas, sem inventar horário.

O vínculo presume que o telefone do cadastro na agenda identifica o remetente e que o cadastro local do Noto, criado pelo webhook para esse remetente, contém a identidade fiscal correta. Não há fallback por nome civil, CPF do comprovante, homônimo ou pagador. Telefone compartilhado observado entre pacientes diferentes impede emissão automática.

O status de conexão é o registrado em `whatsapp_instancias`; uma desconexão ocorrida depois da consulta pode causar erro de entrega, preservando a nota e consumindo a tentativa. O APP_PEPPER deve ser secreto e estável; rotação das chaves existentes não foi implementada.

## O que ficou de fora

Produção fiscal; envios reais; aplicação das migrações; push; formulários/painéis novos; IA decidindo regras; remoção da tabela/código de sincronização; saneamento retroativo das auditorias antigas; backfill/rotação de HMAC; reenvio automático de mensagens; recuperação automática de PDFs pendentes; alteração do fluxo legado de entrega. Notas e descrições fiscais conservam os dados legalmente necessários já existentes; a remoção de PII deste passo é da auditoria e das chaves novas, não uma eliminação global dos cadastros ou conversas anteriores.
