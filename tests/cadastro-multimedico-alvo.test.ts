import express from 'express';
import type pg from 'pg';
import type {AddressInfo} from 'node:net';
import {afterEach,expect,it,vi} from 'vitest';
import {criarRouterCadastroPainel} from '../src/cadastro/router-painel.js';
import {PostgresCadastro} from '../src/cadastro/postgres-cadastro.js';

const servidores:Array<ReturnType<ReturnType<typeof express>['listen']>>=[];
afterEach(async()=>{await Promise.all(servidores.splice(0).map(s=>new Promise<void>(resolve=>s.close(()=>resolve()))));});

it('revisão profissional pode apontar para outro médico da mesma conta, sem depender de usuario_id direto',async()=>{
 const alvo='11111111-1111-4111-8111-111111111111';
 const query=vi.fn(async(sql:string,p:unknown[]=[])=>{
   expect(sql).toContain('m.conta_id=u.conta_id');
   expect(p).toEqual(['auth-user',alvo]);
   return {rows:[{id:alvo}]};
 });
 const revisaoPainel=vi.fn(async(id:string)=>({alvo:id,aprovado:false}));
 const app=express();
 app.use('/api/conta/cadastro',criarRouterCadastroPainel({
   pool:{query} as unknown as pg.Pool,
   repo:{revisaoPainel} as unknown as PostgresCadastro,
   autenticar:async()=> 'auth-user'
 }));
 const server=app.listen(0);servidores.push(server);await new Promise<void>(resolve=>server.once('listening',()=>resolve()));
 const porta=(server.address() as AddressInfo).port;
 const res=await fetch(`http://127.0.0.1:${porta}/api/conta/cadastro?medicoId=${alvo}`,{headers:{Authorization:'Bearer token'}});
 expect(res.status).toBe(200);
 expect(await res.json()).toEqual({ok:true,revisao:{alvo,aprovado:false}});
 expect(revisaoPainel).toHaveBeenCalledExactlyOnceWith(alvo);
});

it('alvo inválido é recusado antes de consultar cadastro',async()=>{
 const query=vi.fn();
 const revisaoPainel=vi.fn();
 const app=express();
 app.use('/api/conta/cadastro',criarRouterCadastroPainel({
   pool:{query} as unknown as pg.Pool,
   repo:{revisaoPainel} as unknown as PostgresCadastro,
   autenticar:async()=> 'auth-user'
 }));
 const server=app.listen(0);servidores.push(server);await new Promise<void>(resolve=>server.once('listening',()=>resolve()));
 const porta=(server.address() as AddressInfo).port;
 const res=await fetch(`http://127.0.0.1:${porta}/api/conta/cadastro?medicoId=nao-e-uuid`,{headers:{Authorization:'Bearer token'}});
 expect(res.status).toBe(400);
 expect(query).not.toHaveBeenCalled();
 expect(revisaoPainel).not.toHaveBeenCalled();
});

it('PostgresCadastro revisa médico sem usuario_id próprio; conta ativa continua sendo a autoridade',async()=>{
 const query=vi.fn(async(sql:string)=>{
   expect(sql).not.toContain('join usuarios u on u.id=m.usuario_id');
   return {rows:[{nome:'Bruno Souza',crm:null,rqe:null,trabalho:null,versao:null,whatsapp_conectado:false}]};
 });
 const repo=new PostgresCadastro({query} as unknown as pg.Pool);
 const r=await repo.revisaoPainel('11111111-1111-4111-8111-111111111111');
 expect(r).toMatchObject({nome:'Bruno Souza',aprovado:false});
});
