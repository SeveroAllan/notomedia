/**
 * Constantes de negócio da memória conversacional em duas camadas (curto prazo
 * do dia + compactação progressiva de longo prazo). Isoladas de `process.env`
 * e de banco para manter as regras puras e previsíveis nos testes.
 */

export const FUSO_HORARIO_MEMORIA = 'America/Sao_Paulo';

/** Quantidade máxima de mensagens recentes mantidas abertas na janela do dia. */
export const LIMITE_MENSAGENS_CURTO_PRAZO = 24;

/** Ao exceder este total de mensagens não compactadas, o excesso mais antigo é compactado. */
export const GATILHO_COMPACTACAO_MESMO_DIA = 32;

/** Quantidade de mensagens preservadas em aberto após compactar excesso do mesmo dia. */
export const MANTER_EM_ABERTO_APOS_COMPACTACAO = 14;

/** Quantidade máxima de resumos compactados injetados no contexto do agente. */
export const MAX_RESUMOS_CONTEXTO = 6;

/** Limite de caracteres por mensagem salva na memória sanitizada. */
export const MAX_CHARS_MENSAGEM_MEMORIA = 600;

/** Limite de caracteres por resumo compactado de longo prazo. */
export const MAX_CHARS_RESUMO_MEMORIA = 1800;

/** Limite de registros retornados em cada consulta da ferramenta de busca na memória. */
export const MAX_ITENS_BUSCA_MEMORIA = 10;
