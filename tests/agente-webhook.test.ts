import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { criarRouterWebhookAgente } from '../src/agente/webhook.js';

const evento = {
  instance: 'notomed_assistente',
  event: 'messages.upsert',
  data: {
    key: { id: 'mensagem-1', remoteJid: '5551999998888@s.whatsapp.net', fromMe: false },
    message: { conversation: 'Noto, verifica a agenda da Alice' }
  }
};

function preparar(overrides: Record<string, unknown> = {}) {
  const query = vi.fn(async (sql: string, parametros: unknown[]) => {
    if (sql.includes('distinct conta_id')) return { rows: [{ conta_id: 'conta-a' }] };
    if (sql.includes('from medicos')) {
      expect(parametros).toEqual(['conta-a']);
      return { rows: [{ id: 'alice-id', nome_completo: 'Alice Souza' }] };
    }
    throw new Error('SQL não previsto');
  });
  const completar = vi.fn()
    .mockResolvedValueOnce(JSON.stringify({ acao: 'consultar_agendas', profissional: 'Alice' }))
    .mockResolvedValueOnce('A agenda TribeMD está conectada.');
  const enviar = vi.fn().mockResolvedValue(true);
  const consultarStatus = vi.fn().mockResolvedValue({
    tribemd: { salvo: true, conectada: true },
    amplimed: { salvo: false, conectada: false }
  });
  const deps = {
    pool: { query } as unknown as pg.Pool,
    ativo: true, envioAtivo: true, segredo: 'segredo-de-teste',
    instancia: 'notomed_assistente', allowlist: ['51999998888'],
    completar, consultarStatus, enviar,
    ...overrides
  };
  const app = express();
  app.use(express.json());
  app.use('/webhook/evolution', criarRouterWebhookAgente(deps));
  return { app, query, completar, enviar, consultarStatus };
}

async function comServidor(
  app: ReturnType<typeof express>,
  fn: (postar: (body: unknown, segredo?: string) => Promise<Response>) => Promise<void>
) {
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const endereco = server.address() as AddressInfo;
  const postar = (body: unknown, segredo = 'segredo-de-teste') => fetch(
    'http://127.0.0.1:' + endereco.port + '/webhook/evolution',
    { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': segredo }, body: JSON.stringify(body) }
  );
  try { await fn(postar); }
  finally { await new Promise<void>((r, j) => server.close(e => e ? j(e) : r())); }
}

describe('Webhook do agente — identidade e segurança', () => {
  it('rejeita segredo inválido sem consultar o banco', async () => {
    const { app, query, enviar } = preparar();
    await comServidor(app, async postar => {
      const resposta = await postar(evento, 'errado');
      expect(resposta.status).toBe(401);
    });
    expect(query).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
  });

  it('consulta somente a conta autenticada pelo número e não reenvia o mesmo evento', async () => {
    const { app, query, enviar, consultarStatus } = preparar();
    await comServidor(app, async postar => {
      expect((await postar(evento)).status).toBe(200);
      expect((await postar(evento)).status).toBe(200);
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(consultarStatus).toHaveBeenCalledWith('alice-id');
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it('ignora mensagens próprias, grupos, outras instâncias e números fora da allowlist', async () => {
    const { app, query, enviar } = preparar();
    await comServidor(app, async postar => {
      for (const body of [
        { ...evento, data: { ...evento.data, key: { ...evento.data.key, fromMe: true } } },
        { ...evento, data: { ...evento.data, key: { ...evento.data.key, remoteJid: '123456@g.us' } } },
        { ...evento, instance: 'notomed_oficial' },
        { ...evento, data: { ...evento.data, key: { ...evento.data.key, remoteJid: '5511999990000@s.whatsapp.net' } } }
      ]) expect((await postar(body)).status).toBe(204);
    });
    expect(query).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
  });

  it('não escolhe arbitrariamente uma das duas contas associadas ao mesmo telefone', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ conta_id: 'a' }, { conta_id: 'b' }] });
    const { app, enviar } = preparar({ pool: { query } as unknown as pg.Pool });
    await comServidor(app, async postar => {
      expect((await postar(evento)).status).toBe(204);
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(enviar).not.toHaveBeenCalled();
  });

  it('mantém envio desabilitado mesmo com uma mensagem válida', async () => {
    const { app, query } = preparar({ envioAtivo: false });
    await comServidor(app, async postar => {
      expect((await postar(evento)).status).toBe(204);
    });
    expect(query).not.toHaveBeenCalled();
  });
  it('orienta um número de teste sem cadastro a começar pelo painel, sem acesso fiscal', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const completar = vi.fn().mockResolvedValue(JSON.stringify({ agenda: null }));
    const { app, enviar } = preparar({
      pool: { query } as unknown as pg.Pool, completar, painelUrl: 'https://noto.exemplo.com/'
    });
    await comServidor(app, async postar => {
      expect((await postar(evento)).status).toBe(200);
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(completar).toHaveBeenCalledTimes(1);
    expect(enviar).toHaveBeenCalledWith('5551999998888', expect.stringContaining('qual agenda'));
  });

  it('preserva a última pergunta de maneira isolada ao longo da conversa de teste', async () => {
    const completar = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ acao: 'orientar', profissional: null }))
      .mockResolvedValueOnce('Olá! Sou o Noto. Para começar, você usa TribeMD ou Amplimed?')
      .mockResolvedValueOnce(JSON.stringify({ acao: 'conectar_agenda', agenda: 'amplimed', profissional: null }));
    const { app, enviar } = preparar({ completar, painelUrl: 'https://noto.exemplo.com/' });
    await comServidor(app, async postar => {
      expect((await postar(evento)).status).toBe(200);
      expect((await postar({
        ...evento, data: { ...evento.data, key: { ...evento.data.key, id: 'mensagem-2' }, message: { conversation: 'Amplimed' } }
      })).status).toBe(200);
    });
    expect(completar).toHaveBeenCalledTimes(3);
    const argumento = JSON.stringify(completar.mock.calls[2]?.[0]);
    expect(argumento).toContain('TribeMD ou Amplimed');
    expect(enviar).toHaveBeenCalledTimes(2);
    expect(enviar.mock.calls[1]?.[1]).toContain('Cofre');
  });

});
