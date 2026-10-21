# STEER 12 e adendos — agenda e continuidade do período

Base: `6a05883`, branch `feat/conversa-etapa1`. Um commit, sem deploy ou merge.

## Diagnóstico e mudança

O resgate `alternativaUtil` anterior ignorava uma resposta à pergunta de agenda e escolhia outra pergunta genérica depois de duas rejeições. A fixture reproduz o caminho com dois JSONs fora do schema e a sequência boas-vindas → “Desde semana retrasada.” → pergunta de agenda → “Tribe”. O código mostra essa causa de perda de contexto; sem o log original das candidatas, não é possível afirmar se a rejeição real foi de schema, repetição ou revisão manual. O log de schema agora inclui somente os caminhos dos campos, nunca os valores.

“Tribe”, “tribe md”, “tribemd” e “o tribe” normalizam para `tribemd`. O prompt reconhece a resposta e pede avanço; o resgate também avança para o link permitido, ou oferece conferência manual para agenda não suportada. A pergunta de agenda após o período recebe contexto curto, sem repetir justificativas já recebidas.

A primeira introdução é composta pela IA com o contexto atual e validada antes de criar o pedido: só agenda/leitura, consultas/emissão, login/senha somente no link seguro e ausência de envio a pacientes pela conexão. Se faltarem fatos, há regeneração; sem candidata válida não se cria pedido e o motivo é registrado sem dados pessoais. A URL continua sendo acrescentada pelo servidor em balão próprio. A opção textual `introducao` não altera transação, token, validade, invalidação, limite, gates ou auditoria do link. Reenvio com link ativo continua informando validade; renovação real mantém o texto curto. Pedir “novo” sem entrega anterior não classifica o primeiro link como renovação.

Antes da pergunta inicial do lote, o fluxo reaproveita o período salvo ou interpreta até oito falas reais do médico da mesma conversa na última hora. Falas do Noto e marcas ficam fora dessa leitura. Período ambíguo com evidência literal é confirmado citando o trecho, em vez de reiniciar a pergunta genérica. Não se grava novo cadastro ou cache de paciente.

A IA identifica o período relativo; o calendário é calculado no servidor em São Paulo: em 21/10/2026, semana passada começa em 12/10, retrasada em 05/10, mês passado em 01/09 e retrasado em 01/08. Respostas explícitas de período também corrigem uma candidata que retorne o mesmo dia de semanas atrás. Validação de data e teto de 90 dias permanecem.

A conversa do lote solicita somente contagem: não manda lista vazia antes do resultado. Os totais informativos `totalNoPeriodo` e `jaEmitidas` permitem distinguir ausência de consultas de consultas que já têm nota gerada. São apenas leitura e log de números; seleção, assinatura, snapshot, confirmação e execução fiscal não mudaram. Item `pronto`/em processamento não é prova de nota emitida e não sustenta a afirmação “já tem nota”. O aviso inicial de homologação fica separado da pergunta e usa a reserva de mensagem da própria conversa para não reaparecer. O gate existente de homologação permanece; a pergunta de autorização conserva sua qualificação de ambiente.

Não foi encontrada em `src` a frase “Vi que você ainda não conectou a agenda”, nem um lembrete equivalente nos módulos indicados. Não foi atribuída origem a código externo não inspecionado.

## Testes e evidência

Antes: três arquivos de conversa/link, 226 passaram e 3 ignorados, 23,21s (`work/steer12-antes.log`).

Depois: nove arquivos relacionados, 386 passaram e 3 ignorados, 95,17s (`work/steer12-depois-final.log`). Typecheck sem saída e código zero. Rodada final dos três arquivos de conversa/link: 243 passaram e 3 ignorados, 26,70s (`work/steer12-conversa-final.log`), incluindo as últimas fixtures adicionadas. Os conjuntos de testes se sobrepõem. Typecheck final em `work/steer12-typecheck-final.log`, código zero; `git diff --check` limpo.

Testes existentes alterados:
- `processar-conversa-medico`: isola a geração da introdução nas unidades do orquestrador, exige sua passagem ao link; o cenário de renovação registra o pedido anterior. Mantidos dedup, quantidades e bloqueios. Nova regressão impede pedido quando a introdução não foi validada.
- `cofre-links`: a fixture do modelo fornece a introdução contextual; mantidos limite, uso único, ordem, dedup, auditoria e reenvio curto. Acrescentados aliases, sequência literal relatada, primeiro pedido denominado “novo” e introdução única.
- `servidor-conversa-livre`: troca a expectativa da lista redundante pelo aviso separado e confirmação única. Mantidos IDs Evolution esperados, vínculo da confirmação, valores, escopo, idempotência, privacidade e proibição de envio real.
- `fakes/banco-conversa`: suporta a leitura nova por papel médico e limite oito; não simula dados de agenda reais.

Testes novos em arquivos existentes:
- `conversador-medico`: aliases, resgate de rejeição, agenda não suportada, geração contextual, regeneração e fatos obrigatórios.
- `lote-retroativo`: reutilização do período, prioridade do período salvo, confirmação de ambiguidade com evidência literal, início de semanas/meses, fronteira UTC/local, resposta única e distinção de consultas já emitidas.
- `lotes-postgres`: contagem de notas já geradas fora do mapa de valores pendentes, somente com SELECT, sem mudar seleção.
- `memoria-conversa-contrato`: somente falas do médico, escopo por médico/conversa, limite e janela temporal da nova consulta.

Verificado com fixtures isoladas e sem rede real. Suíte completa e avaliação com OpenAI real ficam para o gate do solicitante. Não houve migration, banco real, agenda real, emissão, envio real, alteração de flags/allowlist/COFRE_CHAVE, worker, deploy ou merge.
