import express from 'express';
import type pg from 'pg';
import type { Model } from '@openai/agents';
import { criarRouterWebhookAgente, type ChaveMensagemRecebida } from './webhook.js';
import type { StatusFontes } from './agente.js';
import type { DiagnosticoMensagem } from './diagnostico.js';

/** Entrada HTTP exclusiva do piloto. Não monta APIs de OTP, cadastro,
 * notas, certificados, pacientes, links ou agendamentos do app normal.
 * A conta é criada/autenticada EXCLUSIVAMENTE pela área de login existente. */
export function criarAppPilotoLeitura(deps: {
  pool: pg.Pool;
  segredo: string;
  instancia: string;
  telefoneAutorizado: string;
  apiKey?: string;
  modeloNome?: string;
  painelUrl?: string;
  tracesAtivos?: boolean;
  diagnosticoAtivo?: boolean;
  modeloTeste?: Model;
  registrarDiagnostico?: (registro: DiagnosticoMensagem) => void;
  consultarStatus: (medicoId: string) => Promise<StatusFontes>;
  enviar: (telefone: string, texto: string) => Promise<boolean>;
  marcarLida?: (chave: ChaveMensagemRecebida) => Promise<boolean>;
  reagir?: (chave: ChaveMensagemRecebida, emoji: '👍' | '❤️' | '🔎' | '👀' | '✅') => Promise<boolean>;
  presenca?: (telefone: string, estado: 'composing' | 'paused') => Promise<boolean>;
}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok', modo: 'agente_piloto_leitura' }));
  app.use('/webhook/evolution', express.json({ limit: '16kb' }),
    criarRouterWebhookAgente({
      pool: deps.pool,
      ativo: true, envioAtivo: true,
      segredo: deps.segredo, instancia: deps.instancia, allowlist: [deps.telefoneAutorizado],
      apiKey: deps.apiKey, modeloNome: deps.modeloNome, painelUrl: deps.painelUrl,
      modeloTeste: deps.modeloTeste,
      tracesAtivos: deps.tracesAtivos, diagnosticoAtivo: deps.diagnosticoAtivo,
      registrarDiagnostico: deps.registrarDiagnostico,
      consultarStatus: deps.consultarStatus, enviar: deps.enviar,
      marcarLida: deps.marcarLida, reagir: deps.reagir, presenca: deps.presenca
    }));
  // Falha fechada: nada do servidor principal é importado ou exposto aqui.
  app.use((_req, res) => res.status(404).json({ ok: false, codigo: 'PILOTO_ROTA_NAO_DISPONIVEL' }));
  return app;
}
