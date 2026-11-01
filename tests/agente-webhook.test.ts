import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
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
  const modeloTeste = new ScriptedModel([
    [functionCall('consultar_status_agendas', { profissional: 'Alice' }, { callId: 'c1' })],
    [assistantMessage('A agenda TribeMD da Alice está conectada.')]
  ]);
  const enviar = vi.fn().mockResolvedValue(true);
  const consultarStatus = vi.fn().mockResolvedValue({
    tribemd: { salvo: true, conectada: true }, amplimed: { salvo: false, conectada: false }
  });
  const deps = {
    pool: { query } as unknown as pg.Pool,
    ativo: true, envioAtivo: true, segredo: 'segredo-de-teste',
    instancia: 'notomed_assistente', allowlist: ['51999998888'],
    modeloTeste, consultarStatus, enviar,
    ...overrides
  };
  const app = express();
  app.use(express.json());
  app.use('/webhook/evolution', criarRouterWebhookAgente(deps));
  return { app, query, modeloTeste, enviar, consultarStatus };
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

describe('Noto SDK — webhook autenticado e isolado', () => {
  it('rejeita segredo inválido antes de consultar banco ou modelo', async () => {
    const { app, query, modeloTeste, enviar } = preparar();
    await comServidor(app, async postar => expect((await postar(evento, 'errado')).status).toBe(401));
    expect(query).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
    expect(modeloTeste.calls).toHaveLength(0);
  });

  it('executa o loop com tool real apenas na conta autorizada e deduplica evento', async () => {
    const { app, query, modeloTeste, enviar, consultarStatus } = preparar();
    await comServidor(app, async postar => {
      expect((await postar(evento)).status).toBe(200);
      expect((await postar(evento)).status).toBe(200);
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(consultarStatus).toHaveBeenCalledExactlyOnceWith('alice-id');
    expect(enviar).toHaveBeenCalledTimes(1);
    modeloTeste.assertComplete();
  });

  it('ignora mensagens próprias, grupos, instâncias alheias e números não autorizados', async () => {
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

  it('não seleciona contas ambíguas', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ conta_id: 'a' }, { conta_id: 'b' }] });
    const { app, enviar } = preparar({ pool: { query } as unknown as pg.Pool });
    await comServidor(app, async postar => expect((await postar(evento)).status).toBe(204));
    expect(query).toHaveBeenCalledTimes(1);
    expect(enviar).not.toHaveBeenCalled();
  });

  it('mantém o envio desligado quando a flag está desativada', async () => {
    const { app, query, enviar } = preparar({ envioAtivo: false });
    await comServidor(app, async postar => expect((await postar(evento)).status).toBe(204));
    expect(query).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
  });

  it('sem cadastro, permite a orientação geral, não acessa cofres', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const modeloTeste = new ScriptedModel([
      [functionCall('consultar_contexto_conta', {}, { callId: 'c1' })],
      [assistantMessage('Sou o Noto! Qual agenda você usa: TribeMD, Amplimed ou outra?')]
    ]);
    const consultarStatus = vi.fn();
    const { app, enviar } = preparar({
      pool: { query } as unknown as pg.Pool, modeloTeste, consultarStatus, painelUrl: 'https://noto.exemplo.com/'
    });
    await comServidor(app, async postar => expect((await postar(evento)).status).toBe(200));
    expect(query).toHaveBeenCalledTimes(1);
    expect(consultarStatus).not.toHaveBeenCalled();
    expect(enviar).toHaveBeenCalledWith('5551999998888', expect.stringContaining('Qual agenda'));
    modeloTeste.assertComplete();
  });

  it('preserva contexto de resposta curta na mesma conta sem armazenar mensagens do usuário', async () => {
    const modeloTeste = new ScriptedModel([
      [assistantMessage('Você utiliza TribeMD, Amplimed ou outra?')],
      [assistantMessage('Perfeito, Amplimed. Vamos identificar o profissional antes de conectar.')]
    ]);
    const { app, enviar } = preparar({ modeloTeste });
    await comServidor(app, async postar => {
      expect((await postar(evento)).status).toBe(200);
      expect((await postar({
        ...evento, data: { ...evento.data, key: { ...evento.data.key, id: 'mensagem-2' }, message: { conversation: 'Amplimed' } }
      })).status).toBe(200);
    });
    expect(modeloTeste.calls).toHaveLength(2);
    expect(JSON.stringify(modeloTeste.calls[1]?.request.input)).toContain('Você utiliza TribeMD');
    expect(enviar).toHaveBeenCalledTimes(2);
    modeloTeste.assertComplete();
  });
});
