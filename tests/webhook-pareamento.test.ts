import { expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import { criarRouterWebhookPareamento } from '../src/whatsapp/webhook-pareamento.js';

it('webhook de pareamento valida segredo, ignora mensagens e atualiza somente estado da instancia', async () => {
  const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
  const app = express();
  app.use(express.json());
  app.use('/webhook/evolution/pareamento', criarRouterWebhookPareamento({
    pool: { query } as unknown as pg.Pool, segredo: 'segredo-homologacao'
  }));
  const servidor = await new Promise<Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const base = `http://127.0.0.1:${(servidor.address() as {port:number}).port}`;
    const enviar = (body: unknown, segredo = 'segredo-homologacao') => fetch(
      base + '/webhook/evolution/pareamento', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': segredo },
        body: JSON.stringify(body)
      });
    expect((await enviar({ instance: 'medico_teste', event: 'connection.update', data: { state: 'open' } }, 'incorreto')).status).toBe(401);
    expect(query).not.toHaveBeenCalled();

    expect((await enviar({ instance: 'medico_teste', event: 'messages.upsert', data: {
      message: { conversation: 'informacao sensivel ficticia' }
    } })).status).toBe(204);
    expect(query).not.toHaveBeenCalled();

    expect((await enviar({ instance: 'medico_teste', event: 'connection.update', data: { state: 'open' } })).status).toBe(204);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('update whatsapp_instancias'), ['medico_teste', 'conectado']);
    expect((await enviar({ instance: 'medico_teste', event: 'connection.update', data: { state: 'close' } })).status).toBe(204);
    expect(query).toHaveBeenCalledWith(expect.any(String), ['medico_teste', 'desconectado']);
  } finally {
    await new Promise<void>((resolve, reject) => servidor.close(err => err ? reject(err) : resolve()));
  }
});
