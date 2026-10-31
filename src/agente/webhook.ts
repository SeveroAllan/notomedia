import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';
import { responderAgente, type CompletarAgente, type StatusFontes } from './agente.js';

const eventoSchema = z.object({
  instance: z.string(),
  event: z.string().optional(),
  data: z.object({
    key: z.object({
      id: z.string().min(1),
      remoteJid: z.string(),
      fromMe: z.boolean()
    }).passthrough(),
    message: z.object({
      conversation: z.string().optional(),
      extendedTextMessage: z.object({ text: z.string().optional() }).passthrough().optional()
    }).passthrough().optional()
  }).passthrough()
}).passthrough();

function segredoIgual(recebido: string | undefined, esperado: string): boolean {
  if (!recebido || !esperado) return false;
  const a = createHash('sha256').update(recebido).digest();
  const b = createHash('sha256').update(esperado).digest();
  return timingSafeEqual(a, b);
}

/** Endpoint exclusivo da instância do assistente; demais instâncias não acionam IA. */
export function criarRouterWebhookAgente(deps: {
  pool: pg.Pool;
  ativo: boolean;
  envioAtivo: boolean;
  segredo: string;
  instancia: string;
  allowlist: string[];
  completar: CompletarAgente;
  consultarStatus: (medicoId: string) => Promise<StatusFontes>;
  enviar: (telefone: string, texto: string) => Promise<boolean>;
}) {
  const router = Router();
  // Deduplicação provisória em uma única réplica; persistência distribuída é parte da entrega B.
  const mensagensVistas = new Set<string>();

  router.post('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.ativo || !deps.envioAtivo) { res.sendStatus(204); return; }
    if (!segredoIgual(req.header('x-webhook-secret'), deps.segredo)) {
      res.sendStatus(401); return;
    }
    const parsed = eventoSchema.safeParse(req.body);
    if (!parsed.success) { res.sendStatus(204); return; }
    const evento = parsed.data;
    if (evento.instance !== deps.instancia || evento.event?.toLowerCase() !== 'messages.upsert' || evento.data.key.fromMe) {
      res.sendStatus(204); return;
    }
    const jid = /^(\d{10,13})@s\.whatsapp\.net$/.exec(evento.data.key.remoteJid);
    const telefone = jid?.[1];
    const texto = evento.data.message?.conversation || evento.data.message?.extendedTextMessage?.text || '';
    if (!telefone || !texto.trim() || texto.length > 1500) { res.sendStatus(204); return; }
    const variantes = gerarVariantesTelefoneBrasileiro(telefone);
    if (!deps.allowlist.some(t => gerarVariantesTelefoneBrasileiro(t).some(v => variantes.includes(v)))) {
      res.sendStatus(204); return;
    }

    const chave = createHash('sha256').update(JSON.stringify([evento.instance, evento.data.key.id, telefone])).digest('hex');
    if (mensagensVistas.has(chave)) { res.sendStatus(200); return; }
    // Reserva antes do primeiro await; duas entregas concorrentes não processam a mesma mensagem.
    mensagensVistas.add(chave);
    if (mensagensVistas.size > 2500) {
      const primeiro = mensagensVistas.values().next().value;
      if (primeiro) mensagensVistas.delete(primeiro);
    }
    try {
      const conta = await deps.pool.query(
        "select distinct conta_id from usuarios where ativo = true and regexp_replace(telefone, '[^0-9]', '', 'g') = any($1::text[]) limit 2",
        [variantes]
      );
      // Identidade ambígua ou não cadastrada: falha fechada; nunca escolhe uma conta.
      if (conta.rows.length !== 1) { res.sendStatus(204); return; }
      const medicos = await deps.pool.query(
        'select id, nome_completo from medicos where conta_id = $1 order by nome_completo, id limit 21',
        [conta.rows[0].conta_id]
      );

      const resposta = await responderAgente({
        texto,
        profissionais: medicos.rows.map((m: { id: string; nome_completo: string | null }) => ({
          id: m.id, nome: String(m.nome_completo ?? '')
        }))
      }, { completar: deps.completar, consultarStatus: deps.consultarStatus });

      const enviado = await deps.enviar(telefone, resposta);
      if (!enviado) { res.sendStatus(503); return; }
      res.sendStatus(200);
    } catch {
      // Nunca registrar texto, telefones, nomes de pacientes ou resposta do provedor.
      res.sendStatus(503);
    }
  });
  return router;
}
