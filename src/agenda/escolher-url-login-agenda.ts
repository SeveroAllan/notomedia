/**
 * Regras puras para reconhecer agendas pré-definidas pelo nome e escolher a
 * melhor URL HTTPS de login entre resultados de busca online para agendas que
 * ainda não pertencem ao catálogo fixo. Sem rede nem `process.env`.
 */

import {
  AGENDAS_SUPORTADAS,
  hostPrivadoOuLocal,
  type AgendaPreDefinida,
  type DefinicaoAgendaSuportada
} from './agendas-suportadas.js';

export interface CandidatoBuscaAgenda {
  titulo: string;
  url: string;
  trecho: string;
}

export interface ResultadoEscolhaUrlAgenda {
  urlLogin: string;
  host: string;
  pontuacao: number;
  candidatosValidados: readonly { url: string; host: string; titulo: string }[];
}

const DOMINIOS_BLOQUEADOS = [
  'google.com', 'facebook.com', 'instagram.com', 'linkedin.com', 'youtube.com', 'youtu.be',
  'twitter.com', 'x.com', 'tiktok.com', 'wikipedia.org', 'reclameaqui.com.br', 'jusbrasil.com.br',
  'play.google.com', 'apps.apple.com', 'apple.com', 'capterra.com', 'capterra.com.br',
  'b2bstack.com.br', 'g2.com', 'trustpilot.com', 'medium.com', 'github.com', 'reddit.com'
];

const SUBDOMINIOS_LOGIN = ['app.', 'login.', 'acesso.', 'sistema.', 'painel.', 'portal.', 'agenda.', 'web.', 'auth.'];
const CAMINHOS_LOGIN = /\/(?:login|entrar|acesso|acessar|signin|sign-in|auth|portal|app|sistema)\b/i;
const CAMINHOS_EDITORIAL = /\/(?:blog|artigo|artigos|noticia|noticias|ajuda|suporte|help|precos|planos|sobre|contato)\b/i;

function normalizarTexto(valor: string): string {
  return valor
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function identificarAgendaPreDefinida(texto: string): AgendaPreDefinida | null {
  const norm = normalizarTexto(texto);
  if (!norm) return null;
  const encontradas: AgendaPreDefinida[] = [];
  for (const id of Object.keys(AGENDAS_SUPORTADAS) as (keyof typeof AGENDAS_SUPORTADAS)[]) {
    if (id === 'personalizada') continue;
    const cfg = AGENDAS_SUPORTADAS[id] as DefinicaoAgendaSuportada;
    const casou = cfg.apelidos.some(apelido => new RegExp(`(?:^|\\s)${apelido}(?:\\s|$)`).test(norm));
    if (casou) encontradas.push(id);
  }
  return encontradas.length === 1 ? encontradas[0]! : null;
}

function tokensNomeAgenda(nomeAgenda: string): string[] {
  const ignorar = new Set(['agenda', 'sistema', 'clinica', 'medico', 'medica', 'saude', 'web', 'online', 'software', 'prontuario', 'consultorio']);
  return normalizarTexto(nomeAgenda)
    .split(' ')
    .filter(t => t.length >= 3 && !ignorar.has(t));
}

function ehDominioBloqueado(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return DOMINIOS_BLOQUEADOS.some(d => h === d || h.endsWith(`.${d}`));
}

function pontuarCandidato(url: URL, candidato: CandidatoBuscaAgenda, tokens: readonly string[], compacto: string): number {
  const host = url.hostname.toLowerCase();
  const hostCompacto = host.replace(/[^a-z0-9]/g, '');
  const caminho = url.pathname.toLowerCase();
  const textoBusca = normalizarTexto(`${candidato.titulo} ${candidato.trecho}`);
  let pontos = 0;

  if (compacto.length >= 3 && hostCompacto.includes(compacto)) pontos += 50;
  for (const token of tokens) {
    if (host.includes(token)) pontos += 25;
    else if (textoBusca.includes(token)) pontos += 8;
  }
  if (SUBDOMINIOS_LOGIN.some(sub => host.startsWith(sub))) pontos += 22;
  if (CAMINHOS_LOGIN.test(caminho)) pontos += 20;
  if (/\b(?:login|entrar|acessar|acesse sua conta|faca login)\b/.test(textoBusca)) pontos += 12;
  if (CAMINHOS_EDITORIAL.test(caminho)) pontos -= 30;
  if (caminho === '/' || caminho === '') pontos += 4;
  return pontos;
}

export function escolherMelhorUrlLoginAgenda(
  nomeAgenda: string,
  resultados: readonly CandidatoBuscaAgenda[]
): ResultadoEscolhaUrlAgenda | null {
  const nomeLimpo = nomeAgenda.trim();
  if (nomeLimpo.length < 2 || nomeLimpo.length > 80) return null;
  const tokens = tokensNomeAgenda(nomeLimpo);
  const compacto = normalizarTexto(nomeLimpo).replace(/\s+/g, '');

  const avaliados: { urlLogin: string; host: string; titulo: string; pontuacao: number }[] = [];
  const vistas = new Set<string>();

  for (const item of resultados) {
    let parsed: URL;
    try {
      parsed = new URL(item.url.trim());
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) continue;
    if (hostPrivadoOuLocal(parsed.hostname) || ehDominioBloqueado(parsed.hostname)) continue;

    const urlLimpa = `${parsed.origin}${parsed.pathname}`;
    if (vistas.has(urlLimpa)) continue;
    vistas.add(urlLimpa);

    const pontuacao = pontuarCandidato(parsed, item, tokens, compacto);
    if (pontuacao < 20) continue;
    avaliados.push({
      urlLogin: urlLimpa,
      host: parsed.hostname.toLowerCase(),
      titulo: item.titulo.trim().slice(0, 120),
      pontuacao
    });
  }

  avaliados.sort((a, b) => b.pontuacao - a.pontuacao);
  const melhor = avaliados[0];
  if (!melhor) return null;
  return {
    urlLogin: melhor.urlLogin,
    host: melhor.host,
    pontuacao: melhor.pontuacao,
    candidatosValidados: avaliados.slice(0, 5).map(({ urlLogin, host, titulo }) => ({ url: urlLogin, host, titulo }))
  };
}
