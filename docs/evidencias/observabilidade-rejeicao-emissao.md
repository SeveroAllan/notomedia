# Diagnóstico interno das rejeições da emissão

Base: `f8a6696122959f7c0d7bd46873be0587f3d0cd7d`, branch `feat/conversa-etapa1`.

O worker descartava o motivo da SEFIN ao montar a notificação interna. O adaptador do lote também descartava o código desconhecido ao escolher o agregado. O erro gravado nas duas tabelas ficava sem o código do provedor.

## Mudança restrita à observabilidade

- O erro interno gravado em `solicitacoes_nota.erro` e `noto_emissoes_comprovantes.erro_codigo` mantém o agregado e acrescenta o código original sanitizado/truncado: por exemplo, `EMISSAO_COMPROVANTE_RECUSADA: E9999`. Sem código, o valor anterior permanece; se o original já é o agregado, não o duplica. A transação e os UPDATEs do repositório continuam os mesmos.
- O registro `NOTO_ERRO` do lote continua com o mesmo `codigo` agregado/whitelist. O contexto acrescenta `codigoErroOriginal` (até 80 caracteres) e `motivoErro` (até 500), além de médico/solicitação e etapa já existentes.
- A rejeição do lote é sanitizada onde estão disponíveis os identificadores usados na DPS: nomes do paciente/profissional/empresa, documentos, contatos, registro profissional e valor. Antes do truncamento, o sanitizador remove identidades conhecidas (inclusive variação sem acento/maiúsculas e partes de nomes), XML, documentos, telefones, e-mails, credenciais e valores monetários. O código original da emissão usado pelo controle do worker não é alterado.
- O worker repassa o motivo sanitizado ao adaptador que apenas registra o diagnóstico do lote. O comprovante mantém a frase de notificação anterior. Nenhum detalhe técnico novo é enviado ao médico. Estados, retorno do worker, reservas, número de transmissões, ausência de retentativa autônoma, payload fiscal, mTLS, gates e entrega permanecem iguais. Nenhum schema/migration foi alterado.

## Testes e resultados

Antes: `npx vitest run --maxWorkers=1`: **67 arquivos, 1181 passaram, 3 ignorados, 0 falhas**, 121,64s.

Os testes novos foram escritos antes da correção: **3 falharam e 23 passaram**, reproduzindo perda do código/motivo e ausência de sanitização da rejeição. Após a primeira implementação, os dois arquivos focados passaram **26/26**. Foram acrescentadas cobertura de código conhecido e sanitização/truncamento.

O primeiro gate completo apresentou **1185 passando, 3 ignorados e 1 falha**: o teste legado esperava apenas o agregado no banco. Foi atualizado para exigir exatamente o agregado junto com `E123`, conforme a nova observabilidade; suas verificações de erro, zero notas, uma transmissão, notificação e ausência de retransmissão foram preservadas. A expectativa da frase de notificação foi fortalecida para igualdade exata, sem o motivo privado da SEFIN.

Gate final:

- `npx tsc --noEmit`: saída vazia, exit 0.
- `npx vitest run --maxWorkers=1`: **67 arquivos, 1186 passaram, 3 ignorados, 0 falhas**, 123,81s, exit 0.
- `git diff --check`: limpo. Nenhum timeout foi alterado.

Testes alterados:

- `tests/lote-emissao-real.test.ts`: o cenário fiscal existente mantém todos os asserts de sucesso e ganha uma rejeição com SEFIN/certificado falsos, provando que o diagnóstico não contém nome do médico/paciente, documentos, registro, valor ou XML. Novos casos verificam código desconhecido/SEFIN_TIMEOUT, agregado preservado, contexto estruturado, truncamento e parâmetros dos dois UPDATEs internos. Sem entrega nem registro de nota no erro.
- `tests/worker-comprovante.test.ts`: nova recusa de lote exige código original no erro interno e motivo sanitizado, com retorno/estado e reserva anteriores, sem reemitir ou enviar PDF. Outro teste cobre nomes com acentos/maiúsculas, documentos, telefone, e-mail, moeda, XML e motivo não textual. Os asserts anteriores de notificação sem detalhe técnico não foram afrouxados.
- `tests/servidor-emissao-comprovante.test.ts`: atualizado somente o valor esperado do erro interno e fortalecida a verificação da notificação existente; nenhum mock foi adicionado para esconder falha.

## Verificado versus fora desta execução

Verificado com fixtures: passagem do código e motivo sanitizado do emissor ao worker/log, gravação do código junto do agregado, limites do contexto, remoção dos dados conhecidos da DPS, comportamento de sucesso e recusa, idempotência/sem retransmissão e frase de notificação anterior.

Não verificado: qual é a rejeição real do homolog. Não foram consultados banco, portal, SEFIN ou logs reais. O novo diagnóstico permite essa análise após publicação/deploy pelo responsável, sem antecipar uma causa ou alterar parâmetros fiscais. Nenhum envio real, merge, deploy ou alteração de env/flags/allowlist foi executado.

Evidências locais (ignoradas): `work/emissao-observabilidade-antes.log`, `work/emissao-observabilidade-red.log`, `work/emissao-observabilidade-focados.log`, `work/emissao-observabilidade-depois.log`, `work/emissao-observabilidade-tsc-final.log`, `work/emissao-observabilidade-final.log`.
