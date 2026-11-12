import { expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import { criarRouterWebhookPareamento } from '../src/whatsapp/webhook-pareamento.js';

it('webhook de pareamento valida segredo, ignora mensagens e atualiza somente estado da instancia', async () => {
  const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
  const confirmarConexao = vi.fn().mockResolvedValue(true);
  const aoConectar = vi.fn().mockResolvedValue(undefined);
  const app = express();
  app.use(express.json());
  app.use('/webhook/evolution/pareamento', criarRouterWebhookPareamento({
    pool: { query } as unknown as pg.Pool, segredo: 'segredo-homologacao',
    confirmarConexao, aoConectar
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
    expect(confirmarConexao).toHaveBeenCalledExactlyOnceWith('medico_teste');
    expect(aoConectar).toHaveBeenCalledExactlyOnceWith('medico_teste');
    expect((await enviar({ instance: 'medico_teste', event: 'connection.update', data: { state: 'close' } })).status).toBe(204);
    expect(query).toHaveBeenCalledWith(expect.any(String), ['medico_teste', 'desconectado']);
    expect(aoConectar).toHaveBeenCalledTimes(1);
  } finally {
    await new Promise<void>((resolve, reject) => servidor.close(err => err ? reject(err) : resolve()));
  }
});

it('evento OPEN sem confirmacao da Evolution nao marca conectado nem chama boas-vindas', async () => {
  const query = vi.fn().mockResolvedValue({ rowCount: 0 });
  const aoConectar = vi.fn();
  const confirmarConexao = vi.fn().mockResolvedValue(false);
  const app = express();
  app.use(express.json());
  app.use('/webhook/evolution/pareamento', criarRouterWebhookPareamento({
    pool: { query } as unknown as pg.Pool, segredo: 'segredo-homologacao',
    confirmarConexao, aoConectar
  }));
  const servidor = await new Promise<Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const base = `http://127.0.0.1:${(servidor.address() as {port:number}).port}`;
    const postar = async (event: string, state: string) => fetch(base + '/webhook/evolution/pareamento', {
      method: 'POST', headers: {
        'Content-Type': 'application/json', 'x-webhook-secret': 'segredo-homologacao'
      }, body: JSON.stringify({ instance: 'medico_teste', event, data: { state } })
    });
    expect((await postar('CONNECTION_UPDATE', 'open')).status).toBe(204);
    expect(confirmarConexao).toHaveBeenCalledExactlyOnceWith('medico_teste');
    expect(query).not.toHaveBeenCalled();
    expect(aoConectar).not.toHaveBeenCalled();
    confirmarConexao.mockResolvedValue(true);
    expect((await postar('CONNECTION_UPDATE', 'open')).status).toBe(204);
    // Ainda nao ha confirmação de linha afetada no banco, por isso nenhum envio.
    expect(aoConectar).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>(resolve => servidor.close(() => resolve()));
  }
});


it('recebe mídia só da instância válida, sem encaminhar textos, grupos ou origem não autenticada',async()=>{
  const query=vi.fn(),aoReceberMidia=vi.fn().mockResolvedValue(undefined);
  const app=express();
  app.use(express.json());
  app.use('/webhook/evolution/pareamento',criarRouterWebhookPareamento({
    pool:{query} as unknown as pg.Pool,segredo:'segredo-teste',aoReceberMidia
  }));
  const servidor=await new Promise<Server>(resolve=>{
    const s=app.listen(0,'127.0.0.1',()=>resolve(s));
  });
  try{
    const url='http://127.0.0.1:'+(servidor.address() as {port:number}).port+'/webhook/evolution/pareamento';
    const postar=(body:unknown,segredo='segredo-teste')=>fetch(url,{method:'POST',
      headers:{'content-type':'application/json','x-webhook-secret':segredo},
      body:JSON.stringify(body)});
    const correto={instance:'medico_aaaaaaaaaaaa',event:'messages.upsert',data:{
      key:{id:'AAA_BBB111',remoteJid:'5551988887777@s.whatsapp.net',fromMe:false},
      message:{imageMessage:{mimetype:'image/jpeg'}}
    }};
    expect((await postar(correto,'incorreto')).status).toBe(401);
    expect(aoReceberMidia).not.toHaveBeenCalled();
    expect((await postar(correto)).status).toBe(204);
    expect(aoReceberMidia).toHaveBeenCalledExactlyOnceWith({
      instancia:'medico_aaaaaaaaaaaa',mensagemId:'AAA_BBB111',
      remetente:'5551988887777',mimetype:'image/jpeg'
    });
    expect((await postar({...correto,data:{...correto.data,
      key:{...correto.data.key,remoteJid:'123@g.us'}}})).status).toBe(204);
    expect((await postar({...correto,data:{...correto.data,
      key:{...correto.data.key,fromMe:true}}})).status).toBe(204);
    expect((await postar({...correto,data:{...correto.data,
      message:{conversation:'Uma mensagem normal'}}})).status).toBe(204);
    expect(aoReceberMidia).toHaveBeenCalledTimes(1);
    expect((await postar({...correto,data:{...correto.data,
      message:{documentWithCaptionMessage:{message:{documentMessage:{mimetype:'application/pdf'}}}}}})).status).toBe(204);
    expect(aoReceberMidia).toHaveBeenCalledTimes(2);
    expect(query).not.toHaveBeenCalled();
  }finally{
    await new Promise<void>(resolve=>servidor.close(()=>resolve()));
  }
});
