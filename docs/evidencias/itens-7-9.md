# Itens 7–9 — evidências

Branch: `feat/conversa-etapa1`. Base independente informada: `50faa95`,
typecheck limpo, 947 testes aprovados e 3 ignorados. Sem deploy, merge,
migration, alteração de configuração do servidor, banco real ou envio real.
Nenhuma mudança em configuração de flags, allowlist, app antigo ou chave do acesso.

## Resultado

- Item 7: `b5a3b65` — reações opcionais e restritas, Evolution pela chave original,
  reserva idempotente e gates de conversa livre, envio, homologação e allowlist.
- Item 8: `a8df930` — sincronização sob demanda de 90 dias, somente pela paginação
  da UI e GETs do portal; valida cobertura e rejeita lacunas, recortes truncados
  ou paginação sem avanço. Sem cron. Função interna descrita em
  `docs/tribemd-area-teste.md`; janela parametrizada de 1 a 365 dias, padrão 90.
  Resolve paciente pelo telefone e variantes; cria cadastro mínimo sem nome,
  com origem `agenda_tribemd_sync`. UUID local só na persistência; mantém os IDs
  transitórios usados pelo critério fiscal do comprovante.
- Item 9: o evento real de verificação do acesso continua pelo conversador, sem
  precisar de mensagem ou clique do médico. Provedor e chave vêm da linha do link
  consumido. Confirma o recebimento, verifica agenda e informa resultado/erro,
  com memória Noto nas variantes do telefone, dedup e até três balões. Não libera
  ação fiscal. Falha de acesso orienta a área segura; falha técnica usa instabilidade.
  Página HTML 202 “Acesso salvo”, sem formulário, com tokens do Noto e botão preto.
  O destino wa.me vem da identidade da instância assistente; falha nessa leitura
  abre apenas o WhatsApp, sem inventar número nem impedir a continuação automática.

## Saídas de validação

Item 7, typecheck de código e testes sem erros; bateria relacionada:

```text
Test Files  4 passed (4)
Tests       175 passed (175)
```

Item 8, bateria relacionada após implementação:

```text
Test Files  7 passed (7)
Tests       92 passed (92)
```

Antes da implementação do item 8, os testes novos apontaram as funções ainda
inexistentes: 7 falhas esperadas, 26 testes anteriores aprovados. Um teste novo
com 14 semanas navegadas no Chromium excedeu 5000 ms: foi dividido em cobertura
completa determinística de 14 GETs/90 dias e prova Chromium da semana anterior.
Nenhum timeout ou teste legado foi alterado para isso.

A primeira suíte completa do item 8 teve 975 aprovados, 3 ignorados e um timeout
em `confirmacao-fiscal-jornada.test.ts`, arquivo não alterado. A repetição isolada
passou 13/13 (227 ms de testes). A suíte final abaixo também inclui esse arquivo.

Uma execução intermediária do item 9 apontou a expectativa antiga “novo link”
para uma falha técnica. A expectativa passou a exigir a frase exata de
instabilidade, preservando os asserts de token consumido e segredo fora do log.

Gate final, com todos os itens e testes novos:

```text
Typecheck de código e testes: exit 0, sem saída de erro.
Test Files  62 passed (62)
Tests       995 passed | 3 skipped (998)
Duration    54.24s
```

## Testes alterados e motivo

- `tests/conversador-medico.test.ts`: enum de reações; reação inválida descartada
  sem perder fala; falha acionável versus técnica no evento de conexão. Mantém
  os asserts anteriores de protocolo, sanitização e resistência a injeção.
- `tests/passo12-envio-medico.test.ts`: gates de reação, payload Evolution, reserva
  e auditoria; identificação do número da própria instância para o retorno.
- `tests/servidor-conversa-livre.test.ts`: reações com key original e reentrega;
  leitura real precedida do aviso, persistência da sync com UUID; bloqueio de sync
  em produção, erro estruturado; evento de acesso sem mensagem do médico, gates,
  dedup e contexto nas variantes com/sem nono dígito.
- `tests/fonte-agenda.test.ts`: mapeamento apenas na escrita; busca por variantes,
  criação mínima sem nome; telefone ausente ou ambíguo bloqueia a escrita. Mantém
  os testes anteriores de upsert e dedup por médico/fonte/id externo.
- `tests/tribemd-sync-janela.test.ts` (novo): 14 recortes contíguos cobrem 90 dias,
  incluem consulta da semana passada e excluem data fora da janela; Chromium
  interceptado prova GET do portal e navegação; ausência de botão e falta de avanço
  produzem erro. Nenhum acesso ao portal real.
- `tests/passo12-agenda.test.ts`: contrato agora exige sync interna em homologação;
  preserva que a revalidação fiscal não consulta a tabela sincronizada.
- `tests/passo12-cofre.test.ts`: exige que a janela/relógio cheguem ao navegador;
  preserva descarte do resultado e ausência de dados de pacientes no envelope.
- `tests/cofre-links.test.ts`: HTML de sucesso e botão; POST e conclusão com agenda
  real/id do link, dedup e classificação da falha pelo status. Atualiza a mensagem
  de confirmação e a falha técnica conforme UX; mantém uso único, limites, gates,
  origem, token hash e segredos fora de resposta/log.
- `tests/processar-conversa-medico.test.ts`: evento sem médico fictício; conversa
  continua e retém contexto; estado ausente usa nunca-mudo; resumo de lista mantém
  total, até três balões de no máximo 500 caracteres. Mantém testes anteriores.

## Verificado versus dependente do homolog

**Verificado localmente:** JSON estrito; gates, reservas e payloads com bordas
falsas; mapeamento e upsert; cobertura e falhas de paginação em fixtures; evento,
memória e limites de fala; página sem credenciais; screenshot Chromium móvel
390×844 com Geist efetivamente carregada, fundo `rgb(244,244,245)` e wa.me fictício.

**Não executado no Codex:** UI atual autenticada da TribeMD, janela real de 90 dias,
SQL em banco real, chamadas Evolution reais, OpenAI real, retorno no WhatsApp de
um celular ou deploy. Os seletores e contratos externos ainda precisam da bateria
real de homologação. O screenshot não comprova esses serviços externos.

Captura: [acesso-salvo.png](acesso-salvo.png).
