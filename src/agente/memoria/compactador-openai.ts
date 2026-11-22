/**
 * Compactador de memória de longo prazo via OpenAI. Isolado da lógica pura de
 * janelas/sanitização para nunca acoplar chamadas HTTP externas às regras de
 * seleção de lote ou aos testes unitários.
 */

import OpenAI from 'openai';
import { MAX_CHARS_RESUMO_MEMORIA } from './memoria-config.js';
import type { CompactadorTextoMemoria, MensagemMemoria } from './memoria-repositorio.js';

const INSTRUCAO_COMPACTACAO = [
  'Você compacta o histórico de conversa de WhatsApp entre um médico e sua secretária fiscal (Noto).',
  'Produza JSON estrito no formato {"resumo":"...","fatosCombinados":["..."]}.',
  'Preserve apenas fatos realmente ditos: decisões, preferências de rotina, pedidos feitos pelo médico,',
  'pacientes/datas mencionados, pendências citadas (ex.: certificado pendente) e o que NÃO foi pedido.',
  'Nunca invente emissões, valores, CPFs, senhas ou promessas. Português natural, conciso e fiel.'
].join(' ');

export function criarCompactadorMemoriaOpenAi(
  apiKey: string,
  modelo = 'gpt-4.1-mini'
): CompactadorTextoMemoria {
  const client = new OpenAI({ apiKey, maxRetries: 1 });

  return {
    async compactar(entrada: {
      periodoInicio: string;
      periodoFim: string;
      mensagens: readonly MensagemMemoria[];
    }) {
      if (!apiKey || !entrada.mensagens.length) return null;
      const transcricao = entrada.mensagens
        .map(m => `[${m.diaReferencia}] ${m.autor === 'medico' ? 'Médico' : 'Noto'}: ${m.texto}`)
        .join('\n');

      try {
        const resp = await client.responses.create({
          model: modelo,
          instructions: INSTRUCAO_COMPACTACAO,
          input: `Período ${entrada.periodoInicio} a ${entrada.periodoFim}:\n${transcricao}`
        });
        const texto = resp.output_text?.trim() ?? '';
        const limpo = texto.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
        const json = JSON.parse(limpo) as { resumo?: unknown; fatosCombinados?: unknown };
        if (typeof json.resumo !== 'string' || !json.resumo.trim()) return null;
        const fatos = Array.isArray(json.fatosCombinados)
          ? json.fatosCombinados.filter((f): f is string => typeof f === 'string' && f.trim().length > 0).slice(0, 10)
          : [];
        return {
          resumo: json.resumo.trim().slice(0, MAX_CHARS_RESUMO_MEMORIA),
          fatosCombinados: fatos
        };
      } catch {
        return null;
      }
    }
  };
}
