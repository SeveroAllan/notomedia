import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';
import { responderAgente, type StatusFontes } from './agente.js';
import type { AgendaEscolhida } from './estado-conversa.js';
import { separarBaloes, reacaoContextual, solicitouVerificacao } from './baloes.js';
import {
  lerEstadoConversa, reservarMensagemConversa, registrarBalaoConversa,
  finalizarMensagemConversa, evoluirEstadoConversa, salvarEstadoConversa
} from './estado-conversa.js';
import type { Model } from '@openai/agents';
import { referenciaDiagnostica, type DiagnosticoAgente, type DiagnosticoMensagem } from './diagnostico.js';

export interface ChaveMensagemRecebida { id: string; remoteJid: string; fromMe: boolean }
const eventoSchema = z.object({
  instance: z.string(),
  event: z.string().optional(),
  data: z.object({
    key: z.object({
      id: z.string().min(1), remoteJid: z.string(), fromMe: z.boolean()
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

/** Apenas a instância do assistente. Nenhum efeito é disparado antes da autorização. */
export function criarRouterWebhookAgente(deps: {
  pool: pg.Pool;
  ativo: boolean;
  envioAtivo: boolean;
  segredo: string;
  instancia: string;
  allowlist: string[];
  apiKey?: string;
  modeloNome?: string;
  tracesAtivos?: boolean;
  modeloTeste?: Model;
  diagnosticoAtivo?: boolean;
  registrarDiagnostico?: (registro: DiagnosticoMensagem) => void;
  consultarStatus: (medicoId: string) => Promise<StatusFontes>;
  descobrirProfissionais?: (medicoId: string, agenda: AgendaEscolhida) => Promise<{ ok: boolean; nomes?: string[]; motivo?: string }>;
  solicitarLinkAgenda?: (medicoId: string, agenda: AgendaEscolhida, telefone: string) => Promise<{ enviado: boolean; motivo?: string }>;
  consultarProntidao?: (medicoId: string) => Promise<{ certificadoValido: boolean; dadosProfissionaisCompletos: boolean; dadosFiscaisConfirmados: boolean; liberadoParaEmitir: boolean }>;
  enviar: (telefone: string, texto: string) => Promise<boolean>;
  painelUrl?: string;
  persistirConversa?: boolean;
  marcarLida?: (chave: ChaveMensagemRecebida) => Promise<boolean>;
  reagir?: (chave: ChaveMensagemRecebida, emoji: '👍' | '❤️' | '🔎' | '👀' | '✅') => Promise<boolean>;
  presenca?: (telefone: string, estado: 'composing' | 'paused') => Promise<boolean>;
}) {
  const router = Router();
  // Compatibilidade de testes e processo de leitura sem permissão de escrita.
  // O servidor principal usa a reserva durável abaixo para sobreviver a réplicas.
  const mensagensVistas = new Set<string>();
  const contextoPorConta = new Map<string, string[]>();

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
    if (deps.allowlist.length !== 1 ||
        !gerarVariantesTelefoneBrasileiro(deps.allowlist[0]!).some(v => variantes.includes(v))) {
      res.sendStatus(204); return;
    }

    const chave = createHash('sha256').update(JSON.stringify([evento.instance, evento.data.key.id, telefone])).digest('hex');
    if (mensagensVistas.has(chave)) { res.sendStatus(200); return; }
    mensagensVistas.add(chave);
    if (mensagensVistas.size > 2500) {
      const primeiro = mensagensVistas.values().next().value;
      if (primeiro) mensagensVistas.delete(primeiro);
    }

    let reservada = false;
    let contaId: string | null = null;
    let digitando = false;
    let intervalo: ReturnType<typeof setInterval> | undefined;
    let enviado = false;
    try {
      const conta = await deps.pool.query(
        "select distinct conta_id from usuarios where ativo=true and auth_user_id is not null and conta_id is not null and regexp_replace(telefone, '[^0-9]', '', 'g') = any($1::text[]) limit 2",
        [variantes]
      );
      if (conta.rows.length > 1) { res.sendStatus(204); return; }
      contaId = conta.rows[0]?.conta_id ?? null;
      // Somente SELECT sem resultado é evidência de conta ausente.
      // Uma falha de consulta cai no catch e jamais é tratada como ausência.
      const medicos = contaId ? await deps.pool.query(
        'select id,nome_completo from medicos where conta_id=$1 order by nome_completo,id limit 21',
        [contaId]
      ) : { rows: [] };
      const profissionais = medicos.rows.map((m: { id: string; nome_completo: string | null }) => ({
        id: m.id, nome: String(m.nome_completo ?? '')
      }));
      const estado = deps.persistirConversa && contaId ? await lerEstadoConversa(deps.pool, contaId) : {};
      if (deps.persistirConversa && contaId) {
        if (!await reservarMensagemConversa(deps.pool, contaId, evento.instance, evento.data.key.id)) {
          res.sendStatus(200); return;
        }
        reservada = true;
      }
      const chaveContexto = JSON.stringify([contaId ?? 'sem_cadastro', telefone]);
      const marcar = async () => {
        try { await deps.marcarLida?.(evento.data.key); } catch { /* Sem impacto sobre resposta. */ }
      };
      await marcar();
      const emoji = reacaoContextual(texto);
      if (emoji) {
        try { await deps.reagir?.(evento.data.key, emoji); } catch { /* Sem impacto. */ }
      }
      if (deps.presenca) {
        digitando = true;
        await deps.presenca(telefone, 'composing').catch(() => false);
        intervalo = setInterval(() => { void deps.presenca?.(telefone, 'composing').catch(() => false); }, 3000);
      }

      let diagnostico: DiagnosticoAgente | undefined;
      const aoDiagnostico = (resultado: DiagnosticoAgente) => { diagnostico = resultado; };
      const resposta = await responderAgente({
        texto, profissionais, semConta: !contaId, estadoConversa: estado,
        painelUrl: deps.painelUrl,
        contexto: contextoPorConta.get(chaveContexto) ?? []
      }, {
        apiKey: deps.apiKey, modeloNome: deps.modeloNome, tracesAtivos: deps.tracesAtivos,
        modeloTeste: deps.modeloTeste, consultarStatus: deps.consultarStatus, aoDiagnostico,
        ...(deps.descobrirProfissionais ? { descobrirProfissionais: deps.descobrirProfissionais } : {}),
        ...(deps.solicitarLinkAgenda ? { solicitarLinkAgenda: (medicoId: string, agenda: AgendaEscolhida) => deps.solicitarLinkAgenda!(medicoId, agenda, telefone) } : {}),
        ...(deps.consultarProntidao ? { consultarProntidao: deps.consultarProntidao } : {})
      });

      const baloes = separarBaloes(resposta);
      enviado = baloes.length > 0;
      for (const balao of baloes) {
        if (deps.presenca) await deps.presenca(telefone, 'composing').catch(() => false);
        const ok = await deps.enviar(telefone, balao);
        if (!ok) { enviado = false; break; }
        if (reservada && contaId) await registrarBalaoConversa(deps.pool, contaId, evento.instance, evento.data.key.id);
      }

      if (enviado) {
        if (reservada && contaId) {
          const novo = evoluirEstadoConversa(estado, texto, resposta, profissionais);
          await salvarEstadoConversa(deps.pool, contaId, novo);
        } else {
          contextoPorConta.set(chaveContexto, [...(contextoPorConta.get(chaveContexto) ?? []), resposta.slice(0, 500)].slice(-3));
          if (contextoPorConta.size > 300) {
            const primeiro = contextoPorConta.keys().next().value;
            if (primeiro) contextoPorConta.delete(primeiro);
          }
        }
        const realizouVerificacao = diagnostico?.ferramentas.some(f =>
          ['STATUS_CONECTADO','STATUS_NAO_CONECTADO','CONEXAO_EXISTENTE','CONEXAO_PENDENTE'].includes(f.codigo));
        if (solicitouVerificacao(texto) && realizouVerificacao) {
          try { await deps.reagir?.(evento.data.key, '✅'); } catch { /* Não transforma falha em tarefa concluída. */ }
        }
      }
      if (deps.diagnosticoAtivo && diagnostico) {
        const registro: DiagnosticoMensagem = {
          tipo: 'noto_agent_execucao', versao: 1,
          mensagemRef: referenciaDiagnostica(deps.segredo, 'mensagem', [evento.instance, evento.data.key.id, telefone]),
          respostaRef: referenciaDiagnostica(deps.segredo, 'resposta', [resposta]),
          conta: contaId ? 'CADASTRADA' : 'SEM_CADASTRO', envio: enviado ? 'ENVIADO' : 'FALHOU', agente: diagnostico
        };
        try {
          if (deps.registrarDiagnostico) deps.registrarDiagnostico(registro);
          else console.info('[Noto Agent diagnóstico]', JSON.stringify(registro));
        } catch { /* Observabilidade não bloqueia atendimento. */ }
      }
      if (reservada && contaId) await finalizarMensagemConversa(deps.pool, contaId, evento.instance, evento.data.key.id, enviado);
      res.sendStatus(enviado ? 200 : 503);
    } catch {
      // Incerto: nenhum replay automático de balões possivelmente enviados.
      if (reservada && contaId) {
        await finalizarMensagemConversa(deps.pool, contaId, evento.instance, evento.data.key.id, false).catch(() => {});
      }
      res.sendStatus(503);
    } finally {
      if (intervalo) clearInterval(intervalo);
      if (digitando) await deps.presenca?.(telefone, 'paused').catch(() => false);
    }
  });
  return router;
}
