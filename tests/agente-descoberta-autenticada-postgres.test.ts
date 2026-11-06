import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {expect,it} from 'vitest';
import {decidirVinculo} from '../src/agente/confirmacao-contextual.js';
import {lerEstadoConversa,salvarEstadoConversa} from '../src/agente/estado-conversa.js';
import {persistirDescobertaComprovada,recuperarDescobertaComprovada}
  from '../src/agente/descoberta-autenticada.js';

const testar=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']?it:it.skip;
const CONTA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUTRA='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INSTANCIA='notomed_assistente';
const nome='Alice Castro Menezes Xavier';
const fonte={agenda:'tribemd',nomes:[nome]};

testar('descoberta autenticada: caso da confirmação anunciada mas não persistida, recuperação sem novo acesso ou IA',async()=>{
  const url=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']!;
  if(!/localhost|127\.0\.0\.1/.test(url))throw Error('POSTGRES_DESCARTAVEL_EXIGIDO');
  const dbnome='noto_descoberta_'+randomUUID().replace(/-/g,'').slice(0,14);
  const admin=new pg.Client({connectionString:url});
  await admin.connect();
  const dest=new URL(url);dest.pathname='/'+dbnome;
  let pool:pg.Pool|undefined;
  try{
    await admin.query('create database '+dbnome);
    pool=new pg.Pool({connectionString:dest.toString(),max:10});
    await pool.query([
      'create table public.noto_agent_conversas(',
      'conta_id uuid primary key,estado jsonb not null,atualizado_em timestamptz default now());',
      'create table public.noto_agent_trabalhos(',
      'id uuid primary key default gen_random_uuid(),conta_id uuid not null,',
      'instancia text not null,tipo text not null,agenda text not null,',
      'estado text not null,resultado jsonb,atualizado_em timestamptz default now());'
    ].join('\n'));
    const registrarJob=async(contaId:string,instancia:string,
      candidato:{agenda:string;nomes:string[]},atraso='0 minutes')=>
      pool!.query([
        'insert into public.noto_agent_trabalhos',
        '(conta_id,instancia,tipo,agenda,estado,resultado,atualizado_em)',
        "values($1,$2,'descoberta_agenda',$3,'aceito_api',$4::jsonb,",
        "now()-($5::interval))"
      ].join('\n'),[contaId,instancia,candidato.agenda,
        JSON.stringify({ok:true,...candidato}),atraso]);

    // O antigo worker tinha aceito o balão, mas seu UPDATE atingira zero linhas.
    await pool.query(
      "insert into public.noto_agent_conversas(conta_id,estado) values($1,'{}'::jsonb)",
      [CONTA]
    );
    await registrarJob(CONTA,INSTANCIA,fonte);
    const antigo=await lerEstadoConversa(pool,CONTA);
    expect(decidirVinculo(antigo,{agenda:'tribemd',decisao:'confirmar',
      nomes:[],mensagem:'Sim, sou eu.'})).toMatchObject({ok:false,motivo:'SEM_DESCOBERTA'});
    expect(await recuperarDescobertaComprovada(pool,CONTA,INSTANCIA,antigo)).toBe('RECUPERADA');
    const estado=await lerEstadoConversa(pool,CONTA);
    expect(estado).toMatchObject({faseAgenda:'CONFIRMACAO_PENDENTE',
      descoberta:fonte});
    expect(decidirVinculo(estado,{agenda:'tribemd',decisao:'confirmar',
      nomes:[],mensagem:'Sim, sou eu.'})).toEqual({
      ok:true,agenda:'tribemd',nomes:[nome]
    });
    expect(await recuperarDescobertaComprovada(pool,CONTA,INSTANCIA,estado)).toBe('JA_COMPROVADA');
    // Escrita tardia da fila/conversa nunca derruba a fase pendente.
    await salvarEstadoConversa(pool,CONTA,{tarefasPendentes:[]});
    expect((await lerEstadoConversa(pool,CONTA)).descoberta).toEqual(fonte);
    expect((await lerEstadoConversa(pool,CONTA)).faseAgenda).toBe('CONFIRMACAO_PENDENTE');

    // Confirmado não pode ser ressuscitado por uma notificação antiga.
    await pool.query([
      "update public.noto_agent_conversas",
      "set estado=estado||'{\"faseAgenda\":\"VINCULO_CONFIRMADO\"}'::jsonb",
      'where conta_id=$1'
    ].join('\n'),[CONTA]);
    expect(await persistirDescobertaComprovada(pool,CONTA,'tribemd',[nome])).toBe(false);
    expect(await recuperarDescobertaComprovada(pool,CONTA,INSTANCIA,
      await lerEstadoConversa(pool,CONTA))).toBe('CONFLITO_ESTADO');
    expect((await lerEstadoConversa(pool,CONTA)).faseAgenda).toBe('VINCULO_CONFIRMADO');

    // A fila de outra conta e outro processo jamais reconstitui uma prova.
    await registrarJob(CONTA,'outra_instancia',{agenda:'tribemd',nomes:['Outra Medica']});
    await registrarJob(OUTRA,INSTANCIA,{agenda:'tribemd',nomes:['Outra Medica']});
    const vazio={};
    expect(await recuperarDescobertaComprovada(pool,OUTRA,'outra_instancia',vazio))
      .toBe('SEM_PROVA');
    expect(await recuperarDescobertaComprovada(pool,OUTRA,INSTANCIA,{
      agendaEscolhida:'amplimed'
    })).toBe('CONFLITO_ESTADO');

    // Conta nova com resultado autenticado, sem linha de conversa: cria
    // somente a fase de confirmação, jamais vínculo ou CRM.
    const NOVA='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await registrarJob(NOVA,INSTANCIA,fonte);
    expect(await recuperarDescobertaComprovada(pool,NOVA,INSTANCIA,{})).toBe('RECUPERADA');
    expect((await lerEstadoConversa(pool,NOVA)).profissionalConfirmadoId).toBeUndefined();

    // Sem prova, a recuperação não inventa descoberta pela fala do assistente.
    const SEM='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    expect(await recuperarDescobertaComprovada(pool,SEM,INSTANCIA,{})).toBe('SEM_PROVA');
    expect((await lerEstadoConversa(pool,SEM)).descoberta).toBeUndefined();

    // Duas provas com nomes divergentes ficam em conflito explícito.
    const CONFLITO='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await registrarJob(CONFLITO,INSTANCIA,fonte,'2 minutes');
    await registrarJob(CONFLITO,INSTANCIA,{
      agenda:'tribemd',nomes:['Dr. Bruno Costa']
    });
    expect(await recuperarDescobertaComprovada(pool,CONFLITO,INSTANCIA,{}))
      .toBe('CONFLITO_PROVAS');
    expect((await lerEstadoConversa(pool,CONFLITO)).descoberta).toBeUndefined();
  }finally{
    await pool?.end().catch(()=>undefined);
    await admin.query('drop database if exists '+dbnome).catch(()=>undefined);
    await admin.end().catch(()=>undefined);
  }
});
