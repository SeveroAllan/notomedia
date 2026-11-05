import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {it,expect} from 'vitest';
import {alterarObjetivoNoto,planejarObjetivos} from '../src/agente/objetivos.js';
import {lerEstadoConversa,salvarEstadoConversa} from '../src/agente/estado-conversa.js';
const testar=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']?it:it.skip;
const CONTA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUTRA='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ANA='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BRUNO='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TEL='5551999998888';

testar('memória de objetivos no PostgreSQL descartável: isolada, idempotente e durável após reinício',async()=>{
  const url=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']!;
  if(!/127\.0\.0\.1|localhost/.test(url))throw Error('TESTE_EXIGE_BANCO_LOCAL_DESCARTAVEL');
  const nome='noto_objetivo_'+randomUUID().replace(/-/g,'').slice(0,16);
  const admin=new pg.Client({connectionString:url});await admin.connect();
  const banco=new URL(url);banco.pathname='/'+nome;
  let pool:pg.Pool|undefined;
  try{
    await admin.query('create database '+nome);
    pool=new pg.Pool({connectionString:banco.toString(),max:4});
    await pool.query([
      'create table public.contas(id uuid primary key);',
      'create table public.medicos(id uuid primary key,conta_id uuid not null references public.contas(id),nome_completo text not null);',
      'create table public.usuarios(id uuid primary key,conta_id uuid not null,auth_user_id uuid,telefone text,ativo boolean);',
      "create table public.noto_agent_conversas(conta_id uuid primary key references public.contas(id),estado jsonb not null default '{}'::jsonb,atualizado_em timestamptz default now());",
      "insert into public.contas(id) values('"+CONTA+"'),('"+OUTRA+"');",
      "insert into public.medicos(id,conta_id,nome_completo) values('"+ANA+"','"+CONTA+"','Dra. Ana Souza'),('"+BRUNO+"','"+OUTRA+"','Dr. Bruno Lima');",
      "insert into public.usuarios(id,conta_id,auth_user_id,telefone,ativo) values",
      "('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','"+CONTA+"','ffffffff-ffff-4fff-8fff-ffffffffffff','"+TEL+"',true);"
    ].join('\n'));

    expect(await alterarObjetivoNoto(pool,CONTA,BRUNO,'concluir_cadastro','acompanhar','solicitacao_operador',TEL))
      .toMatchObject({ok:false});
    expect(await alterarObjetivoNoto(pool,CONTA,ANA,'concluir_cadastro','acompanhar','solicitacao_operador','5511999990000'))
      .toMatchObject({ok:false});
    expect(await alterarObjetivoNoto(pool,CONTA,ANA,'concluir_cadastro','acompanhar','solicitacao_operador',TEL))
      .toMatchObject({ok:true,estado:'iniciado'});
    expect(await alterarObjetivoNoto(pool,CONTA,ANA,'concluir_cadastro','acompanhar','solicitacao_operador',TEL))
      .toMatchObject({ok:true,estado:'ja_existente'});

    // 10 callbacks concorrentes não criam 10 objetivos.
    const concorrentes=await Promise.all(Array.from({length:10},()=>alterarObjetivoNoto(
      pool!,CONTA,ANA,'acompanhar_fiscal','acompanhar','trabalho_autorizado',TEL
    )));
    expect(concorrentes.filter(x=>x.ok&&x.estado==='iniciado')).toHaveLength(1);

    // Estado de um worker (cofre/pesquisa) não pode ser sobrescrito por turno antigo.
    await pool.query([
      'update public.noto_agent_conversas set',
      "estado=jsonb_set(estado,'{pesquisasRegistro}',",
      "'{\"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\":{\"nome\":\"Dra. Ana Souza\",\"estado\":\"confirmada\",\"razao\":\"ENCONTRADO\"}}'::jsonb,true)",
      'where conta_id=$1'
    ].join('\n'),[CONTA]);
    await salvarEstadoConversa(pool,CONTA,{
      agendaEscolhida:'tribemd',
      objetivos:{['concluir_cadastro:'+ANA]:{
        medicoId:ANA,tipo:'concluir_cadastro',status:'pausado',
        origem:'solicitacao_operador',criadoEm:new Date().toISOString(),atualizadoEm:new Date().toISOString()
      }}
    });
    const estado=await lerEstadoConversa(pool,CONTA);
    expect(Object.keys(estado.objetivos??{})).toHaveLength(2);
    expect(estado.objetivos!['concluir_cadastro:'+ANA]?.status).toBe('ativo');
    expect(estado.pesquisasRegistro?.[ANA]?.estado).toBe('confirmada');

    // Simula restart: instância do pool e da leitura diferente, mesmo JSONB.
    const outroPool=new pg.Pool({connectionString:banco.toString(),max:2});
    try{
      const novo=await lerEstadoConversa(outroPool,CONTA);
      expect(novo.objetivos!['concluir_cadastro:'+ANA]).toBeDefined();
      const plano=planejarObjetivos(novo.objetivos!,[
        {id:ANA,nome:'Dra. Ana Souza'}],novo.pesquisasRegistro,[],novo.agendaEscolhida);
      expect(plano.find(x=>x.tipo==='concluir_cadastro')).toMatchObject({
        proximoPasso:'verificar_prontidao',dependeDe:'consulta_prontidao',
        execucaoFiscalAutorizada:false
      });
    }finally{await outroPool.end();}

    expect(await alterarObjetivoNoto(pool,CONTA,ANA,'concluir_cadastro','pausar','solicitacao_operador',TEL))
      .toMatchObject({ok:true,estado:'pausado'});
    expect(await alterarObjetivoNoto(pool,CONTA,ANA,'concluir_cadastro','pausar','solicitacao_operador',TEL))
      .toMatchObject({ok:true,estado:'ja_existente'});
    expect(await alterarObjetivoNoto(pool,CONTA,ANA,'concluir_cadastro','retomar','solicitacao_operador',TEL))
      .toMatchObject({ok:true,estado:'retomado'});
    expect(await alterarObjetivoNoto(pool,CONTA,ANA,'concluir_cadastro','retomar','solicitacao_operador',TEL))
      .toMatchObject({ok:true,estado:'ja_existente'});
    const r=await pool.query("select estado from public.noto_agent_conversas where conta_id=$1",[CONTA]);
    expect(Object.keys(r.rows[0].estado.objetivos)).toHaveLength(2);
    expect(r.rows[0].estado.objetivos['concluir_cadastro:'+ANA].status).toBe('ativo');

    // Outra conta nunca herda objetivos nem os resultados pesquisados.
    expect((await lerEstadoConversa(pool,OUTRA)).objetivos).toBeUndefined();
    expect(await alterarObjetivoNoto(pool,OUTRA,ANA,'concluir_cadastro','pausar','solicitacao_operador',TEL))
      .toMatchObject({ok:false});
  }finally{
    await pool?.end().catch(()=>undefined);
    await admin.query('drop database if exists '+nome).catch(()=>undefined);
    await admin.end();
  }
});
