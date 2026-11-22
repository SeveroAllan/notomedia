/**
 * Fonte de busca web em tempo real usando OpenAI Responses API (`web_search_preview`).
 * Implementa a porta `FonteBuscaWebAgenda` para que o agente localize a URL HTTPS
 * real de login de agendas fora da lista pré-definida mesmo sem OpenSERP local.
 */

import OpenAI from 'openai';
import type { CandidatoBuscaAgenda } from './escolher-url-login-agenda.js';
import type { FonteBuscaWebAgenda } from './descobrir-url-agenda-online.js';

export function criarFonteBuscaOpenAiWebSearch(apiKey: string, modelo = 'gpt-4o-mini'): FonteBuscaWebAgenda {
  const client = new OpenAI({ apiKey: apiKey.trim(), maxRetries: 1, timeout: 18_000 });

  return {
    async pesquisar(consulta: string): Promise<CandidatoBuscaAgenda[]> {
      try {
        const resp = await client.responses.create({
          model: modelo,
          tools: [{ type: 'web_search_preview' }],
          input: `Encontre a página oficial de login (HTTPS) do sistema de agenda médica: ${consulta}. Retorne a URL oficial de login.`
        });

        const candidatos: CandidatoBuscaAgenda[] = [];
        const vistas = new Set<string>();
        const itens = Array.isArray((resp as any).output) ? ((resp as any).output as any[]) : [];

        for (const item of itens) {
          const conteudos = Array.isArray(item?.content) ? item.content : [];
          for (const bloco of conteudos) {
            const anotacoes = Array.isArray(bloco?.annotations) ? bloco.annotations : [];
            for (const an of anotacoes) {
              const url = String(an?.url ?? '').trim();
              if (!url.startsWith('https://') || vistas.has(url)) continue;
              vistas.add(url);
              candidatos.push({
                titulo: String(an?.title ?? consulta).slice(0, 120),
                url,
                trecho: String(bloco?.text ?? '').slice(0, 240)
              });
            }
          }
        }

        const textoSaida = String((resp as any).output_text ?? '');
        for (const m of textoSaida.matchAll(/https:\/\/[^\s)>\]"']+/g)) {
          const url = m[0].replace(/[.,;:!?]+$/, '');
          if (vistas.has(url)) continue;
          vistas.add(url);
          candidatos.push({ titulo: consulta, url, trecho: textoSaida.slice(0, 240) });
        }
        return candidatos;
      } catch {
        return [];
      }
    }
  };
}
