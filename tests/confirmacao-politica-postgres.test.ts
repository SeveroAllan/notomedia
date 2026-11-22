import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import { confirmarPoliticaEmissao } from '../src/onboarding/io/confirmar-politica-emissao.js';

const url = process.env['NOTO_SCHEMA_TEST_DATABASE_URL'];
it.skipIf(!url)('confirma a política e audita o antes e depois no schema vigente', async () => {
  const destino = new URL(url!);
  if (!['localhost', '127.0.0.1'].includes(destino.hostname)) throw new Error('POSTGRES_DESCARTAVEL_EXIGIDO');
  const nome = 'noto_politica_' + randomUUID().replace(/-/g, '');
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query('create database ' + nome);
  destino.pathname = '/' + nome;
  const pool = new pg.Pool({ connectionString: destino.toString() });
  try {
    const schema = readFileSync('scripts/migrations/noto-intelligence-02-fiscal-protegido.sql', 'utf8');
    await pool.query(`
      create table contas(id uuid primary key);
      create table usuarios(id uuid primary key);
      create table medicos(id uuid primary key, conta_id uuid references contas(id));
      create table medico_perfil_fiscal(
        medico_id uuid primary key references medicos(id), cod_municipio_ibge text, serie_dps text,
        xml_nota_referencia_url text, dados_reforma_tributaria jsonb, confirmado_pelo_medico boolean default false,
        ambiente text, proximo_numero_dps integer, opcao_simples_nacional text, regime_apuracao_sn text,
        regime_especial_tributacao integer, percentual_tot_trib_sn numeric, atualizado_em timestamptz
      );
      create table medico_servicos_fiscais(
        id uuid primary key, medico_id uuid references medicos(id), ctrib_nac text, cnbs text, ctrib_mun text,
        parametros_emissao jsonb, padrao boolean, ativo boolean
      );
      ${schema.slice(schema.indexOf('CREATE TABLE public.auditoria'), schema.indexOf('CREATE INDEX auditoria_conta'))}
    `);
    const conta = randomUUID(), medicoId = randomUUID(), servicoId = randomUUID();
    const antes = { origem: 'politica_anterior', parametros: { percentualTotTribSN: 5 } };
    const parametros = {
      ambiente: 'homologacao', vigenciaInicio: '2026-01-01', municipioPrestacao: '4205407',
      opcaoSimplesNacional: 'me_epp', regimeApuracaoSn: 'regime_1', regimeEspecialTributacao: 0,
      tribISSQN: 1, tpRetISSQN: 1, cstPisCofins: '08', percentualTotTribSN: 6
    };
    await pool.query('insert into contas values ($1)', [conta]);
    await pool.query('insert into medicos values ($1, $2)', [medicoId, conta]);
    await pool.query(`insert into medico_perfil_fiscal (medico_id, cod_municipio_ibge, serie_dps, dados_reforma_tributaria)
      values ($1, '4205407', '00001', '{"versao":1}')`, [medicoId]);
    await pool.query(`insert into medico_servicos_fiscais (id, medico_id, ctrib_nac, parametros_emissao, padrao, ativo)
      values ($1, $2, '040101', $3, true, true)`, [servicoId, medicoId, antes]);

    await confirmarPoliticaEmissao(pool, { medicoId, parametrosEmissao: parametros }, conta);

    const { rows: [perfil] } = await pool.query('select confirmado_pelo_medico from medico_perfil_fiscal where medico_id = $1', [medicoId]);
    const { rows: [servico] } = await pool.query('select parametros_emissao from medico_servicos_fiscais where id = $1', [servicoId]);
    expect(perfil.confirmado_pelo_medico).toBe(true);
    expect(servico.parametros_emissao).toMatchObject({ parametros });
    expect((await pool.query('select conta_id, usuario_id, evento, dados from auditoria')).rows).toEqual([{
      conta_id: conta, usuario_id: null, evento: 'confirmar_parametros_emissao',
      dados: { servicoId, medicoId, antes, depois: servico.parametros_emissao }
    }]);
  } finally {
    await pool.end();
    await admin.query('drop database ' + nome);
    await admin.end();
  }
});
