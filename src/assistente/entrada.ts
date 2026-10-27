import { validarWebhookSecret } from '../whatsapp/validar-webhook-secret.js';
import { webhookEvolutionSchema } from '../whatsapp/payload-webhook-schema.js';

export interface EntradaAssistente { instancia: string; mensagemId: string; telefone: string; texto: string }
export async function receberMensagemAssistente(payload: unknown, segredo: string | undefined, deps: {
  segredo: string; instancia: string;
  registrar: (entrada: EntradaAssistente) => Promise<unknown>;
}): Promise<{ status: number }> {
  if (!validarWebhookSecret(segredo, deps.segredo)) return { status: 401 };
  const parsed = webhookEvolutionSchema.safeParse(payload);
  if (!parsed.success) return { status: 400 };
  const { instance, event, data } = parsed.data;
  if (instance !== deps.instancia || event !== 'messages.upsert' || data.key.fromMe) return { status: 202 };
  // Evolution pode fornecer LID e telefone juntos; dois telefones conflitantes são rejeitados.
  const principal = data.key.remoteJid, alternativo = data.key.remoteJidAlt;
  const telefoneJid = /^\d{10,15}@s\.whatsapp\.net$/;
  const identidadeValida = (jid: string) => telefoneJid.test(jid) || /^\d+@lid$/.test(jid);
  if (!identidadeValida(principal) || (alternativo && !identidadeValida(alternativo))) return { status: 202 };
  if (telefoneJid.test(principal) && alternativo && telefoneJid.test(alternativo) && principal !== alternativo) return { status: 202 };
  const jid = telefoneJid.test(principal) ? principal : alternativo;
  if (!jid || !telefoneJid.test(jid)) return { status: 202 };
  const texto = data.message?.conversation ?? data.message?.extendedTextMessage?.text;
  if (!texto?.trim() || texto.length > 8000) return { status: 202 };
  await deps.registrar({ instancia: instance, mensagemId: data.key.id, telefone: jid.split('@')[0], texto: texto.trim() });
  return { status: 202 };
}
