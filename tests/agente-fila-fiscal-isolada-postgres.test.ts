import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { PostgresFilaRepositorio } from '../src/io/postgres/postgres-fila-repositorio.js';

const url = process.env['NOTO_SCHEMA_TEST_DATABASE_URL'];
it.runIf(Boolean(url))('reserva só WhatsApp do emitente e da conta permitidos', async () => {
  const conexao = new URL(url!);
  if (!['127.0.0.1', 'localhost'].includes(conexao.hostname)) {
    throw new Error('O teste exige PostgreSQL descartável local.');
  }
  const nomeBanco = 'noto_fila_fiscal_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  let pool: pg.Pool | undefined;
  try {
    await admin.query('create database ' + nomeBanco);
    conexao.pathname = '/' + nomeBanco;
    pool = new pg.Pool({ connectionString: conexao.toString() });
    await pool.query(`
      create table medicos (id uuid primary key, conta_id uuid not null);
      create table medico_perfil_fiscal (medico_id uuid primary key, ambiente text not null);
      create table solicitacoes_nota (
        id uuid primary key, medico_id uuid not null, origem text not null, fila text default 'pronta',
        status text default 'pronta', criado_em timestamptz default now(),
        paciente_id uuid, xdesc_serv text, valor_servico_centavos int,
        ctrib_nac text, cnbs text, cclass_trib text, cind_op text, tentativas int default 0,
        aguardando_dados_profissionais boolean default false, aguardando_confirmacao_medico boolean default false,
        aguardando_cpf_medico boolean default false, proxima_tentativa_em timestamptz,
        bloqueada_em timestamptz, bloqueada_por_worker text
      );
      create table noto_emissoes_comprovantes (
        solicitacao_id uuid primary key, medico_id uuid not null, estado text, atualizado_em timestamptz
      );
    `);
    const contaId = randomUUID(), medicoId = randomUUID(), outroMedico = randomUUID();
    const api = randomUUID(), externo = randomUUID(), permitido = randomUUID();
    await pool.query('insert into medicos values ($1,$2),($3,$4)', [medicoId, contaId, outroMedico, randomUUID()]);
    await pool.query("insert into medico_perfil_fiscal values ($1,'homologacao'),($2,'homologacao')", [medicoId, outroMedico]);
    await pool.query(`insert into solicitacoes_nota (id, medico_id, origem) values
      ($1,$4,'api'),($2,$5,'whatsapp'),($3,$4,'whatsapp')`, [api, externo, permitido, medicoId, outroMedico]);
    await pool.query("insert into noto_emissoes_comprovantes values ($1,$3,'enfileirada',now()),($2,$4,'enfileirada',now())",
      [externo, permitido, outroMedico, medicoId]);
    const repo = new PostgresFilaRepositorio(pool, true, true, { contaId, medicoId });
    expect(await repo.buscarETravarProximoItem('isolado')).toMatchObject({ id: permitido, medicoId, emissaoComprovante: true });
    expect(await repo.buscarETravarProximoItem('isolado')).toBeNull();
    expect(await repo.iniciarEmissaoComprovante(externo)).toBe('ocupada');
    expect(await repo.iniciarEmissaoComprovante(permitido)).toBe('iniciada');
    const { rows } = await pool.query('select id from solicitacoes_nota where bloqueada_em is not null');
    expect(rows).toEqual([{ id: permitido }]);
  } finally {
    await pool?.end();
    await admin.query('drop database if exists ' + nomeBanco);
    await admin.end();
  }
});
