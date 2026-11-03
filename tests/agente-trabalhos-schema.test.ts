import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {enfileirarTrabalhoNoto,reservarTrabalhoNoto,concluirLeituraNoto,reservarNotificacaoNoto,terminarNotificacaoNoto} from '../src/agente/trabalhos-duraveis.js';

const executarBanco=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']?it:it.skip;
const sql=readFileSync(new URL('../scripts/migrations/20261108-noto-trabalhos-duraveis.sql',import.meta.url),'utf8');
executarBanco('fila de agente: migração reaplicável no PostgreSQL isolado, escopo real e status de aceite API',async()=>{
  const url=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']!;
  if(!/127\.0\.0\.1|localhost/.test(url))throw Error('TESTE_EXIGE_BANCO_LOCAL_DESCARTAVEL');
  const dbName='noto_fila_'+randomUUID().replace(/-/g,'').slice(0,18);
  const admin=new pg.Client({connectionString:url});
  await admin.connect();
  const isolada=new URL(url);isolada.pathname='/'+dbName;
  let client:pg.Client|undefined;
  try{
    await admin.query('create database '+dbName);
    client=new pg.Client({connectionString:isolada.toString()});
    await client.connect();
    await client.query([
      'create table public.contas (id uuid primary key)',
      'create table public.medicos (id uuid primary key, conta_id uuid not null references public.contas(id))',
      'create table public.usuarios (id uuid primary key,conta_id uuid references public.contas(id),',
      'auth_user_id uuid,ativo boolean not null,telefone text)',
      "insert into public.contas(id) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),",
      "('dddddddd-dddd-4ddd-8ddd-dddddddddddd')",
      "insert into public.medicos(id,conta_id) values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',",
      "'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),",
      "('cccccccc-cccc-4ccc-8ccc-cccccccccccc','dddddddd-dddd-4ddd-8ddd-dddddddddddd')",
      "insert into public.usuarios (id,conta_id,auth_user_id,ativo,telefone) values",
      "('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',",
      "'99999999-9999-4999-8999-999999999999',true,'5551999998888')"
    ].join(' ;\n'));
    await client.query(sql);
    await client.query(sql);
    const props=await client.query([
      "select relrowsecurity from pg_class where oid='public.noto_agent_trabalhos'::regclass"
    ].join(''));
    expect(props.rows[0].relrowsecurity).toBe(true);
    const grants=await client.query([
      "select count(*)::int as n from information_schema.role_table_grants",
      "where table_schema='public' and table_name='noto_agent_trabalhos'",
      "and grantee in ('anon','authenticated') and privilege_type in ('SELECT','INSERT','UPDATE','DELETE')"
    ].join('\n'));
    expect(grants.rows[0].n).toBe(0);
    const pedido={
      contaId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',instancia:'assistente',
      telefone:'5551999998888',mensagemId:'msg-0000001',
      tipo:'conferencia_fiscal' as const,agenda:'tribemd' as const,
      medicoId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    };
    expect(await enfileirarTrabalhoNoto(client as unknown as pg.Pool,pedido))
      .toEqual({ok:true,estado:'iniciado'});
    expect(await enfileirarTrabalhoNoto(client as unknown as pg.Pool,{...pedido,mensagemId:'msg-0000002'}))
      .toEqual({ok:true,estado:'ja_em_andamento'});
    expect(await enfileirarTrabalhoNoto(client as unknown as pg.Pool,
      {...pedido,mensagemId:'msg-0000003',medicoId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}))
      .toEqual({ok:false,motivo:'SEM_AUTORIZACAO'});
    const job=await reservarTrabalhoNoto(client as unknown as pg.Pool,'ci-executor');
    expect(job).toMatchObject({contaId:pedido.contaId,medicoId:pedido.medicoId,estado:'executando'});
    expect(await concluirLeituraNoto(client as unknown as pg.Pool,job!.id,'ci-executor',
      {ok:false,motivo:'LEITURA_INCOMPLETA'})).toBe(true);
    const notify=await reservarNotificacaoNoto(client as unknown as pg.Pool);
    expect(notify).toMatchObject({id:job!.id,estado:'notificando'});
    await terminarNotificacaoNoto(client as unknown as pg.Pool,job!.id,true);
    const stored=await client.query('select estado from public.noto_agent_trabalhos where id=$1',[job!.id]);
    expect(stored.rows[0].estado).toBe('aceito_api');
    // Incompatibilidade real não fica camuflada pelo CREATE IF NOT EXISTS.
    await client.query('alter table public.noto_agent_trabalhos alter column tentativas type integer');
    await expect(client.query(sql)).rejects.toThrow(/NOTO_TRABALHOS_COLUNA_INCOMPATIVEL/);
  }finally{
    await client?.end().catch(()=>{});
    await admin.query('drop database if exists '+dbName).catch(()=>{});
    await admin.end();
  }
});
