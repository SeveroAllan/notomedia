import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import express from 'express';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import {expect,it,vi} from 'vitest';
import {LinksCofre} from '../src/cofre/links.js';
import {criarRouterLinksCofre} from '../src/cofre/links-router.js';
import {notificarPesquisaRegistro,aprovarRegistroProfissional} from '../src/agente/pesquisa-profissional-conversa.js';

const testar=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']?it:it.skip;
const CONTA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUTRA='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ANA='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOME='Dra. Ana Souza';
const TEL='5551999998888';
const dados=(razao='LIMITE_TENTATIVAS',estado='manual_pendente')=>
  ({[ANA]:{nome:NOME,estado,razao,tentativas:4}});

testar('cofre descartável: link 1x, formulário CRM/RQE, callback e revisão sem nova mensagem',async()=>{
  const url=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']!;
  if(!/127\.0\.0\.1|localhost/.test(url))throw Error('TESTE_EXIGE_BANCO_DESCARTAVEL');
  const name='noto_manual_'+randomUUID().replace(/-/g,'').slice(0,16);
  const admin=new pg.Client({connectionString:url});await admin.connect();
  const temp=new URL(url);temp.pathname='/'+name;
  let pool:pg.Pool|undefined,server:Server|undefined;
  try{
    await admin.query('create database '+name);
    pool=new pg.Pool({connectionString:temp.toString(),max:4});
    await pool.query([
      'create table public.contas (id uuid primary key);',
      'create table public.medicos (id uuid primary key, conta_id uuid not null references public.contas(id), nome_completo text not null, crm text, rqe text, atualizado_em timestamptz);',
      "create table public.noto_agent_conversas (conta_id uuid primary key references public.contas(id), estado jsonb not null default '{}'::jsonb, atualizado_em timestamptz not null default now());",
      'create table public.usuarios (id uuid primary key,conta_id uuid,auth_user_id uuid,telefone text,ativo boolean);',
      "create table public.cofre_links (id uuid primary key default gen_random_uuid(), medico_id uuid references public.medicos(id),agenda text not null, token_hash text unique not null, expira_em timestamptz not null, usado_em timestamptz, criado_em timestamptz default now(), destino_telefone text);",
      "create table public.cofre_links_auditoria (link_id uuid references public.cofre_links(id),evento text check(evento in ('criado','aberto','enviado','expirado','concluido')),primary key(link_id,evento));",
      'create table public.cofre_links_entregas (link_id uuid primary key references public.cofre_links(id),instancia text,mensagem_id text,destino_hash text,estado text,aceito_em timestamptz default now());',
      "insert into public.contas(id) values('"+CONTA+"'),('"+OUTRA+"');",
      "insert into public.medicos(id,conta_id,nome_completo) values('"+ANA+"','"+CONTA+"','"+NOME+"');",
      "insert into public.usuarios(id,conta_id,auth_user_id,telefone,ativo) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','"+CONTA+"','ffffffff-ffff-4fff-8fff-ffffffffffff','"+TEL+"',true);"
    ].join('\n'));
    const definirEstado=async(obj:object)=>{
      await pool!.query([
        "insert into public.noto_agent_conversas(conta_id,estado) values($1,jsonb_build_object('pesquisasRegistro',$2::jsonb,'profissionalConfirmadoId',$3::text))",
        "on conflict(conta_id) do update set estado=excluded.estado"
      ].join('\n'),[CONTA,JSON.stringify(obj),ANA]);
    };
    await definirEstado(dados());
    server=createServer();
    await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
    const origem=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let urlEnviada='';
    const envioLink=vi.fn(async({url}: {url:string})=>{urlEnviada=url;return 'enviado' as const;});
    const links=new LinksCofre({
      pool,origem,
      cofre:{status:async()=>({estado:'vazio'}),iniciar:async()=>null},
      enviar:async()=> 'enviado',
      enviarUrlComRecibo:envioLink
    });
    const router=criarRouterLinksCofre(links,origem,undefined,true);
    const app=express();app.use('/c',router);
    server.on('request',app);
    const negar=await links.solicitarLinkRegistro(OUTRA,ANA,TEL);
    expect(negar.ok).toBe(false);
    expect(envioLink).not.toHaveBeenCalled();

    const primeiro=await links.solicitarLinkRegistro(CONTA,ANA,TEL);
    expect(primeiro).toMatchObject({ok:true,motivo:'ACEITO_API'});
    expect(urlEnviada).toMatch(/\/c\/registro\/[A-Za-z0-9_-]{43}$/);
    const token=urlEnviada.split('/').at(-1)!;
    const gravados=await pool.query('select agenda,token_hash,usado_em from public.cofre_links');
    expect(gravados.rows).toHaveLength(1);
    expect(gravados.rows[0].agenda).toBe('registro_profissional');
    expect(gravados.rows[0].token_hash).not.toBe(token);
    expect(gravados.rows[0].usado_em).toBeNull();

    // Evento duplicado, ou simples clique no link, não é preenchimento.
    expect((await links.solicitarLinkRegistro(CONTA,ANA,TEL)).motivo).toBe('ACEITO_SEM_ENTREGA');
    expect(envioLink).toHaveBeenCalledTimes(1);
    let r=await fetch(urlEnviada);
    expect(r.status).toBe(200);
    const pagina=await r.text();
    expect(pagina).toMatch(/RQE \(se houver\)/);
    expect(pagina).toContain('Nada será salvo no cadastro');
    expect(pagina).not.toContain(token);
    expect((await pool.query('select crm,rqe from medicos where id=$1',[ANA])).rows[0]).toEqual({
      crm:null,rqe:null
    });

    // Origin malicioso ou dados inválidos não gastam o token.
    r=await fetch(urlEnviada+'/enviar',{method:'POST',headers:{
      Origin:'https://evil.example.test','Content-Type':'application/x-www-form-urlencoded'
    },body:'crm=9999%2FRS&rqe='});
    expect(r.status).toBe(403);
    r=await fetch(urlEnviada+'/enviar',{method:'POST',headers:{
      Origin:origem,'Content-Type':'application/x-www-form-urlencoded'
    },body:'crm=12345%2FXX&rqe='});
    expect(r.status).toBe(400);
    expect(await links.validarLinkRegistro(token)).toMatchObject({nome:NOME});

    // Conclusão do formulário -> proposta persistida e aviso automático.
    r=await fetch(urlEnviada+'/enviar',{method:'POST',headers:{
      Origin:origem,'Content-Type':'application/x-www-form-urlencoded'
    },body:'crm=12345%2FRS&rqe='});
    expect(r.status).toBe(202);
    expect(await r.text()).toContain('não precisa enviar outra mensagem');
    expect(await links.validarLinkRegistro(token)).toBeNull();
    const replay=await fetch(urlEnviada+'/enviar',{method:'POST',headers:{
      Origin:origem,'Content-Type':'application/x-www-form-urlencoded'
    },body:'crm=9999%2FRS&rqe=777'});
    expect(replay.status).toBe(410);

    const envioWhats=vi.fn().mockResolvedValue(true);
    expect(await notificarPesquisaRegistro(pool,TEL,envioWhats)).toBe(true);
    expect(envioWhats).toHaveBeenCalledOnce();
    expect(envioWhats.mock.calls[0]![1]).toContain('Recebi pelo cofre o CRM 12345/RS');
    expect(envioWhats.mock.calls[0]![1]).toContain('Confirma esses números?');
    expect(await notificarPesquisaRegistro(pool,TEL,envioWhats)).toBe(false);
    const estado=(await pool.query('select estado from public.noto_agent_conversas where conta_id=$1',[CONTA])).rows[0].estado;
    expect(estado.pesquisasRegistro[ANA]).toMatchObject({
      estado:'aguardando_confirmacao',razao:'MANUAL_INFORMADO',
      proposta:{crm:'12345/RS',origem:'manual',}
    });
    expect((await pool.query('select crm,rqe from medicos where id=$1',[ANA])).rows[0]).toEqual({crm:null,rqe:null});
    expect((await aprovarRegistroProfissional(pool,OUTRA,ANA)).ok).toBe(false);
    const aprovado=await aprovarRegistroProfissional(pool,CONTA,ANA);
    expect(aprovado).toMatchObject({ok:true,crm:'12345/RS',rqe:null});
    expect((await aprovarRegistroProfissional(pool,CONTA,ANA)).ok).toBe(false);

    // Correção de candidato confirmado: nova página, proposta nova, novo consentimento.
    await definirEstado({[ANA]:{nome:NOME,estado:'aguardando_confirmacao',
      razao:'ENCONTRADO',tentativas:1,
      candidatos:[{crm:'12345/RS',uf:'RS',rqes:[],origem:'OpenSerp'}]}});
    const segundo=await links.solicitarLinkRegistro(CONTA,ANA,TEL);
    expect(segundo.ok).toBe(true);
    expect(envioLink).toHaveBeenCalledTimes(2);
    const urlNovo=urlEnviada;
    r=await fetch(urlNovo+'/enviar',{method:'POST',headers:{
      Origin:origem,'Content-Type':'application/x-www-form-urlencoded'
    },body:'crm=66666%2FRS&rqe=777'});
    expect(r.status).toBe(202);
    expect(await notificarPesquisaRegistro(pool,TEL,envioWhats)).toBe(true);
    expect(envioWhats.mock.calls.at(-1)![1]).toContain('CRM 66666/RS');
    expect(envioWhats.mock.calls.at(-1)![1]).toContain('RQE 777');
    expect((await pool.query('select crm,rqe from medicos where id=$1',[ANA])).rows[0])
      .toEqual({crm:'12345/RS',rqe:null});
    expect(await aprovarRegistroProfissional(pool,CONTA,ANA)).toMatchObject({
      ok:true,crm:'66666/RS',rqe:'777'
    });
  }finally{
    if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
    await pool?.end().catch(()=>undefined);
    await admin.query('drop database if exists '+name).catch(()=>undefined);
    await admin.end();
  }
});
