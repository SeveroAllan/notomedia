/**
 * Webhook das instâncias pareadas pelo usuário. Não processa mensagens de pacientes,
 * não chama IA, não armazena conversas e não envia respostas.
 *
 * A instância do Noto Assistente utiliza outro webhook (agente/webhook.ts).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type pg from 'pg';

function segredoConfere(recebido: string | undefined, esperado: string): boolean {
  if (!recebido || !esperado) return false;
  const a = createHash('sha256').update(recebido).digest();
  const b = createHash('sha256').update(esperado).digest();
  return timingSafeEqual(a, b);
}

export function criarRouterWebhookPareamento(deps: {
  pool: Pick<pg.Pool, 'query'>;
  segredo: string;
  /** Consulta o estado REAL na Evolution, não confia no evento isoladamente. */
  confirmarConexao?: (instancia: string) => Promise<boolean>;
  aoConectar?: (instancia: string) => Promise<void>;
}) {
  const router = Router();
  router.post('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!segredoConfere(req.header('x-webhook-secret'), deps.segredo)) {
      res.sendStatus(401);
      return;
    }

    // Eventos de mensagens/contatos são reconhecidos, mas não processados.
    if (String(req.body?.event ?? '').toLowerCase().replace(/_/g, '.') !== 'connection.update') {
      res.sendStatus(204);
      return;
    }
    const instancia = req.body?.instance;
    const estado = req.body?.data?.state ?? req.body?.data?.instance?.state;
    if (typeof instancia !== 'string' || !instancia || (estado !== 'open' && estado !== 'close')) {
      res.sendStatus(204);
      return;
    }
    try {
      // Um evento "open" sozinho NÃO prova que a instância está conectada.
      // Sem verificação ativa da Evolution, não marca conexão nem envia saudação.
      if (estado === 'open' && (!deps.confirmarConexao || !await deps.confirmarConexao(instancia))) {
        res.sendStatus(204);
        return;
      }
      const atualizacao = await deps.pool.query(
        `update whatsapp_instancias
         set status = $2,
             conectado_em = case when $2 = 'conectado' then coalesce(conectado_em, now()) else conectado_em end
         where nome_instancia = $1`,
        [instancia, estado === 'open' ? 'conectado' : 'desconectado']
      );
      if (estado === 'open' && atualizacao.rowCount && deps.aoConectar) {
        // Idempotência persistente é responsabilidade do serviço de boas-vindas.
        await deps.aoConectar(instancia);
      }
      res.sendStatus(204);
    } catch {
      // Permite nova entrega após falha transitória; nunca registra dados de conversas.
      res.sendStatus(503);
    }
  });
  return router;
}
