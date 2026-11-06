import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {expect,it,vi} from 'vitest';
import {
  reservarCustoPiloto,liquidarCustoPiloto,lerOrcamentoNoto,
  notificarPausaPorCusto,PausaCustoPiloto,custoMaximoNanoUsd,
  consumoVerificado,TETO_RODADA_NANO_USD
} from '../src/agente/limite-gasto-rodada.js';
import {executarPesquisaRegistro} from '../src/agente/pesquisa-profissional-conversa.js';
import {ProvedorAgenteComOrcamento} from '../src/agente/modelo-com-limite.js';
import type {Model,ModelProvider} from '@openai/agents';

const testar=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']?it:it.skip;
const CONTA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEDICO='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

testar('US$1 por rodada: pré-reserva atômica, falha fechada, recomeço explícito, worker CRM e aviso único',async()=>{
  const url=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']!;
  if(!/127\.0\.0\.1|localhost/.test(url))throw Error('TESTE_EXIGE_POSTGRES_DESCARTAVEL');
  const nome='noto_custo_'+randomUUID().replace(/-/g,'').slice(0,15);
  const admin=new pg.Client({connectionString:url});await admin.connect();
  const temp=new URL(url);temp.pathname='/'+nome;
  let pool:pg.Pool|undefined;
  try{
    await admin.query('create database '+nome);
    pool=new pg.Pool({connectionString:temp.toString(),max:20});
    // Usar a migração REAL, não uma tabela de teste mais permissiva.
    const sql=readFileSync(new URL('../scripts/migrations/20261108-noto-piloto-rodadas-ia.sql',
      import.meta.url),'utf8');
    await pool.query(sql);
    const rls=await pool.query([
      "select c.relname,c.relrowsecurity from pg_class c",
      "where c.relname in ('noto_piloto_rodadas_ia','noto_piloto_chamadas_ia')"
    ].join('\n'));
    expect(rls.rows).toHaveLength(2);
    expect(rls.rows.every(x=>x.relrowsecurity)).toBe(true);

    expect(await lerOrcamentoNoto(pool)).toMatchObject({estado:'sem_rodada'});
    await expect(reservarCustoPiloto(pool,'conversa','gpt-4o-mini'))
      .rejects.toMatchObject({motivo:'SEM_RODADA'});
    await expect(reservarCustoPiloto(pool,'conversa','modelo-nao-precificado'))
      .rejects.toMatchObject({motivo:'MODELO_SEM_PRECO'});
    expect(custoMaximoNanoUsd('gpt-4o-mini')).toBe(29_030_400);
    expect(consumoVerificado(undefined)).toBeNull();
    expect(consumoVerificado({inputTokens:100,outputTokens:20})).toEqual({entrada:100,saida:20});
    expect(consumoVerificado({prompt_tokens:200,completion_tokens:30})).toEqual({entrada:200,saida:30});

    const nova=await pool.query([
      "insert into public.noto_piloto_rodadas_ia(estado) values('ativa') returning id"
    ].join('\n'));
    const id1=nova.rows[0].id;
    const r1=await reservarCustoPiloto(pool,'conversa','gpt-4o-mini');
    const r2=await reservarCustoPiloto(pool,'crm_rqe','gpt-4o-mini');
    expect(r1.rodadaId).toBe(id1);
    expect(r2.rodadaId).toBe(id1);
    // 4k tokens de entrada + 500 de saída, US$0.0009, sem texto sensível.
    await liquidarCustoPiloto(pool,r1,{entrada:4000,saida:500});
    await liquidarCustoPiloto(pool,r1,{entrada:4000,saida:500});
    await liquidarCustoPiloto(pool,r2,null);
    expect(await lerOrcamentoNoto(pool)).toMatchObject({
      estado:'ativa',utilizadoNanoUsd:900_000,reservadoNanoUsd:29_030_400
    });

    // Nenhum crash ou reinício pode apagar uma reserva incompleta.
    const reiniciado=new pg.Pool({connectionString:temp.toString(),max:5});
    try{
      expect((await lerOrcamentoNoto(reiniciado)).reservadoNanoUsd).toBe(29_030_400);
    }finally{await reiniciado.end();}

    const novas=await Promise.all(Array.from({length:37},()=>reservarCustoPiloto(
      pool!,'conversa','gpt-4o-mini').catch((erro:unknown)=>erro
    )));
    expect(novas.some(x=>x instanceof PausaCustoPiloto&&x.motivo==='LIMITE_TESTE')).toBe(true);
    const estado=await lerOrcamentoNoto(pool);
    expect(estado.estado).toBe('pausada');
    expect(estado.reservadoNanoUsd+estado.utilizadoNanoUsd).toBeLessThanOrEqual(TETO_RODADA_NANO_USD);
    await expect(reservarCustoPiloto(pool,'crm_rqe','gpt-4o-mini'))
      .rejects.toMatchObject({motivo:'LIMITE_TESTE'});

    const enviar=vi.fn().mockResolvedValue(true);
    const alertas=await Promise.all([
      notificarPausaPorCusto(pool,texto=>enviar(texto)),
      notificarPausaPorCusto(pool,texto=>enviar(texto))
    ]);
    expect(alertas.filter(Boolean)).toHaveLength(1);
    expect(enviar).toHaveBeenCalledOnce();
    expect(enviar.mock.calls[0]![0]).toContain('US$ 1');
    expect(await notificarPausaPorCusto(pool,texto=>enviar(texto))).toBe(false);

    // Recomeçar não é reiniciar processo nem zerar histórico: ato explícito.
    await pool.query([
      "update public.noto_piloto_rodadas_ia set estado='encerrada',encerrada_em=now()",
      "where estado='pausada'"
    ].join('\n'));
    const proxima=await pool.query([
      "insert into public.noto_piloto_rodadas_ia(estado) values('ativa') returning id"
    ].join('\n'));
    expect(proxima.rows[0].id).not.toBe(id1);
    expect(await lerOrcamentoNoto(pool)).toMatchObject({
      estado:'ativa',reservadoNanoUsd:0,utilizadoNanoUsd:0
    });
    // Decorador real do SDK intercepta CADA getResponse, inclusive após
    // uma tool call que força novo turno. Nenhuma chamada externa neste teste.
    const resposta=vi.fn(async()=>({
      output:[],usage:{inputTokens:100,outputTokens:20}
    }));
    const modeloFalso=({getResponse:resposta,getStreamedResponse:()=>{throw Error('stream');}}) as unknown as Model;
    const provedorFalso={getModel:()=>modeloFalso} as ModelProvider;
    const protegido=await new ProvedorAgenteComOrcamento(provedorFalso,pool).getModel('gpt-4o-mini');
    await protegido.getResponse({} as Parameters<Model['getResponse']>[0]);
    await protegido.getResponse({} as Parameters<Model['getResponse']>[0]);
    expect(resposta).toHaveBeenCalledTimes(2);
    expect(await lerOrcamentoNoto(pool)).toMatchObject({
      estado:'ativa',reservadoNanoUsd:0,utilizadoNanoUsd:54_000
    });
    await expect(new ProvedorAgenteComOrcamento(provedorFalso,pool)
      .getModel('modelo-nao-precificado')).rejects.toMatchObject({motivo:'MODELO_SEM_PRECO'});
    const antiga=await pool.query([
      'select utilizado_nano_usd,reservado_nano_usd from public.noto_piloto_rodadas_ia where id=$1'
    ].join('\n'),[id1]);
    expect(Number(antiga.rows[0].utilizado_nano_usd)).toBe(900_000);
    expect(Number(antiga.rows[0].reservado_nano_usd)).toBeGreaterThan(0);

    // Se o modelo for barrado antes da chamada, o CRM não gasta 1 de 4 tentativas.
    await pool.query([
      'create table public.medicos(id uuid primary key,conta_id uuid,nome_completo text);',
      "create table public.noto_agent_conversas(conta_id uuid primary key,estado jsonb not null,atualizado_em timestamptz default now());",
      "insert into public.medicos values('"+MEDICO+"','"+CONTA+"','Dra. Ana Souza');",
      "insert into public.noto_agent_conversas(conta_id,estado) values('"+CONTA+"',",
      "jsonb_build_object('pesquisasRegistro',jsonb_build_object('"+MEDICO+"',",
      "jsonb_build_object('nome','Dra. Ana Souza','estado','pendente','tentativas',0))));"
    ].join('\n'));
    const buscar=vi.fn(async()=>{throw new PausaCustoPiloto('LIMITE_TESTE');});
    expect(await executarPesquisaRegistro(pool,{buscar})).toBe(false);
    expect(buscar).toHaveBeenCalledOnce();
    const pesquisa=await pool.query([
      "select estado#>>array['pesquisasRegistro',$2::text,'estado'] as situacao,",
      "estado#>>array['pesquisasRegistro',$2::text,'tentativas'] as tentativas",
      'from public.noto_agent_conversas where conta_id=$1'
    ].join('\n'),[CONTA,MEDICO]);
    expect(pesquisa.rows[0]).toMatchObject({situacao:'pendente',tentativas:'0'});
  }finally{
    await pool?.end().catch(()=>undefined);
    await admin.query('drop database if exists '+nome).catch(()=>undefined);
    await admin.end();
  }
});
