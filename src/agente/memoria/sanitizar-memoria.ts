/**
 * Sanitização pura e cálculo do dia de referência antes de gravar qualquer
 * mensagem na memória conversacional. Separado do repositório Postgres para
 * garantir, sem banco, que senhas, tokens do cofre e CPFs nunca vazem.
 */

import { contemCredencialAgenda } from '../../cofre/links.js';
import { FUSO_HORARIO_MEMORIA, MAX_CHARS_MENSAGEM_MEMORIA } from './memoria-config.js';

const REGEX_LINK_COFRE = /https?:\/\/[^\s<>]*\/c\/[^\s<>]*/gi;
const REGEX_CPF_FORMATADO = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
const REGEX_CPF_PURO = /\b\d{11}\b/g;

export function diaReferenciaMemoria(data: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_HORARIO_MEMORIA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(data);
}

/**
 * Remove segredos e reduz dados sensíveis antes da persistência na memória.
 * Retorna `null` se a mensagem parecer conter senha/token bruto do usuário.
 */
export function sanitizarTextoParaMemoria(texto: string): string | null {
  const bruto = texto.trim();
  if (!bruto) return null;

  const semLinksCofre = bruto.replace(REGEX_LINK_COFRE, '[link seguro do cofre]');
  if (contemCredencialAgenda(semLinksCofre)) return null;

  const semCpf = semLinksCofre
    .replace(REGEX_CPF_FORMATADO, '[CPF oculto]')
    .replace(REGEX_CPF_PURO, '[documento oculto]')
    .replace(/\s+/g, ' ')
    .trim();

  if (!semCpf) return null;
  return semCpf.slice(0, MAX_CHARS_MENSAGEM_MEMORIA);
}
