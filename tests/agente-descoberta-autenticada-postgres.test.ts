import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {expect,it} from 'vitest';
import {decidirVinculo} from '../src/agente/confirmacao-contextual.js';
import {lerEstadoConversa,salvarEstadoConversa} from '../src/agente/estado-conversa.js';
import {
  persistirDescobertaComprovada,persistirDescobertaAindaPendente,
  recuperarDescobertaComprovada
} from '../src/agente/descoberta-autenticada.js';
import {criarAgenteNoto} from '../src/agente/agente.js';

const testar=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']?it:it.skip;
const CONTA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUTRA='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INSTANCIA='notomed_assistente';
const nome='Dra. Ana Souza';
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

    // Cenário real do Cofre: a leitura veio da sessão do navegador e
    // NAO tem linha em noto_agent_trabalhos. Um JSON antigo só continha
    // a descoberta verificada, sem fase; a recuperação não deve depender
    // da fila nem da resposta anterior do WhatsApp.
    const CONTA_COFRE='ffffffff-ffff-4fff-8fff-ffffffffffff';
    await pool.query([
      'insert into public.noto_agent_conversas(conta_id,estado)',
      "values($1,jsonb_build_object('agendaEscolhida','tribemd','descoberta',$2::jsonb))"
    ].join('\n'),[CONTA_COFRE,JSON.stringify(fonte)]);
    const antigoCofre=await lerEstadoConversa(pool,CONTA_COFRE);
    expect(antigoCofre.faseAgenda).toBeUndefined();
    expect(await recuperarDescobertaComprovada(
      pool,CONTA_COFRE,INSTANCIA,antigoCofre)).toBe('RECUPERADA_ESTADO');
    const recomposto=await lerEstadoConversa(pool,CONTA_COFRE);
    expect(recomposto.faseAgenda).toBe('CONFIRMACAO_PENDENTE');
    expect(decidirVinculo(recomposto,{
      agenda:'tribemd',decisao:'confirmar',nomes:[],mensagem:'Sim, sou eu.'
    })).toEqual({ok:true,agenda:'tribemd',nomes:[nome]});
    const agente=criarAgenteNoto({
      texto:'Sim, sou eu.',profissionais:[],estadoConversa:recomposto
    },{
      consultarStatus:async()=>({tribemd:{salvo:true,conectada:true},
        amplimed:{salvo:false,conectada:false}}),
      confirmarProfissionais:async()=>({ok:false,motivo:'TESTE'})
    });
    expect(agente.modelSettings.toolChoice).toBe('confirmar_profissionais_descobertos');
    expect(await recuperarDescobertaComprovada(pool,CONTA_COFRE,INSTANCIA,recomposto))
      .toBe('JA_COMPROVADA');
    const jobsCofre=await pool.query(
      'select count(*)::int as total from public.noto_agent_trabalhos where conta_id=$1',
      [CONTA_COFRE]
    );
    expect(jobsCofre.rows[0].total).toBe(0);

    // Nas próximas conexões, a sessão do Cofre grava a dupla fase+nomes
    // de uma vez, com proveniência interna. Nunca persiste só os nomes.
    const COFRE_NOVO='11111111-1111-4111-8111-111111111111';
    expect(await persistirDescobertaComprovada(pool,COFRE_NOVO,'tribemd',
      [nome],'cofre_sessao')).toBe(true);
    const raw=await pool.query('select estado from public.noto_agent_conversas where conta_id=$1',
      [COFRE_NOVO]);
    expect(raw.rows[0].estado).toMatchObject({
      faseAgenda:'CONFIRMACAO_PENDENTE',
      descoberta:fonte,origemDescoberta:'cofre_sessao',
      perguntaPendente:'confirmar_profissional'
    });
    expect(await persistirDescobertaComprovada(pool,COFRE_NOVO,'tribemd',
      ['Dr. Bruno Costa'],'cofre_sessao')).toBe(false);
    // Nova leitura sem nomes não destrói um convite já validado.
    expect(await persistirDescobertaAindaPendente(pool,COFRE_NOVO,'tribemd'))
      .toBe(false);
    expect((await lerEstadoConversa(pool,COFRE_NOVO)).descoberta).toEqual(fonte);
    expect((await lerEstadoConversa(pool,COFRE_NOVO)).faseAgenda)
      .toBe('CONFIRMACAO_PENDENTE');

    const COFRE_VAZIO='22222222-2222-4222-8222-222222222222';
    expect(await persistirDescobertaAindaPendente(pool,COFRE_VAZIO,'tribemd'))
      .toBe(true);
    expect((await lerEstadoConversa(pool,COFRE_VAZIO)).faseAgenda)
      .toBe('DESCOBERTA_PENDENTE');
    expect(await persistirDescobertaComprovada(pool,COFRE_VAZIO,'tribemd',
      [nome],'cofre_sessao')).toBe(true);
    expect((await lerEstadoConversa(pool,COFRE_VAZIO)).faseAgenda)
      .toBe('CONFIRMACAO_PENDENTE');

    // Prova parcial inválida, fase explícita incompatível ou médico já
    // confirmado não podem ser convertidos em autorização por inferência.
    for(const [id,estadoBruto] of [
      ['33333333-3333-4333-8333-333333333333',
        {agendaEscolhida:'tribemd',faseAgenda:'VINCULO_CONFIRMADO',descoberta:fonte}],
      ['44444444-4444-4444-8444-444444444444',
        {agendaEscolhida:'tribemd',faseAgenda:'ETAPA_DESCONHECIDA',descoberta:fonte}],
      ['55555555-5555-4555-8555-555555555555',
        {agendaEscolhida:'amplimed',descoberta:fonte}],
      ['66666666-6666-4666-8666-666666666666',
        {agendaEscolhida:'tribemd',profissionalConfirmadoId:'outro-id',descoberta:fonte}],
      ['77777777-7777-4777-8777-777777777777',
        {agendaEscolhida:'tribemd',descoberta:{...fonte,nomes:[nome,123]}}]
    ] as const){
      await pool.query('insert into public.noto_agent_conversas(conta_id,estado) values($1,$2::jsonb)',
        [id,JSON.stringify(estadoBruto)]);
      const parcial=await lerEstadoConversa(pool,id);
      const resultado=await recuperarDescobertaComprovada(pool,id,INSTANCIA,parcial);
      expect(resultado).not.toBe('RECUPERADA_ESTADO');
      expect((await lerEstadoConversa(pool,id)).faseAgenda)
        .not.toBe('CONFIRMACAO_PENDENTE');
    }

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
