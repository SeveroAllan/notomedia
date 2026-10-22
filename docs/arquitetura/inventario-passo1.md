# Inventário do passo 1 (conversa do médico no Noto)

Base: feat/conversa-v2 @ 82972dc. Só leitura do código; nada alterado por este documento. Referências arquivo:linha desta versão. Marcado FATO (lido no código) ou HIPÓTESE.

## 1. Pontos que interpretam a fala do médico ou geram fala do Noto

| Ponto | Onde | Chamado por | Modelo? | Efeitos | Estado | Classe |
|---|---|---|---|---|---|---|
| Decisor único `ConversadorMedico.responder` + `PROMPT_CONVERSA` | src/onboarding/conversador-medico.ts:11-169 | processar-comunicacao-medico.ts:~133 (`decidir`), narrar de resultado | sim (gpt-4.1, OPENAI_TEXTO_MODEL) | nenhum direto; devolve fala, ação, parâmetros | ativo quando CONVERSA_LIVRE_ATIVA=true | PRINCIPAL |
| `validarAcaoConversa` | conversador-medico.ts:~100-135 | processar-comunicacao-medico.ts:~135 | não | recusa ação (motivos CONVERSA_ACAO_RECUSADA) | ativo | MANTER (validador de segurança) |
| `periodoDecisao`, `normalizarAgenda`, `faltasIntroducaoLink` | conversador-medico.ts:75-95 | validação e execução | não | nenhum | ativo | MANTER |
| `dadoCadastralIsolado` + `contemCredencialAgenda` | processar-comunicacao-medico.ts:39-48 e ~86 | processar | não | bloqueia entrada que parece credencial | ativo | MANTER |
| `sanitizarTextoMedico` | contexto-conversa-medico.ts:4-15 | processar | não | oculta CPF, telefone, e-mail, senha | ativo | MANTER |
| `ferramentasConversa` (lerFatos, permitidas, executar) | src/server.ts:~310-352 | processar | não | lê banco; executa listar, link, lote | ativo | MANTER (fronteira de ações assinadas) |
| `ConversaLoteRetroativo.responder` | lote-retroativo.ts:~100-133 | server.ts executar (quando há confirmacao do decisor) | não | confirma o lote; envia texto fixo | ativo | MANTER |
| `interpretarConfirmacao` (dep do lote) | server.ts:~295 | lote.responder | com decisão: usa a confirmação do decisor; sem decisão: `interpretarConfirmacaoEmissao` (modelo) | | ambos os caminhos existem | PARALELO (ramo sem decisão) |
| `interpretarDataRetroativo` | lote-retroativo.ts:32; server.ts:~294 | lote.responder (estado aguardando_data_inicio) | sim, só sem decisão | | parcial | PARALELO |
| `interpretarReenvioLote` | lote-retroativo.ts:136; server.ts:~267 | lote.reenviar (só chamado sem narrar) | sim | reenvia notas sem contato | HIPÓTESE: raramente ativo | PARALELO |
| `interpretarConfirmacaoEmissao` | src/onboarding/confirmacao-emissao-medico.ts:9; server.ts:~925 | confirmação individual de comprovante (fluxo de comprovante) | sim | confirma emissão individual | ativo no fluxo de comprovantes | MANTER (outro fluxo) |
| `orquestrarComunicacao` (ramo legado) | src/onboarding/orquestrar-comunicacao.ts:24-119 | processar:~73 (conversa livre desligada) e ~98 (boas-vindas) | não no welcome; usa extrator no caminho antigo | envia boas-vindas, grava histórico | welcome ativo; resto só sem conversa livre | LEGADO (welcome) |
| `ExtratorRespostaMedicoNvidia.extrair` / `classificarAgenda` | src/io/nvidia/extrator-resposta-medico.ts:19,10 | legado e `tratarCofre` (server.ts:~365) | sim | classifica resposta e agenda | legado ativo apenas sem conversa livre | LEGADO |
| `tratarCofre` | server.ts:~365 → `cofres.links.tratarMensagem` | processar:~67 (só no ramo sem conversa livre) | não/sim | trata mensagem do link seguro | HIPÓTESE: inativo com conversa livre | LEGADO |
| `interpretarRespostaNota` / `validarRespostaNotaExtraida` | src/onboarding/regras/decidir-proxima-acao.ts:117,163 | orquestrar-comunicacao.ts:65 | não (regras) | extrai "desde quando" | só legado | LEGADO |
| `formatarPendencias` | src/onboarding/pendencias-medico.ts | server.ts executar (listar) | não | gera a lista assinada | ativo | MANTER |
| Falas fixas do lote | lote-retroativo.ts:~100-133; worker/processar-lote-retroativo.ts:54-57 | lote | não | texto humano (steer 19) | ativo | MANTER |

Observação: nenhum dos LEGADO foi removido nesta etapa; o welcome ainda depende de `orquestrarComunicacao` (FATO).

## 2. Fluxo de uma mensagem do médico (conversa livre ligada)
1. Webhook Evolution recebe messages.upsert; server.ts:~125 filtra médico permitido (allowlist) e chama `comunicarMedico` (server.ts:~355) com chaveProcessamento (id da mensagem) e chaveConversa.
2. `processarComunicacaoMedico` (processar:~57): serialização em RAM por médico (`Map processamentos`, ~linha 190-198): mensagens do mesmo médico rodam em fila, dentro de UMA instância. HIPÓTESE: com mais de uma instância não há exclusão entre processos.
3. Reserva de idempotência: `historico.reservar(medicoId,'simulado','conversa:agenda:'+chave)` seguida de `liberar` (processar:~84-85); a duplicação real é barrada pela chave de envio em `comunicacaoHomologacao.conversa` (tabela noto_comunicacao_tentativas).
4. Proteção de credencial; boas-vindas (se ainda não); contexto (`memoria.lerContextoParaModelo`), fatos (`ferramentas.lerFatos` + listaRecente, homologacaoInformada), no máximo 2 chamadas ao modelo por turno.
5. Decisão → validação (`validarAcaoConversa`) → execução (`ferramentas.executar`): listar, link ou lote → narração/resultado assinado → envio e registro da fala.
6. Confirmação do lote: o decisor devolve `parametros.confirmacao`; server.ts executar chama `ConversaLoteRetroativo.responder` com `chavePergunta` ou `lote.mensagemConfirmacaoId`; `repo.confirmar` (postgres-lotes-emissao.ts:~64-70) só muda 'aguardando_confirmacao_lote'→'confirmado' se a pergunta for a registrada, `pergunta_em` ≤ agora e < 48h e confiança ≥ 0,9. Consumo único (a segunda confirmação não encontra o estado). FATO.
7. Execução: worker `processarLoteRetroativo` reserva o lote com advisory lock e retomada após 5 min (postgres-lotes-emissao.ts:~79-95); emissão intacta; fala final com contagens reais (processar-lote-retroativo.ts:54-57).

## 3. Estado por médico hoje
- conversa_mensagens / conversa_resumos: histórico e resumo (PostgresMemoriaConversaMedico).
- noto_contexto_pendencias: período salvo (data_inicio).
- noto_lotes_emissao + noto_lotes_itens: proposta (lote) com estados aguardando_data_inicio, aguardando_confirmacao_lote, confirmado, processando, concluido, recusado; pergunta com id e hora.
- cofre_links (+ auditoria): link seguro de agenda; marcas da conversa (sem_agenda_digital, link_agenda_solicitado); noto_historico_comunicacao_medico (boas-vindas); noto_comunicacao_tentativas (idempotência de envio).
Lacunas: não há um objeto único "estado da conversa". O modelo recebe `fatos` montado a cada turno e "lista recente" vem de regex sobre as falas do Noto, não de um registro. Última ação e resultado não são guardados como fato. O andamento do lote chega só como `lote.estado`.

## 4. Bugs reais e causa-raiz
- Lista repetida após "Certo.": o decisor não sabia que a lista acabara de sair (sem fato) → fato `listaRecente` + trava `LISTA_JA_ENVIADA` (9d76135).
- "Pode" não registrou o lote e o Noto disse "aguardar liberação": confirmação dependia de o modelo preencher `parametros.confirmacao` e do prompt, sem trava de código → trava de reconsulta e reenvio da pergunta (82972dc).
- Regex rígido recusando fala natural ("não tenho permissão"): validação textual da fala do modelo → trocada por checagem de essência (steer 17/ commits anteriores).
Causa comum: o estado da conversa vive implícito (falas + fatos soltos) e o modelo é o único elo entre intenção e ação.

## 5. Proposta de estado (HIPÓTESE, nada implementado)
Objeto `estadoConversa` calculado a cada turno a partir do que já existe, sem tabela nova: {etapa, periodo, agenda, propostaPendente {id, tipo:'lote', resumo, perguntadaEm, expiraEm}, ultimaLista {enviadaEm}, tarefa {estado: confirmado|processando|concluido, andamento}, ultimaAcao}. Entregue ao decisor como `fatos.estado`, com instruções claras de prompt (andamento, nunca reoferecer lote em curso). Migração SQL: NÃO necessária para esta versão. Uma tabela noto_estado_medico persistida só será proposta se a leitura calculada se mostrar insuficiente (exigiria ok do dono antes).
