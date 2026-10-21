# Ordem de cNBS na DPS nacional de homologação

Base: `e065c9590c61fab3ba712a0800e1121c520ad25a`, branch `feat/conversa-etapa1`.

## Fonte oficial consultada em 21/10/2026

A [documentação de produção restrita](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/producao-restrita) publica o pacote **NFSe-ESQUEMAS_XSD-PRODREST-v1.01-20261020**:

- [esquemas_prod_restrita_20261020.zip](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/producao-restrita/esquemas_prod_restrita_20261020.zip), SHA-256 `25fdcecc651a67a216496ab10d7566631e6ed10f721e37d62c7845dadb0ea267`.
- `tiposComplexos_v1.01.xsd`, tipo `TCCServ`: sequência **cTribNac, cTribMun?, cNBS?, cIntContrib?, xDescServ**.
- `TCServ`: **locPrest, cServ, comExt?, obra?, atvEvento?, infoCompl?**.

O NBS continua no grupo `cServ`; a posição mudou. Como a descrição encerra a sequência nova, o NBS colocado depois dela produz exatamente a rejeição de elemento inesperado informada no homolog.

A [documentação atual de produção](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual) ainda publica [nfse-esquemas_xsd-v1-01-20260209.zip](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/nfse-esquemas_xsd-v1-01-20260209.zip), SHA-256 `e7935cbd9470527c6cc32984c1b2263e614183bf0139ce2733eaaed2de9a8072`. Seu `Schemas/1.01/tiposComplexos_v1.01.xsd` mantém **cTribNac, cTribMun?, xDescServ, cNBS?, cIntContrib?**. Os dois pacotes conservam a versão XML **1.01**, apesar da diferença na sequência.

## Diff

- `src/io/fiscal/gerar-xml-dps.ts`: serializa NBS antes da descrição quando `cfg.ambiente === 2`; conserva a ordem publicada de produção quando `ambiente === 1`. Preserva a presença condicional do NBS, valor, escape XML, classificação, código municipal, namespace e versão.
- `tests/emissao.test.ts`: oito cenários novos de presença/ausência dos campos opcionais NBS/código municipal nos dois ambientes, verificando ordem exata, valores, namespace, versão e estrutura `serv/locPrest/cServ`. Nenhum teste anterior ou assert removido/alterado.
- Este relatório registra fonte e evidências. Nenhuma dependência nova ou XSD remoto exigido para rodar a suíte.

## Verificações

- Antes: `npx vitest run --maxWorkers=1`: **1192 passaram, 3 ignorados, 1 falha**, 67 arquivos, 126,17 s. Timeout de 5000 ms no cenário `conversa não envia com flag envio off` de `servidor-conversa-livre.test.ts`, antes de qualquer alteração. Não alterado timeout nem teste legado.
- Teste de regressão antes da correção: **2 falharam, 29 passaram** em `emissao.test.ts`, 1,98 s. As falhas eram os dois cenários de homologação com NBS, por sequência invertida.
- Focados depois: `npx vitest run tests/emissao.test.ts tests/preferencias-fiscal.test.ts tests/lote-emissao-real.test.ts tests/servidor-conversa-livre.test.ts --maxWorkers=1`: **116 passaram**, 4 arquivos, 15,09 s, incluindo o arquivo que apresentou timeout no baseline.
- Validação adicional offline com `lxml.etree.XMLSchema`: incluídos os arquivos oficiais `tiposComplexos_v1.01.xsd` e suas dependências, declarando apenas uma raiz `serv` de tipo oficial `TCServ`. Os **8 grupos `serv` gerados passaram** no pacote correspondente ao ambiente. Dois controles negativos com NBS depois da descrição no XSD restrita foram rejeitados: `Element '{http://www.sped.fazenda.gov.br/nfse}cNBS': This element is not expected.` Não foram modificados os tipos dos schemas oficiais.
- `npx tsc --noEmit`: código de saída **0**, sem diagnósticos.
- Suíte integral final: `npx vitest run --maxWorkers=1`: **1201 passaram, 3 ignorados, 0 falhas**, **67 arquivos passaram**, 168,43 s.
- `git diff --check`: sem erros.

## Verificado versus hipótese

Verificado: a diferença entre os dois XSDs publicados, reprodução local da rejeição pela ordem antiga, validação XSD offline dos grupos `serv` corrigidos e preservação da estrutura/valores nos oito cenários. A validação adicional é especificamente do grupo de serviço; não equivale à validação de uma DPS inteira assinada nem à autorização SEFIN.

Não exercitado: transmissão real à SEFIN e eventuais regras de negócio posteriores à validação estrutural. A versão instalada do backend remoto não foi interrogada; a correção usa o pacote oficial atual de homologação e corresponde ao erro observado pelo usuário.

Sem banco real, credenciais reais, envio/emissão real, migration, flags, allowlist, alteração de trava fiscal, merge ou deploy.
