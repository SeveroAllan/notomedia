import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';
import { consultarStatusOnboarding } from '../src/onboarding/io/consultar-status-onboarding.js';
import { codigoSeguroFalhaReady } from '../src/http/diagnostico-ready.js';

const sql = readFileSync(fileURLToPath(new URL(
  '../scripts/migrations/20261101-homologacao-onboarding-schema-reconcile.sql',
  import.meta.url
)), 'utf8');

it('diagnostico de readiness nunca mostra mensagens ou credenciais', () => {
  expect(codigoSeguroFalhaReady({ code: '42703', message: 'postgres://usuario:senha@banco' })).toBe('42703');
  expect(codigoSeguroFalhaReady({ code: 'ECONNREFUSED', message: 'host privado' })).toBe('ECONNREFUSED');
  expect(codigoSeguroFalhaReady({ code: 'senha:secreta', message: 'secreta' })).toBe('INDEFINIDO');
  expect(codigoSeguroFalhaReady(new Error('postgres://usuario:senha@banco'))).toBe('INDEFINIDO');
});

const testarBanco = process.env['NOTO_SCHEMA_TEST_DATABASE_URL'] ? it : it.skip;
testarBanco('migração reconcilia estado mínimo do Supabase novo, sem inferir dados fiscais, e é reaplicável', async () => {
  const client = new pg.Client({ connectionString: process.env['NOTO_SCHEMA_TEST_DATABASE_URL'] });
  await client.connect();
  try {
    // Banco descartável do CI, nunca banco externo ou Supabase real.
    await client.query(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE TABLE public.usuarios (
        id uuid PRIMARY KEY, nome text, telefone text, email text, ativo boolean DEFAULT true
      );
      CREATE TABLE public.medicos (
        id uuid PRIMARY KEY, usuario_id uuid REFERENCES public.usuarios(id),
        nome_completo text NOT NULL, crm text, rqe text, especialidade text
      );
      CREATE TABLE public.medico_certificados (
        id uuid PRIMARY KEY, medico_id uuid REFERENCES public.medicos(id),
        status text, criado_em timestamptz DEFAULT now()
      );
      CREATE TABLE public.medico_perfil_fiscal (
        medico_id uuid PRIMARY KEY REFERENCES public.medicos(id),
        razao_social text, inscricao_municipal text, uf char(2),
        cod_municipio_ibge char(7), confirmado_pelo_medico boolean NOT NULL DEFAULT false
      );
      CREATE TABLE public.medico_servicos_fiscais (
        id uuid PRIMARY KEY, medico_id uuid REFERENCES public.medicos(id),
        padrao boolean NOT NULL DEFAULT false, ativo boolean NOT NULL DEFAULT true
      );
      CREATE TABLE public.whatsapp_instancias (
        id uuid PRIMARY KEY, medico_id uuid REFERENCES public.medicos(id),
        numero_telefone text, nome_instancia text, oficial boolean DEFAULT false,
        status text, conectado_em timestamptz
      );
      INSERT INTO public.usuarios (id,nome,telefone,ativo)
      VALUES ('00000000-0000-4000-8000-000000000010','Pessoa de Teste','5511999990000',true);
      INSERT INTO public.medicos (id,usuario_id,nome_completo)
      VALUES ('00000000-0000-4000-8000-000000000011',
              '00000000-0000-4000-8000-000000000010','Pessoa de Teste');
    `);

    await client.query(sql);
    await client.query(sql); // segunda execução: valida colunas, índices e constraints já existentes

    const perfil = await client.query(`
      SELECT m.solicitar_cpf_direto_paciente, pf.proximo_numero_dps,
        pf.serie_dps, pf.opcao_simples_nacional, pf.extraido_automaticamente,
        pf.dados_reforma_tributaria, msf.aliquota_iss, msf.parametros_emissao
      FROM public.medicos m
      LEFT JOIN public.medico_perfil_fiscal pf ON pf.medico_id=m.id
      LEFT JOIN public.medico_servicos_fiscais msf ON msf.medico_id=m.id
      LIMIT 1
    `);
    expect(perfil.rows[0]).toMatchObject({
      solicitar_cpf_direto_paciente: false, proximo_numero_dps: null,
      serie_dps: null, opcao_simples_nacional: null,
      extraido_automaticamente: null, dados_reforma_tributaria: null,
      aliquota_iss: null, parametros_emissao: null
    });
    const estado = await consultarStatusOnboarding(client as unknown as pg.Pool,
      '00000000-0000-4000-8000-000000000011');
    expect(estado.liberadoParaEmitir).toBe(false);
    expect(estado.passos.passo4WhatsappConectado).toBe(false);
    expect(estado.perfilFiscal).toBeNull();
    expect(estado.solicitarCpfDiretoPaciente).toBe(false);

    const v = await client.query(`
      SELECT c.table_name,c.column_name,c.column_default
      FROM information_schema.columns c
      WHERE c.table_schema='public' AND (
        (c.table_name='medico_servicos_fiscais'
          AND c.column_name IN ('aliquota_iss','parametros_emissao'))
        OR (c.table_name='medico_perfil_fiscal'
          AND c.column_name IN ('proximo_numero_dps','serie_dps','opcao_simples_nacional','dados_reforma_tributaria'))
      )
    `);
    expect(v.rows).toHaveLength(6);
    expect(v.rows.every((r: { column_default: string | null }) => r.column_default === null)).toBe(true);
    const rls = await client.query(`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE oid IN ('public.cadastro_certificado_trabalhos'::regclass,
                    'public.cadastro_certificado_avisos'::regclass,
                    'public.cadastro_certificado_respostas'::regclass)
    `);
    expect(rls.rows).toHaveLength(3);
    expect(rls.rows.every((r: { relrowsecurity: boolean }) => r.relrowsecurity)).toBe(true);
    const grants = await client.query(`
      SELECT count(*)::integer AS total
      FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name LIKE 'cadastro_certificado_%'
        AND grantee IN ('anon','authenticated') AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')
    `);
    expect(grants.rows[0].total).toBe(0);
    await client.query('ALTER TABLE public.medico_perfil_fiscal ALTER COLUMN serie_dps TYPE bigint USING NULL');
    await expect(client.query(sql)).rejects.toThrow(/ONBOARDING_COLUNA_INCOMPATIVEL/);
  } finally {
    await client.end();
  }
});
