import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {it,expect,vi} from 'vitest';
import {
  adiarConfirmacaoRegistro,leituraPesquisaEstado,agendarPesquisaRegistro,executarPesquisaRegistro,reservarAvisoPesquisa,
  marcarAvisoPesquisa,proporCorrecaoPesquisa,concluirRevisaoPesquisa,
  recuperarPesquisaInterrompida
} from '../src/agente/pesquisa-profissional-conversa.js';
import {registrarVinculoConversa} from '../src/agente/vinculo-conversa.js';
import {registrarPeriodoConferencia,salvarEstadoConversa} from '../src/agente/estado-conversa.js';

const testar=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']?it:it.skip;
const CONTA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUTRA='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ANA='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BRUNO='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOME='Dra. Ana Souza';

testar('PostgreSQL descartável: vínculo contextual e fila OpenSerp já existente, sem serviço pago',async()=>{
  const url=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']!;
  if(!/127\.0\.0\.1|localhost/.test(url))throw Error('TESTE_EXIGE_BANCO_LOCAL_DESCARTAVEL');
  const dbName='noto_registro_'+randomUUID().replace(/-/g,'').slice(0,16);
  const admin=new pg.Client({connectionString:url});
  await admin.connect();
  const isolada=new URL(url);isolada.pathname='/'+dbName;
  let db:pg.Client|undefined;
  try{
    await admin.query('create database '+dbName);
    db=new pg.Client({connectionString:isolada.toString()});
    await db.connect();
    await db.query([
      'create table public.contas (id uuid primary key);',
      'create table public.medicos (id uuid primary key, conta_id uuid not null references public.contas(id), nome_completo text not null, crm text, rqe text);',
      "create table public.noto_agent_conversas (conta_id uuid primary key references public.contas(id), estado jsonb not null default '{}'::jsonb, atualizado_em timestamptz not null default now());",
      "create table public.noto_agent_mensagens(conta_id uuid,estado text,atualizado_em timestamptz default now());",
      "insert into public.contas (id) values ('"+CONTA+"'),('"+OUTRA+"');",
      "insert into public.medicos(id,conta_id,nome_completo) values ('"+ANA+"','"+CONTA+"','"+NOME+"'),('"+BRUNO+"','"+OUTRA+"','Dr. Bruno Lima');"
    ].join('\n'));
    const estado={agendaEscolhida:'tribemd',faseAgenda:'CONFIRMACAO_PENDENTE',
      descoberta:{agenda:'tribemd',nomes:[NOME]},perguntaPendente:'confirmar_profissional'};
    await db.query('insert into public.noto_agent_conversas(conta_id,estado) values($1,$2::jsonb)',[CONTA,JSON.stringify(estado)]);

    // A confirmação não depende da resposta textual, apenas do fato registrado e do alvo.
    const vinculo=await registrarVinculoConversa(db as unknown as pg.Pool,CONTA,'tribemd',{id:ANA,nome:NOME});
    expect(vinculo).toMatchObject({ok:true,restantes:[]});
    let atual=await db.query('select estado from public.noto_agent_conversas where conta_id=$1',[CONTA]);
    expect(atual.rows[0].estado).toMatchObject({
      faseAgenda:'VINCULO_CONFIRMADO',profissionalConfirmadoId:ANA,descoberta:{agenda:'tribemd',nomes:[]}
    });

    // Reentrada idempotente não cria profissional nem segunda autorização.
    expect((await registrarVinculoConversa(db as unknown as pg.Pool,CONTA,'tribemd',{id:ANA,nome:NOME})).ok).toBe(false);
    expect(await agendarPesquisaRegistro(db as unknown as pg.Pool,CONTA,BRUNO,'Dr. Bruno Lima')).toBe('indisponivel');
    expect(await agendarPesquisaRegistro(db as unknown as pg.Pool,CONTA,ANA,NOME)).toBe('agendada');
    const reenvio=await agendarPesquisaRegistro(db as unknown as pg.Pool,CONTA,ANA,NOME);
    expect(['agendada','ja_existe']).toContain(reenvio);

    const consulta={buscar:vi.fn().mockResolvedValue({estado:'consultado',dados:[{
      nomeCompleto:NOME,crm:'12345',uf:'RS',rqe:'980',rqes:['980'],
      verificado:true,origem:'Google via OpenSerp',urlOrigem:'https://registro.example.test'
    }]})};
    expect(await executarPesquisaRegistro(db as unknown as pg.Pool,consulta)).toBe(true);
    expect(await executarPesquisaRegistro(db as unknown as pg.Pool,consulta)).toBe(false);
    expect(consulta.buscar).toHaveBeenCalledExactlyOnceWith(NOME);

    // Mesmo com resultado pronto, o worker aguarda as bolhas do webhook.
    await db.query("insert into public.noto_agent_mensagens(conta_id,estado) values($1,'reservada')",[CONTA]);
    expect(await reservarAvisoPesquisa(db as unknown as pg.Pool)).toBe(null);
    await db.query("update public.noto_agent_mensagens set estado='concluida' where conta_id=$1",[CONTA]);
    // Turno de outra conta não bloqueia Alice. Reserva abandonada tem limite.
    await db.query("insert into public.noto_agent_mensagens(conta_id,estado) values($1,'reservada')",[OUTRA]);
    await db.query("insert into public.noto_agent_mensagens(conta_id,estado,atualizado_em) values($1,'reservada',now()-interval '5 minutes')",[CONTA]);
    const aviso=await reservarAvisoPesquisa(db as unknown as pg.Pool);
    expect(aviso).toMatchObject({contaId:CONTA,medicoId:ANA,
      pesquisa:{razao:'ENCONTRADO',candidatos:[{crm:'12345/RS',rqes:['980']}]}});
    expect(await marcarAvisoPesquisa(db as unknown as pg.Pool,aviso!,true)).toBe(true);
    expect(await reservarAvisoPesquisa(db as unknown as pg.Pool)).toBe(null);

    const antesAdiamento=(await db.query('select estado from public.noto_agent_conversas where conta_id=$1',[CONTA])).rows[0].estado;
    expect(await adiarConfirmacaoRegistro(db as unknown as pg.Pool,OUTRA,ANA)).toBe(false);
    expect(await adiarConfirmacaoRegistro(db as unknown as pg.Pool,CONTA,ANA)).toBe(true);
    const depoisAdiamento=(await db.query('select estado from public.noto_agent_conversas where conta_id=$1',[CONTA])).rows[0].estado;
    expect(depoisAdiamento).toEqual({...antesAdiamento,pesquisasRegistro:{
      ...antesAdiamento.pesquisasRegistro,
      [ANA]:{...antesAdiamento.pesquisasRegistro[ANA],confirmacaoAdiada:true}
    }});
    expect(leituraPesquisaEstado(depoisAdiamento.pesquisasRegistro)[ANA]).toMatchObject({
      confirmacaoAdiada:true,estado:'aguardando_confirmacao',tentativas:1
    });
    expect((await db.query('select crm,rqe from public.medicos where id=$1',[ANA])).rows[0])
      .toEqual({crm:null,rqe:null});
    expect(await executarPesquisaRegistro(db as unknown as pg.Pool,consulta)).toBe(false);
    expect(consulta.buscar).toHaveBeenCalledTimes(1);

    await salvarEstadoConversa(db as unknown as pg.Pool,CONTA,{perguntaPendente:'periodo'});
    expect(await registrarPeriodoConferencia(db as unknown as pg.Pool,OUTRA,ANA,'2026-11-01')).toBe(false);
    expect(await registrarPeriodoConferencia(db as unknown as pg.Pool,CONTA,ANA,'2026-02-30')).toBe(false);
    expect(await registrarPeriodoConferencia(db as unknown as pg.Pool,CONTA,ANA,'2026-11-01')).toBe(true);
    const periodoSalvo=(await db.query('select estado from public.noto_agent_conversas where conta_id=$1',[CONTA])).rows[0].estado;
    expect(periodoSalvo).toMatchObject({periodoConferencia:{profissionalId:ANA,inicio:'2026-11-01'},
      perguntaPendente:null,profissionalConfirmadoId:ANA,
      pesquisasRegistro:{[ANA]:{confirmacaoAdiada:true,estado:'aguardando_confirmacao'}}});
    expect(await registrarPeriodoConferencia(db as unknown as pg.Pool,CONTA,ANA,'2026-11-02')).toBe(false);

    // Mesmo snapshot observado em homolog: vínculo e CRM adiado, pergunta perdida.
    for(const pergunta of [undefined,null]){
      const legado=structuredClone(depoisAdiamento);
      delete legado.periodoConferencia;
      if(pergunta===undefined)delete legado.perguntaPendente;
      else legado.perguntaPendente=null;
      await db.query('update public.noto_agent_conversas set estado=$2 where conta_id=$1',[CONTA,legado]);
      expect(await registrarPeriodoConferencia(db as unknown as pg.Pool,CONTA,ANA,'2026-11-01')).toBe(true);
      const salvo=(await db.query('select estado from public.noto_agent_conversas where conta_id=$1',[CONTA])).rows[0].estado;
      expect(salvo).toEqual({...legado,perguntaPendente:null,
        periodoConferencia:{profissionalId:ANA,inicio:'2026-11-01'}});
    }
    for(const alteracao of [
      {faseAgenda:'DESCOBERTA_PENDENTE'},
      {perguntaPendente:'agenda'},
      {pesquisasRegistro:{[ANA]:{...depoisAdiamento.pesquisasRegistro[ANA],confirmacaoAdiada:false}}},
      {pesquisasRegistro:{[ANA]:{...depoisAdiamento.pesquisasRegistro[ANA],nome:'Outro Profissional'}}},
      {periodoConferencia:{profissionalId:ANA,inicio:'2026-10-01'}}
    ]){
      const conflito={...depoisAdiamento,perguntaPendente:null,...alteracao};
      await db.query('update public.noto_agent_conversas set estado=$2 where conta_id=$1',[CONTA,conflito]);
      expect(await registrarPeriodoConferencia(db as unknown as pg.Pool,CONTA,ANA,'2026-11-01')).toBe(false);
      expect((await db.query('select estado from public.noto_agent_conversas where conta_id=$1',[CONTA])).rows[0].estado).toEqual(conflito);
    }
    await db.query('update public.noto_agent_conversas set estado=$2 where conta_id=$1',[CONTA,periodoSalvo]);

    expect(await proporCorrecaoPesquisa(db as unknown as pg.Pool,CONTA,ANA,{
      crm:'66666/RS',rqe:'777'
    })).toBe(true);
    expect(await proporCorrecaoPesquisa(db as unknown as pg.Pool,OUTRA,ANA,{
      crm:'66666/RS',rqe:'777'
    })).toBe(false);
    atual=await db.query('select estado from public.noto_agent_conversas where conta_id=$1',[CONTA]);
    expect(atual.rows[0].estado.pesquisasRegistro[ANA].proposta).toEqual({
      crm:'66666/RS',rqe:'777',origem:'correcao'
    });

    // Outro turno não sobrescreve o resultado e a proposta do worker.
    await salvarEstadoConversa(db as unknown as pg.Pool,CONTA,{
      agendaEscolhida:'tribemd',profissionalConfirmadoId:ANA,perguntaPendente:null
    });
    atual=await db.query('select estado from public.noto_agent_conversas where conta_id=$1',[CONTA]);
    expect(atual.rows[0].estado.pesquisasRegistro[ANA].proposta.crm).toBe('66666/RS');

    expect(await concluirRevisaoPesquisa(db as unknown as pg.Pool,CONTA,ANA)).toBe(true);
    expect(await concluirRevisaoPesquisa(db as unknown as pg.Pool,CONTA,ANA)).toBe(false);
    await recuperarPesquisaInterrompida(db as unknown as pg.Pool);
    atual=await db.query('select estado from public.noto_agent_conversas where conta_id=$1',[CONTA]);
    expect(atual.rows[0].estado.pesquisasRegistro[ANA].estado).toBe('confirmada');
    // Pesquisa, proposta e aprovação conversacional NÃO alteram dados profissionais;
    // isso exige a ferramenta de gravação com consentimento em outro passo.
    const medicos=await db.query('select crm,rqe from public.medicos where id=$1',[ANA]);
    expect(medicos.rows[0]).toEqual({crm:null,rqe:null});
  }finally{
    await db?.end().catch(()=>{});
    await admin.query('drop database if exists '+dbName).catch(()=>{});
    await admin.end();
  }
});
