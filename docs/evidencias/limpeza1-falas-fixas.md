# LIMPEZA 1 — falas fixas, sem mudança de comportamento

Base: e07ffdd, branch feat/conversa-etapa1.

Movidas para `src/onboarding/falas.ts`, com os literais exatos: pedido de conexão da agenda; segurança/validade do link; proteção de credencial colada na conversa; link anterior válido; fallback; introdução do novo link; pergunta de início das notas; pedido de data de início. São oito constantes, usadas por cinco consumidores. O fallback mantém reexport no caminho antigo por compatibilidade.

Ficaram neste passo:

- Prompts, exemplos de IA e classificadores (inclusive `confirmacao-emissao-medico.ts`): não são falas fixas enviadas diretamente; fora do escopo.
- Confirmações e resumos de lote: vinculados à pergunta autorizada, totais/prazos e trilha fiscal; não tocar neste passo.
- Textos dinâmicos de pendências/boas-vindas: formatação de nomes, datas, valores e cortes continua nos montadores.
- Demais respostas por estado/ferramenta, alternativas das guardas e mensagens de erro: mantidas junto à seleção/validação atual para limitar esta extração ao pequeno grupo acima.

Prova estática: desfazendo somente os imports, o reexport e as substituições de constantes, cada um dos cinco consumidores recupera byte a byte o arquivo da base. Módulo novo sem dependências, somente constantes; nenhuma mudança de lógica, texto, ordem de balões ou mecanismo de envio.

Antes: três arquivos, 226 passaram / 3 ignorados (22,42 s); dois arquivos de período/regras, 83 passaram (15,28 s). Teste novo primeiro: falhou apontando as cinco cópias literais esperadas. Depois: seis arquivos, 310 passaram / 3 ignorados (31,11 s), exit 0. Nenhum teste ou asserção existente foi editado. Adicionado exatamente um teste, que importa cinco falas principais e varre os arquivos TypeScript de `src` procurando suas cópias literais fora do módulo.

Typecheck: `npx tsc --noEmit`, saída vazia, exit 0. Logs locais: `work/limpeza1-*.log`. Verificado: identidade dos literais, equivalência estática e testes relacionados. Suíte completa fica para o gate do solicitante. Sem banco real, envio real, migration, merge ou deploy.
