import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import { z } from 'zod';
import { carregarConfig } from '../config.js';
import { criarModeloAssistente, criarEnvioAssistente } from './integracoes.js';
import { consultarStatusOnboarding } from '../onboarding/io/consultar-status-onboarding.js';
import { receberMensagemAssistente } from './entrada.js';
import { PostgresAssistente, type TipoTrabalho } from './postgres-assistente.js';
import { executarPassoAssistente, type DependenciasWorkerAssistente } from './worker.js';

const ambiente = z.object({
  ASSISTENTE_ATIVO: z.literal('true'),
  ASSISTENTE_USUARIOS_PILOTO: z.string().transform(v => v.split(',').map(id => id.trim()))
    .pipe(z.array(z.string().uuid()).min(1)),
  ASSISTENTE_PORTA: z.coerce.number().int().min(1).max(65535).default(3101),
  DATABASE_URL: z.string().min(1), OPENAI_API_KEY: z.string().min(1),
  NOTO_AMBIENTE_OPERACAO: z.literal('homologacao'),
  ENVIO_MEDICO_REAL_ATIVO: z.literal('true'),
  ENVIO_REAL_ALLOWLIST: z.string().trim().min(1),
  ASSISTENTE_MODELO: z.string().min(1),
  EVOLUTION_ASSISTANT_URL: z.string().url(), EVOLUTION_ASSISTANT_API_KEY: z.string().min(1),
  EVOLUTION_ASSISTANT_INSTANCE_NAME: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  EVOLUTION_ASSISTANT_WEBHOOK_SECRET: z.string().min(24)
});
const validado = ambiente.safeParse(process.env);
if (!validado.success) {
  console.error('[Assistente] Configuração ausente ou inválida:', validado.error.issues.map(i => i.path.join('.')));
  process.exit(1);
}
const env = validado.data;
const config = carregarConfig();
if (config.evolutionAssistantInstanceName === config.evolutionOfficialInstanceName) {
  console.error('[Assistente] INSTANCIA_ASSISTENTE_NAO_PODE_SER_OFICIAL');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 6, connectionTimeoutMillis: 5000,
  statement_timeout: 15000 });
pool.on('error', () => console.error('[Assistente] CONEXAO_BANCO_INTERROMPIDA'));
const repositorio = new PostgresAssistente(pool, env.ASSISTENTE_USUARIOS_PILOTO);
const deps: DependenciasWorkerAssistente = {
  repositorio,
  modelo: criarModeloAssistente(config, env.ASSISTENTE_MODELO),
  consultarPreparacao: async medicoId => {
    const status = await consultarStatusOnboarding(pool, medicoId, process.env.PREPARACAO_FISCAL_ATIVA === 'true');
    // O modelo recebe somente os indicadores necessários, sem XML, CPF ou credenciais.
    return { medicoId, passos: status.passos, dadosProfissionaisCompletos: status.dadosProfissionaisCompletos,
      liberadoParaEmitir: status.liberadoParaEmitir, consultadoEm: new Date().toISOString(), fonte: 'consultarStatusOnboarding' };
  },
  enviar: criarEnvioAssistente(config),
  registrarFalha: (id, tipo) => console.warn('[Assistente] TRABALHO_NAO_CONCLUIDO', { id, tipo })
};
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.get('/health', async (_req, res) => {
  try { await pool.query('select usuario_id from assistente_memorias limit 0'); res.json({ status: 'ok' }); }
  catch { res.status(503).json({ status: 'indisponivel' }); }
});
app.post('/webhooks/assistente', async (req, res) => {
  try {
    const resultado = await receberMensagemAssistente(req.body, req.header('x-webhook-secret'), {
      segredo: env.EVOLUTION_ASSISTANT_WEBHOOK_SECRET, instancia: env.EVOLUTION_ASSISTANT_INSTANCE_NAME,
      registrar: entrada => repositorio.registrar(entrada)
    });
    res.sendStatus(resultado.status);
  } catch { res.sendStatus(503); }
});
app.use((_erro: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.sendStatus(400);
});

// Uma passagem independente por tipo mantém a conversa disponível durante consultas.
const emExecucao = new Map<TipoTrabalho, Promise<unknown>>();
let encerrando = false;
function disparar(tipo: TipoTrabalho) {
  if (encerrando || emExecucao.has(tipo)) return;
  const passagem = executarPassoAssistente(tipo, deps)
    .catch(() => console.warn('[Assistente] FILA_INDISPONIVEL', { tipo }))
    .finally(() => emExecucao.delete(tipo));
  emExecucao.set(tipo, passagem);
}
await pool.query(`select m.usuario_id,t.token,h.chave from assistente_memorias m
  left join assistente_trabalhos t on false left join assistente_mensagens h on false limit 0`);
const server = app.listen(env.ASSISTENTE_PORTA, process.env.ASSISTENTE_HOST || '127.0.0.1', () => {
  console.info('[Assistente] Serviço iniciado em modo piloto de conversa e consulta.');
});
const timer = setInterval(() => {
  for (const tipo of ['conversa', 'preparacao', 'envio'] as const) disparar(tipo);
}, 1000);
async function encerrar() {
  if (encerrando) return;
  encerrando = true;
  clearInterval(timer);
  await new Promise<void>(resolve => server.close(() => resolve()));
  await Promise.allSettled([...emExecucao.values()]);
  await pool.end();
}
process.once('SIGTERM', () => { void encerrar(); });
process.once('SIGINT', () => { void encerrar(); });
