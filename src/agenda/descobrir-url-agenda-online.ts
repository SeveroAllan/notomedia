/**
 * Busca online a URL HTTPS de login de uma agenda médica que não está no
 * catálogo pré-definido antes do envio do link do cofre ao usuário.
 * Isola I/O de rede (OpenSERP e seleção opcional por IA restrita aos
 * candidatos reais retornados) das regras puras de pontuação.
 */

import {
  escolherMelhorUrlLoginAgenda,
  type CandidatoBuscaAgenda
} from './escolher-url-login-agenda.js';

export interface FonteBuscaWebAgenda {
  pesquisar(consulta: string): Promise<CandidatoBuscaAgenda[]>;
}

export type ResultadoDescobertaAgendaOnline =
  | { ok: true; nomeAgenda: string; urlLogin: string; host: string; fonte: 'openserp' | 'personalizada' }
  | { ok: false; motivo: 'NOME_INVALIDO' | 'BUSCA_INDISPONIVEL' | 'URL_NAO_LOCALIZADA' };

export type SeletorIaUrlAgenda = (entrada: {
  nomeAgenda: string;
  candidatos: readonly { url: string; host: string; titulo: string }[];
}) => Promise<string | null>;

function montarEndpointOpenSerp(baseUrl: string, consulta: string): URL | null {
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/google/search`;
    url.search = new URLSearchParams({
      text: consulta,
      limit: '10',
      lang: 'PT',
      region: 'BR',
      format: 'json'
    }).toString();
    return url;
  } catch {
    return null;
  }
}

export function criarFonteBuscaOpenSerp(
  baseUrl: string,
  requisitar: typeof fetch = fetch
): FonteBuscaWebAgenda {
  return {
    async pesquisar(consulta: string): Promise<CandidatoBuscaAgenda[]> {
      const endpoint = montarEndpointOpenSerp(baseUrl, consulta);
      if (!endpoint) return [];
      const resp = await requisitar(endpoint, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { Accept: 'application/json' }
      });
      if (!resp.ok) return [];
      const corpo = (await resp.json().catch(() => null)) as { results?: unknown[] } | null;
      if (!corpo || !Array.isArray(corpo.results)) return [];
      return corpo.results
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        .filter(item => !('type' in item) || item['type'] === 'organic')
        .map(item => ({
          titulo: String(item['title'] ?? ''),
          url: String(item['url'] ?? item['link'] ?? ''),
          trecho: String(item['snippet'] ?? item['description'] ?? '')
        }))
        .filter(item => item.url.startsWith('https://'));
    }
  };
}

export async function descobrirUrlAgendaOnline(
  nomeAgenda: string,
  deps: {
    fonteBusca?: FonteBuscaWebAgenda | null;
    selecionarComIa?: SeletorIaUrlAgenda | null;
  }
): Promise<ResultadoDescobertaAgendaOnline> {
  const limpo = nomeAgenda.trim();
  if (limpo.length < 2 || limpo.length > 80) {
    return { ok: false, motivo: 'NOME_INVALIDO' };
  }
  if (!deps.fonteBusca) {
    return { ok: false, motivo: 'BUSCA_INDISPONIVEL' };
  }
  let resultados: CandidatoBuscaAgenda[];
  try {
    resultados = await deps.fonteBusca.pesquisar(`"${limpo}" login sistema agenda medica`);
    if (!resultados.length) {
      resultados = await deps.fonteBusca.pesquisar(`${limpo} entrar sistema clinica`);
    }
  } catch {
    return { ok: false, motivo: 'BUSCA_INDISPONIVEL' };
  }

  const escolha = escolherMelhorUrlLoginAgenda(limpo, resultados);
  if (!escolha) {
    return { ok: false, motivo: 'URL_NAO_LOCALIZADA' };
  }

  if (deps.selecionarComIa && escolha.candidatosValidados.length > 1) {
    try {
      const escolhidaIa = await deps.selecionarComIa({
        nomeAgenda: limpo,
        candidatos: escolha.candidatosValidados
      });
      const validada = escolha.candidatosValidados.find(c => c.url === escolhidaIa);
      if (validada) {
        return {
          ok: true,
          nomeAgenda: limpo,
          urlLogin: validada.url,
          host: validada.host,
          fonte: 'openserp'
        };
      }
    } catch {
      // Falha da IA preserva o melhor candidato determinístico da busca real.
    }
  }

  return {
    ok: true,
    nomeAgenda: limpo,
    urlLogin: escolha.urlLogin,
    host: escolha.host,
    fonte: 'openserp'
  };
}
