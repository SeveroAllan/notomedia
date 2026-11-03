import { createHmac } from 'node:crypto';

export type EstadoEntregaLink = 'ACEITO_API' | 'PENDING' | 'SERVER_ACK' | 'DELIVERY_ACK' | 'READ' | 'ERROR';
export type DiagnosticoEntregaLink = 'ACEITO_SEM_CONFIRMACAO' | 'AGUARDANDO_ENTREGA' |
  'SEM_CONFIRMACAO' | 'ENTREGUE' | 'LIDO' | 'ERRO_COMPROVADO';

/** Atraso de telemetria NAO e prova de falha. */
export function diagnosticarEntregaLink(
  estado: EstadoEntregaLink, aceitoEm: Date, agora: Date, minutosSemConfirmacao = 2
): DiagnosticoEntregaLink {
  if (estado === 'READ') return 'LIDO';
  if (estado === 'DELIVERY_ACK') return 'ENTREGUE';
  if (estado === 'ERROR') return 'ERRO_COMPROVADO';
  if (agora.getTime() - aceitoEm.getTime() >= minutosSemConfirmacao * 60_000) return 'SEM_CONFIRMACAO';
  return estado === 'SERVER_ACK' ? 'AGUARDANDO_ENTREGA' : 'ACEITO_SEM_CONFIRMACAO';
}

/** Protege de eventos fora de ordem, repetidos e atrasados. ERROR nao e inferido por tempo. */
export function evoluirEstadoEntrega(atual: EstadoEntregaLink, proximo: EstadoEntregaLink): EstadoEntregaLink {
  const ordem: Record<EstadoEntregaLink, number> = {
    ACEITO_API: 0, PENDING: 0, SERVER_ACK: 1, ERROR: 2, DELIVERY_ACK: 3, READ: 4
  };
  if (atual === 'READ' || atual === 'DELIVERY_ACK' && proximo === 'ERROR') return atual;
  return ordem[proximo] > ordem[atual] ? proximo : atual;
}

export interface EventoEstadoEvolution {
  instance: string;
  event: string;
  data: {
    keyId?: string;
    key?: { id?: string; remoteJid?: string; fromMe?: boolean };
    remoteJid?: string;
    remoteJidAlt?: string;
    fromMe?: boolean;
    status?: string;
  };
}
export function interpretarEstadoEvolution(entrada: unknown): {
  instancia: string; mensagemId: string; destinatarios: string[]; estado: EstadoEntregaLink
} | null {
  if (!entrada || typeof entrada !== 'object') return null;
  const e = entrada as Partial<EventoEstadoEvolution>;
  if (e.event?.toLowerCase().replace('_','.') !== 'messages.update' ||
      !e.data || !e.instance || typeof e.instance !== 'string') return null;
  const d = e.data;
  const estado = d.status;
  if (!['PENDING','SERVER_ACK','DELIVERY_ACK','READ','ERROR'].includes(estado ?? '')) return null;
  // Nunca aceitar evento de recebimento do proprio usuario como ACK de saida.
  if (d.fromMe !== true && d.key?.fromMe !== true) return null;
  const mensagemId = d.keyId || d.key?.id;
  if (typeof mensagemId !== 'string' || !/^[A-Za-z0-9_-]{5,150}$/.test(mensagemId)) return null;
  const jids = [d.remoteJid, d.remoteJidAlt, d.key?.remoteJid]
    .filter((v): v is string => typeof v === 'string');
  const numeros = [...new Set(jids.map(v=>/^([0-9]{10,15})@s\.whatsapp\.net$/.exec(v)?.[1]).filter((v):v is string=>!!v))];
  if (!numeros.length) return null;
  return { instancia:e.instance, mensagemId, destinatarios:numeros, estado:estado as EstadoEntregaLink };
}

export function hashDestinatario(segredo: string, telefone: string): string {
  const numeros = telefone.replace(/\D/g,'');
  if (!/^\d{10,15}$/.test(numeros) || !segredo) throw new Error('DESTINO_INVALIDO');
  return createHmac('sha256',segredo).update('cofre-entrega-v1:'+numeros).digest('hex');
}
