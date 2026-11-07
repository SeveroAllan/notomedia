import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import { autorizarEmissaoWhatsApp } from '../src/io/postgres/postgres-emissao-whatsapp-repositorio.js';
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
    expect((await pool.query('select origem,lido from noto_auditoria_comprovantes')).rows).toEqual([{origem:'autorizacao_whatsapp',lido:null}]);
    expect(await new PostgresFilaRepositorio(pool,true,true).buscarETravarProximoItem('geral')).toBeNull();
    expect(await new PostgresFilaRepositorio(pool,true,true,{...escopo,agendamentoId:randomUUID()}).buscarETravarProximoItem('outro')).toBeNull();
    const fila = new PostgresFilaRepositorio(pool,true,true,escopo);
    const item = await fila.buscarETravarProximoItem('piloto');
    expect(item).toMatchObject({medicoId:escopo.medicoId,emissaoComprovante:true});
    expect(await fila.iniciarEmissaoComprovante(item!.id)).toBe('iniciada');
    expect(await fila.buscarETravarProximoItem('piloto')).toBeNull();
  } finally {
    await pool?.end();
    await admin.query('drop database if exists '+nome);
    await admin.end();
  }
});
