import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {expect,it,vi} from 'vitest';
import {
  agendarPesquisaRegistro, executarPesquisaRegistro,
  recuperarPesquisaInterrompida, reservarPesquisaRegistro,
  MAX_TENTATIVAS_REGISTRO, notificarPesquisaRegistro, extrairSugestoes
} from '../src/agente/pesquisa-profissional-conversa.js';

const testar=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']?it:it.skip;
const CONTA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANA='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOME='Dra. Ana Souza';

testar('PostgreSQL descartável: 4 tentativas totais, backoff e reinício não duplicam consultas',async()=>{
  const url=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']!;
  if(!/127\.0\.0\.1|localhost/.test(url))throw Error('TESTE_EXIGE_BANCO_DESCARTAVEL');
  const name='noto_retoma_'+randomUUID().replace(/-/g,'').slice(0,16);
  const admin=new pg.Client({connectionString:url});await admin.connect();
  const temp=new URL(url);temp.pathname='/'+name;
  let pool:pg.Pool|undefined;
  try{
    await admin.query('create database '+name);
    pool=new pg.Pool({connectionString:temp.toString(),max:3});
    await pool.query([
      'create table public.contas (id uuid primary key);',
      'create table public.medicos (id uuid primary key, conta_id uuid not null references public.contas(id), nome_completo text not null, crm text, rqe text);',
      "create table public.noto_agent_conversas (conta_id uuid primary key references public.contas(id), estado jsonb not null default '{}'::jsonb, atualizado_em timestamptz not null default now());",
      "create table public.noto_agent_mensagens(conta_id uuid,estado text,atualizado_em timestamptz default now());",
      'create table public.usuarios (id uuid primary key,conta_id uuid,auth_user_id uuid,telefone text,ativo boolean);',
      "insert into public.contas(id) values ('"+CONTA+"');",
      "insert into public.medicos(id,conta_id,nome_completo) values('"+ANA+"','"+CONTA+"','"+NOME+"');",
      "insert into public.usuarios(id,conta_id,auth_user_id,telefone,ativo) values('dddddddd-dddd-4ddd-8ddd-dddddddddddd','"+CONTA+"','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','5551999998888',true);",
      "insert into public.noto_agent_conversas(conta_id,estado) values('"+CONTA+"','{}'::jsonb);"
    ].join('\n'));

    expect(await agendarPesquisaRegistro(pool,CONTA,ANA,NOME)).toBe('agendada');
    expect(await agendarPesquisaRegistro(pool,CONTA,ANA,NOME)).toBe('ja_existe');
    const consulta={buscar:vi.fn().mockResolvedValue({estado:'indisponivel',codigo:'OPENSERP_HTTP_429'})};
    // Primeiro atendimento: reserva consumida antes da chamada ao provedor.
    expect(await executarPesquisaRegistro(pool,consulta)).toBe(true);
    let r=await pool.query('select estado from public.noto_agent_conversas where conta_id=$1',[CONTA]);
    expect(r.rows[0].estado.pesquisasRegistro[ANA]).toMatchObject({estado:'pendente',tentativas:1});
    // Sem tempo transcorrido, nenhum loop rápido ou nova chamada paga.
    expect(await executarPesquisaRegistro(pool,consulta)).toBe(false);
    expect(consulta.buscar).toHaveBeenCalledTimes(1);

    // Simula avanço de tempo apenas no banco DESCARTÁVEL.
    await pool.query([
      'update public.noto_agent_conversas',
      "set estado=jsonb_set(estado,array['pesquisasRegistro',$2,'proximaTentativaEm'],",
      'to_jsonb((now()-interval \'1 minute\')::text),true) where conta_id=$1'
    ].join('\n'),[CONTA,ANA]);
    // Reserva antes de enviar para OpenSerp, seguida de crash.
    const reservado=await reservarPesquisaRegistro(pool);
    expect(reservado).toMatchObject({contaId:CONTA,medicoId:ANA,tentativas:2});
    expect(await reservarPesquisaRegistro(pool)).toBe(null);
    await pool.query([
      'update public.noto_agent_conversas',
      "set estado=jsonb_set(estado,array['pesquisasRegistro',$2,'reservadoEm'],",
      'to_jsonb((now()-interval \'6 minutes\')::text),true) where conta_id=$1'
    ].join('\n'),[CONTA,ANA]);
    await recuperarPesquisaInterrompida(pool);
    r=await pool.query('select estado from public.noto_agent_conversas where conta_id=$1',[CONTA]);
    expect(r.rows[0].estado.pesquisasRegistro[ANA]).toMatchObject({estado:'pendente',tentativas:2});
    expect(await executarPesquisaRegistro(pool,consulta)).toBe(false);
    expect(consulta.buscar).toHaveBeenCalledTimes(1);

    // Retoma após reinício sem apagar tentativas; agora 3a e 4a.
    for(const tentativa of [3,4]){
      await pool.query([
        'update public.noto_agent_conversas',
        "set estado=jsonb_set(estado,array['pesquisasRegistro',$2,'proximaTentativaEm'],",
        'to_jsonb((now()-interval \'1 minute\')::text),true) where conta_id=$1'
      ].join('\n'),[CONTA,ANA]);
      expect(await executarPesquisaRegistro(pool,consulta)).toBe(true);
      r=await pool.query('select estado from public.noto_agent_conversas where conta_id=$1',[CONTA]);
      expect(r.rows[0].estado.pesquisasRegistro[ANA].tentativas).toBe(tentativa);
    }
    expect(MAX_TENTATIVAS_REGISTRO).toBe(4);
    expect(consulta.buscar).toHaveBeenCalledTimes(3); // 2a foi consumida pelo crash
    expect(r.rows[0].estado.pesquisasRegistro[ANA]).toMatchObject({
      estado:'resultado_pronto',razao:'LIMITE_TENTATIVAS',tentativas:4
    });
    expect(await executarPesquisaRegistro(pool,consulta)).toBe(false);
    expect(await agendarPesquisaRegistro(pool,CONTA,ANA,NOME)).toBe('ja_existe');

    const enviar=vi.fn().mockResolvedValue(true);
    expect(await notificarPesquisaRegistro(pool,'5551999998888',enviar)).toBe(true);
    expect(enviar).toHaveBeenCalledOnce();
    expect(enviar.mock.calls[0]![1]).toMatch(/não consegui obter CRM\/RQE confiáveis/i);
    expect(enviar.mock.calls[0]![1]).toMatch(/página segura/i);
    r=await pool.query('select estado from public.noto_agent_conversas where conta_id=$1',[CONTA]);
    expect(r.rows[0].estado.pesquisasRegistro[ANA].estado).toBe('manual_pendente');
    expect(await notificarPesquisaRegistro(pool,'5551999998888',enviar)).toBe(false);
    expect(enviar).toHaveBeenCalledOnce();

    // Um segundo cenário no MESMO estado do médico só existe depois de
    // reset explícito do fixture, nunca pelo fluxo de produção.
    await pool.query([
      'update public.noto_agent_conversas',
      "set estado=jsonb_set(estado,array['pesquisasRegistro',$2],$3::jsonb,false)",
      'where conta_id=$1'
    ].join('\n'),[CONTA,ANA,JSON.stringify({nome:NOME,estado:'pendente',tentativas:0})]);
    const publico={buscar:vi.fn().mockResolvedValue({
      estado:'consultado',dados:[{
        nomeCompleto:NOME,crm:'12345',uf:'RS',verificado:false,
        evidenciaCrm:'Dra. Ana Souza CRM RS 12345',
        origem:'Google via OpenSerp (sugestão não oficial)',
        urlOrigem:'https://registro.example.test/12345',rqes:[],rqe:null
      }]
    })};
    expect(extrairSugestoes(NOME,await publico.buscar())).toMatchObject({razao:'ENCONTRADO'});
    publico.buscar.mockClear();
    expect(await executarPesquisaRegistro(pool,publico)).toBe(true);
    expect(publico.buscar).toHaveBeenCalledOnce();
    expect(await executarPesquisaRegistro(pool,publico)).toBe(false);
    r=await pool.query('select estado from public.noto_agent_conversas where conta_id=$1',[CONTA]);
    expect(r.rows[0].estado.pesquisasRegistro[ANA]).toMatchObject({
      tentativas:1,estado:'resultado_pronto',razao:'ENCONTRADO',
      candidatos:[{crm:'12345/RS',rqes:[]}]
    });
  }finally{
    await pool?.end().catch(()=>undefined);
    await admin.query('drop database if exists '+name).catch(()=>undefined);
    await admin.end();
  }
});
