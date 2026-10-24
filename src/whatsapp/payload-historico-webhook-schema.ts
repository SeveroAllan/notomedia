/**
 * Normaliza o evento de histórico da Evolution API, que mudou de uma lista
 * direta para um objeto com `messages` entre versões. Manter as duas formas
 * evita perder a sincronização durante atualizações da Evolution.
 */

import { z } from 'zod';
import { dadosMensagemSchema, type DadosMensagemEvolution } from './payload-webhook-schema.js';

const LIMITE_MENSAGENS_HISTORICO = 1000;
const dadosHistoricoSchema = z.union([
  z.array(dadosMensagemSchema).max(LIMITE_MENSAGENS_HISTORICO),
  z.object({ messages: z.array(dadosMensagemSchema).max(LIMITE_MENSAGENS_HISTORICO) }).passthrough()
]);

const webhookHistoricoSchema = z.object({
  event: z.string().min(1),
  instance: z.string().min(1),
  data: dadosHistoricoSchema
});

export interface PayloadHistoricoEvolution {
  instance: string;
  mensagens: DadosMensagemEvolution[];
}

export function extrairPayloadHistorico(payloadBruto: unknown): PayloadHistoricoEvolution | null {
  if (payloadBruto && typeof payloadBruto === 'object') {
    const data = (payloadBruto as { data?: unknown }).data;
    const mensagens = Array.isArray(data) ? data
      : data && typeof data === 'object' ? (data as { messages?: unknown }).messages : undefined;
    if (Array.isArray(mensagens) && mensagens.length > LIMITE_MENSAGENS_HISTORICO) return null;
  }
  const parsed = webhookHistoricoSchema.safeParse(payloadBruto);
  if (!parsed.success || normalizarEvento(parsed.data.event) !== 'messages.set') return null;

  const mensagens = Array.isArray(parsed.data.data)
    ? parsed.data.data
    : parsed.data.data.messages;

  return { instance: parsed.data.instance, mensagens };
}

export function ehEventoHistorico(payloadBruto: unknown): boolean {
  if (!payloadBruto || typeof payloadBruto !== 'object') return false;
  const evento = (payloadBruto as { event?: unknown }).event;
  return typeof evento === 'string' && normalizarEvento(evento) === 'messages.set';
}

export function ehEventoSincronizacaoAuxiliar(payloadBruto: unknown): boolean {
  if (!payloadBruto || typeof payloadBruto !== 'object') return false;
  const evento = (payloadBruto as { event?: unknown }).event;
  if (typeof evento !== 'string') return false;
  return ['chats.set', 'contacts.set'].includes(normalizarEvento(evento));
}

function normalizarEvento(evento: string): string {
  return evento.trim().toLowerCase().replaceAll('_', '.');
}
