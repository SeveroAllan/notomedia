import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {expect,it} from 'vitest';
import {lerEstadoConversa,salvarEstadoConversa} from '../src/agente/estado-conversa.js';
import {decidirVinculo} from '../src/agente/confirmacao-contextual.js';

const testar=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']?it:it.skip;
testar('resposta após 3 dias e novo processo mantém descoberta confirmável sem prazo humano',async()=>{
  const url=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']!;
  if(!/127\.0\.0\.1|localhost/.test(url))throw Error('BANCO_DESCARTAVEL_EXIGIDO');
  const nome='noto_prazo_confirmacao_'+randomUUID().replace(/-/g,'').slice(0,12);
  const admin=new pg.Client({connectionString:url});
  await admin.connect();
  const temp=new URL(url);temp.pathname='/'+nome;
  let pool:pg.Pool|undefined;
  try{
    await admin.query('create database '+nome);
    pool=new pg.Pool({connectionString:temp.toString()});
    await pool.query([
      'create table noto_agent_conversas(conta_id uuid primary key,',
      "estado jsonb not null,atualizado_em timestamptz default now());"
    ].join('\n'));
    const conta='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const descoberta={agenda:'tribemd',nomes:['Dra. Ana Souza']};
    await pool.query([
      'insert into noto_agent_conversas(conta_id,estado,atualizado_em)',
      "values($1,jsonb_build_object('faseAgenda','CONFIRMACAO_PENDENTE',",
      "'descoberta',$2::jsonb,'perguntaPendente','confirmar_profissional'),",
      "now()-interval '3 days')"
    ].join('\n'),[conta,JSON.stringify(descoberta)]);
    const estado=await lerEstadoConversa(pool,conta);
    expect(decidirVinculo(estado,{
      agenda:'tribemd',decisao:'confirmar',nomes:[],mensagem:'Sim, sou eu!'
    })).toEqual({ok:true,agenda:'tribemd',nomes:['Dra. Ana Souza']});
    // A confirmação permanece pendente mesmo após reiniciar.
    await salvarEstadoConversa(pool,conta,{...estado,perguntaPendente:'confirmar_profissional'});
    const reiniciado=new pg.Pool({connectionString:temp.toString()});
    try{
      const reaberto=await lerEstadoConversa(reiniciado,conta);
      expect(reaberto.faseAgenda).toBe('CONFIRMACAO_PENDENTE');
      expect(decidirVinculo(reaberto,{
        agenda:'tribemd',decisao:'confirmar',nomes:[],mensagem:'Sim, sou eu!'
      }).ok).toBe(true);
    }finally{await reiniciado.end();}
  }finally{
    await pool?.end().catch(()=>undefined);
    await admin.query('drop database if exists '+nome).catch(()=>undefined);
    await admin.end();
  }
});
