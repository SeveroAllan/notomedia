import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import { autorizarEmissaoWhatsApp, tratarPropostaEmissaoWhatsApp } from '../src/io/postgres/postgres-emissao-whatsapp-repositorio.js';
import { PostgresFilaRepositorio } from '../src/io/postgres/postgres-fila-repositorio.js';

const url = process.env['NOTO_SCHEMA_TEST_DATABASE_URL'];
it.runIf(Boolean(url))('duas autorizações geram uma solicitação e só o worker do piloto pode reservá-la', async()=>{
  const conexao = new URL(url!);
  if (!['127.0.0.1','localhost'].includes(conexao.hostname)) throw new Error('BANCO_DESCARTAVEL_OBRIGATORIO');
  const nome = 'noto_emissao_'+randomUUID().replaceAll('-','');
  const admin = new pg.Client({connectionString:url});
  await admin.connect();
  let pool:pg.Pool|undefined;
  try {
    await admin.query('create database '+nome);
    conexao.pathname='/'+nome;
    pool = new pg.Pool({connectionString:conexao.toString()});
    await pool.query(`
      create table contas (id uuid primary key);
      create table medicos (id uuid primary key, conta_id uuid, crm text);
      create table medico_perfil_fiscal (medico_id uuid primary key, ambiente text, confirmado_pelo_medico boolean,
        cpf_cnpj_encriptado bytea, serie_dps text, proximo_numero_dps int, cod_municipio_ibge text, opcao_simples_nacional text);
      create table medico_servicos_fiscais (id uuid primary key, medico_id uuid, ativo boolean,
        parametros_emissao jsonb, xdesc_serv text, ctrib_nac text, cnbs text);
      create table medico_certificados (medico_id uuid, status text, valido_ate date, valido_de date);
      create table agendamentos (id uuid primary key, medico_id uuid, paciente_id uuid, servico_fiscal_id uuid,
        origem text, referencia_externa text, data_hora timestamptz, valor_consulta_centavos int,
        identificacao_profissional_confirmada boolean, status text);
      create table solicitacoes_nota (
        id uuid primary key default gen_random_uuid(), medico_id uuid not null, paciente_id uuid, servico_fiscal_id uuid,
        origem text, fila text, status text, criado_em timestamptz default now(), xdesc_serv text, valor_servico_centavos int,
        ctrib_nac text, cnbs text, cclass_trib text, cind_op text, datas_consulta_texto text, tentativas int default 0,
        aguardando_dados_profissionais boolean default false, aguardando_confirmacao_medico boolean default false,
        proxima_tentativa_em timestamptz, bloqueada_em timestamptz, bloqueada_por_worker text
      );
      create table solicitacao_nota_agendamentos (solicitacao_id uuid, agendamento_id uuid, medico_id uuid);
      create table noto_auditoria_comprovantes (id uuid primary key default gen_random_uuid(),
        medico_id uuid, lido jsonb, estado jsonb, decisao jsonb);
      create table noto_emissoes_comprovantes (
        medico_id uuid, consulta_chave text, comprovante_chave text not null, auditoria_comprovante_id uuid,
        solicitacao_id uuid unique, estado text, atualizado_em timestamptz, unique(medico_id,consulta_chave)
      );
    `);
    await pool.query(readFileSync(new URL('../scripts/migrations/20261110-noto-fiscal-whatsapp.sql',import.meta.url),'utf8'));
    const escopo={contaId:randomUUID(),medicoId:randomUUID(),agendamentoId:randomUUID()};
    const servico=randomUUID(), tomador=randomUUID();
    await pool.query('insert into contas values ($1)',[escopo.contaId]);
    await pool.query("insert into medicos values ($1,$2,'12345/RS')",[escopo.medicoId,escopo.contaId]);
    await pool.query("insert into medico_perfil_fiscal values ($1,'homologacao',true,decode('00','hex'),'00001',1,'1234567','nao_optante')",[escopo.medicoId]);
    await pool.query("insert into medico_servicos_fiscais values ($1,$2,true,'{}','Atendimento sintético','040101',null)",[servico,escopo.medicoId]);
    await pool.query("insert into medico_certificados values ($1,'ativo',current_date+1,null)",[escopo.medicoId]);
    await pool.query("insert into agendamentos values ($1,$2,$3,$4,'tribemd','sintetico',now(),10000,true,'realizado')",
      [escopo.agendamentoId,escopo.medicoId,tomador,servico]);
    const entrada={contaId:escopo.contaId,valor:10000,mensagemRef:'teste-a'};
    expect(await autorizarEmissaoWhatsApp(pool,escopo,{...entrada,valor:1})).toBe('bloqueada');
    expect((await Promise.all([autorizarEmissaoWhatsApp(pool,escopo,entrada),
      autorizarEmissaoWhatsApp(pool,escopo,{...entrada,mensagemRef:'teste-b'})])).sort()).toEqual(['enfileirada','ja_enfileirada']);
    expect((await pool.query('select count(*)::int n from solicitacoes_nota')).rows[0].n).toBe(1);
    expect((await pool.query(`select s.competencia_emissao = (a.data_hora at time zone 'America/Sao_Paulo')::date igual
      from solicitacoes_nota s join solicitacao_nota_agendamentos sa on sa.solicitacao_id=s.id
      join agendamentos a on a.id=sa.agendamento_id`)).rows).toEqual([{igual:true}]);
    expect((await pool.query('select origem,lido from noto_auditoria_comprovantes')).rows).toEqual([{origem:'autorizacao_whatsapp',lido:null}]);
    expect(await new PostgresFilaRepositorio(pool,true,true).buscarETravarProximoItem('geral')).toBeNull();
    expect(await new PostgresFilaRepositorio(pool,true,true,{...escopo,agendamentoId:randomUUID()}).buscarETravarProximoItem('outro')).toBeNull();
    const fila = new PostgresFilaRepositorio(pool,true,true,escopo);
    const item = await fila.buscarETravarProximoItem('piloto');
    expect(item).toMatchObject({medicoId:escopo.medicoId,emissaoComprovante:true});
    expect(await fila.iniciarEmissaoComprovante(item!.id)).toBe('iniciada');
    expect(await fila.buscarETravarProximoItem('piloto')).toBeNull();
    await pool.query(readFileSync(new URL('../scripts/migrations/20261111-noto-proposta-emissao-whatsapp.sql',import.meta.url),'utf8'));
    await pool.query(`
      alter table medicos add column nome_completo text;
      update medicos set nome_completo='Emitente Sintético';
      alter table medico_perfil_fiscal add column razao_social text, add column dados_reforma_tributaria jsonb;
      alter table medico_servicos_fiscais add column nome_servico text;
      update medico_servicos_fiscais set nome_servico='Consulta de teste';
      create table pacientes(id uuid primary key,medico_id uuid,nome text,nome_validado boolean);
    `);
    const escopoProposta={...escopo,agendamentoId:randomUUID()};
    await pool.query("insert into pacientes values ($1,$2,'Tomador Sintético',true)",[tomador,escopo.medicoId]);
    await pool.query("insert into agendamentos values ($1,$2,$3,$4,'tribemd','sintetico-2',now(),10000,true,'realizado')",
      [escopoProposta.agendamentoId,escopo.medicoId,tomador,servico]);
    const conversaRef='a'.repeat(64);
    const proposta=async(letra:string, resposta:string)=>{
      const texto:string[]=[];
      expect(await tratarPropostaEmissaoWhatsApp(pool!,escopoProposta,{
        contaId:escopo.contaId,texto:'Quero emitir uma nota',conversaRef,mensagemRef:letra.repeat(64)
      },async balão=>{texto.push(balão);return resposta.repeat(64);})).toBe('');
      expect(texto[0]).toContain('Emitente Sintético');
      expect(texto[0]).toContain('Tomador Sintético');
      expect(texto[0]).toContain('Consulta de teste');
      expect(texto[0]).toContain('100,00');
      expect(texto[0]).toContain('Competência');
    };
    const confirmar=async(citadaRef?:string, conversa=conversaRef, texto='Sim, pode emitir') =>
      tratarPropostaEmissaoWhatsApp(pool!,escopoProposta,{
        contaId:escopo.contaId,texto,conversaRef:conversa,citadaRef,mensagemRef:'f'.repeat(64)
      },async()=>{throw new Error('CONFIRMACAO_NAO_PUBLICA_PROPOSTA');});
    await proposta('b','c');
    expect(await confirmar()).toBeNull();
    expect(await confirmar('c'.repeat(64),'e'.repeat(64))).toBeNull();
    await pool.query("update public.noto_propostas_emissao_whatsapp set expira_em=now()-interval '1 second'");
    expect(await confirmar('c'.repeat(64))).toContain('não pode mais');
    await proposta('d','e');
    expect(await confirmar('e'.repeat(64),conversaRef,'Não')).toContain('encerrada');
    expect(await confirmar('e'.repeat(64))).toContain('não pode mais');
    await proposta('1','2');
    await pool.query("update medico_servicos_fiscais set nome_servico='Outro serviço'");
    expect(await confirmar('2'.repeat(64))).toContain('não pode mais');
    await pool.query("update medico_servicos_fiscais set nome_servico='Consulta de teste'");
    await proposta('3','4');
    expect(await confirmar('2'.repeat(64))).toContain('não pode mais');
    const respostas=await Promise.all([confirmar('4'.repeat(64)),confirmar('4'.repeat(64))]);
    expect(respostas.filter(texto=>texto?.includes('Registrei'))).toHaveLength(1);
    expect((await pool.query('select count(*)::int n from solicitacoes_nota')).rows[0].n).toBe(2);
    expect((await pool.query(`
      select p.pedido_ref,p.resposta_ref,a.mensagem_ref,p.confirmada_em is not null confirmada
      from noto_auditoria_comprovantes a join noto_propostas_emissao_whatsapp p on p.id=a.proposta_whatsapp_id
    `)).rows).toEqual([{pedido_ref:'3'.repeat(64),resposta_ref:'4'.repeat(64),mensagem_ref:'f'.repeat(64),confirmada:true}]);
  } finally {
    await pool?.end();
    await admin.query('drop database if exists '+nome);
    await admin.end();
  }
});
