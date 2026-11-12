/**
 * Webhook das instâncias pareadas pelo usuário. Não processa mensagens de pacientes,
 * não interpreta conversas e não envia respostas para pacientes.\n * O processamento de mídias é opt-in, com autorização e serviço isolados.
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
  aoAtualizarCodigo?: (instancia: string, codigo: string) => void;
  aoConectar?: (instancia: string) => Promise<void>;
  aoReceberMidia?: (evento:{instancia:string;mensagemId:string;remetente:string;mimetype:string})=>Promise<void>;
}) {
  const router = Router();
  router.post('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!segredoConfere(req.header('x-webhook-secret'), deps.segredo)) {
      res.sendStatus(401);
      return;
    }

    const evento = String(req.body?.event ?? '').toLowerCase().replace(/_/g, '.');
    const instancia = req.body?.instance;
    if(evento==='messages.upsert'){
      if(!deps.aoReceberMidia){res.sendStatus(204);return;}
      const chave=req.body?.data?.key;
      const msg=req.body?.data?.message;
      const documento=msg?.imageMessage ?? msg?.documentMessage;
      const mime=documento?.mimetype;
      if(typeof instancia!=='string'||!/^medico_[a-f0-9]{12}$/i.test(instancia)||
        chave?.fromMe!==false||typeof chave.id!=='string'||
        !/^[A-Za-z0-9_-]{5,150}$/.test(chave.id)||
        typeof chave.remoteJid!=='string'||!/^[0-9]{10,13}@s\.whatsapp\.net$/.test(chave.remoteJid)||
        !['image/jpeg','image/png','application/pdf'].includes(mime)){
        res.sendStatus(204);return;
      }
      try{
        await deps.aoReceberMidia({
          instancia,mensagemId:chave.id,
          remetente:chave.remoteJid.slice(0,chave.remoteJid.indexOf('@')),mimetype:mime
        });
        res.sendStatus(204);
      }catch{
        // Sem payload, telefone ou conteúdo do arquivo no log.
        res.sendStatus(503);
      }
      return;
    }
    if (evento === 'qrcode.updated') {
      const qr = req.body?.data?.qrcode;
      if (typeof instancia === 'string' && /^medico_[a-f0-9]{12}$/i.test(instancia) &&
          qr?.instance === instancia && typeof qr.pairingCode === 'string' &&
          /^[A-Z0-9-]{8,12}$/i.test(qr.pairingCode)) {
        deps.aoAtualizarCodigo?.(instancia, qr.pairingCode);
      }
      res.sendStatus(204);
      return;
    }
    if (evento !== 'connection.update') {
      res.sendStatus(204);
      return;
    }
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
