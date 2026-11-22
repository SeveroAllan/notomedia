/**
 * Pós-filtro determinístico de humanização PT-BR para saída no WhatsApp
 * (inspirado na skill `humanizar`, perfil WhatsApp).
 * Combina reparo de mojibake UTF-8, remoção de markdown sintético, higiene
 * profissional (`higienizarComunicacaoProfissional`) e corte de encerramentos
 * de call center com trava factual absoluta.
 */

import { higienizarComunicacaoProfissional } from './regras/higienizar-comunicacao-profissional.js';

const MULETAS_ENCERRAMENTO: RegExp[] = [
  /(?:\s*\n+|\s+)(?:posso\s+(?:te\s+)?ajudar\s+(?:com|em)\s+(?:mais\s+)?alguma\s+(?:outra\s+)?coisa(?:\s+agora)?\??)\s*$/i,
  /(?:\s*\n+|\s+)(?:quer\s+que\s+eu\s+ajude\s+(?:com|em)\s+(?:mais\s+)?alguma\s+coisa(?:\s+agora)?\??)\s*$/i,
  /(?:\s*\n+|\s+)(?:quer\s+que\s+eu\s+(?:te\s+)?(?:ajude|confira)\s+[^\n?!.]{0,65}\bou\s+(?:confira|ajudo|ajude)\s+(?:com\s+)?(?:algo|outra\s+coisa)[^\n?!.]*\??)\s*$/i,
  /(?:\s*\n+|\s+)(?:(?:se\s+precisar(?:\s+de\s+(?:mais\s+)?(?:algo|alguma\s+coisa))?|qualquer\s+d[úu]vida|caso\s+precise\s+de\s+algo(?:\s+mais)?),?\s*(?:estou\s+[àa]\s+disposi[çc][ãa]o|fico\s+[àa]\s+disposi[çc][ãa]o|(?:[ée]\s+)?s[óo]\s+(?:me\s+)?(?:chamar|avisar|falar|mandar))[\s.!]*)\s*$/i,
  /(?:\s*\n+|\s+)(?:o\s+que\s+(?:voc[êe]\s+)?(?:quer|gostaria\s+de)\s+fazer(?:\s+agora)?\??)\s*$/i,
  /(?:\s*\n+|\s+)(?:estou\s+[àa]\s+disposi[çc][ãa]o[\s.!]*|fico\s+[àa]\s+disposi[çc][ãa]o[\s.!]*)\s*$/i
];

const PADRAO_MOJIBAKE_UTF8 = /\u00C3[\u0080-\u00BF]|\u00C2[\u00A0-\u00BF]/;

/**
 * Repara determinísticamente textos UTF-8 que foram lidos como Latin-1/Windows-1252
 * (ex.: "OlÃ¡! Vou organizar o consultÃ³rio e a emissÃ£o" -> "Olá! Vou organizar o consultório e a emissão").
 */
export function repararMojibakeUtf8(texto: string): string {
  if (!texto || !PADRAO_MOJIBAKE_UTF8.test(texto)) return texto;
  try {
    const reparado = Buffer.from(texto, 'latin1').toString('utf8');
    if (!reparado.includes('\uFFFD')) return reparado;
  } catch {
    // Mantém texto original se não for sequência Latin-1 pura.
  }
  return texto;
}

function removerNegritoMarkdownPreservandoUrls(texto: string): string {
  const urls: string[] = [];
  const protegido = texto.replace(/https?:\/\/\S+/gi, url => {
    urls.push(url);
    return `__URL_PROTEGIDA_${urls.length - 1}__`;
  });
  const semNegrito = protegido.replace(/\*\*([^*\n]{1,120})\*\*/g, '$1');
  return semNegrito.replace(/__URL_PROTEGIDA_(\d+)__/g, (_m, idx) => urls[Number(idx)] ?? '');
}

export function humanizarSaidaWhatsApp(texto: string): string {
  const original = repararMojibakeUtf8(texto).trim();
  if (!original || original.startsWith('{')) return original;

  let limpo = higienizarComunicacaoProfissional(removerNegritoMarkdownPreservandoUrls(original));

  for (const muleta of MULETAS_ENCERRAMENTO) {
    const candidato = limpo.replace(muleta, '').trim();
    // Só remove a frase de encerramento se restar conteúdo real antes dela.
    if (candidato.length >= 12) {
      limpo = candidato;
    }
  }

  limpo = limpo
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return limpo || original;
}
