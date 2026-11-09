import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';
import { registrarConsentimentoFiscal } from '../src/onboarding/fluxos/consentimento-fiscal.js';
import { consultarStatusOnboarding } from '../src/onboarding/io/consultar-status-onboarding.js';
import { codigoSeguroFalhaReady } from '../src/http/diagnostico-ready.js';
import { enviarBoasVindasAposPareamento } from '../src/agente/boas-vindas-pareamento.js';
import { reservarMensagemConversa, registrarBalaoConversa, finalizarMensagemConversa, salvarEstadoConversa, lerEstadoConversa } from '../src/agente/estado-conversa.js';

const sql = readFileSync(fileURLToPath(new URL(
  '../scripts/migrations/20261101-homologacao-onboarding-schema-reconcile.sql',
  import.meta.url
)), 'utf8');

const fiscal = readFileSync(new URL('../scripts/migrations/noto-intelligence-02-fiscal-protegido.sql', import.meta.url), 'utf8');
const auditoria = fiscal.slice(fiscal.indexOf('CREATE TABLE public.auditoria'), fiscal.indexOf('CREATE INDEX auditoria_conta'));

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
      -- Papeis sao globais no cluster de CI; os testes paralelos nao
      -- podem disputar CREATE ROLE nem reaplicar grants com fixtures falsas.
      DO $$ BEGIN
        PERFORM pg_advisory_xact_lock(76022026);
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
          CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
          CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
          CREATE ROLE service_role; END IF;
      END $$;
      CREATE TABLE public.contas (id uuid PRIMARY KEY);
      CREATE TABLE public.usuarios (
        id uuid PRIMARY KEY, nome text, telefone text, email text, ativo boolean DEFAULT true
      );
      ${auditoria}
      CREATE TABLE public.medicos (
        id uuid PRIMARY KEY, usuario_id uuid REFERENCES public.usuarios(id),
        nome_completo text NOT NULL, crm text, rqe text, especialidade text
      );
      CREATE TABLE public.medico_certificados (
        id uuid PRIMARY KEY, medico_id uuid REFERENCES public.medicos(id),
        status text, valido_de date, valido_ate date NOT NULL,
        criado_em timestamptz DEFAULT now()
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

const sqlBoasVindas = readFileSync(fileURLToPath(new URL(
  '../scripts/migrations/20261102-boas-vindas-pareamento-idempotente.sql',
  import.meta.url
)), 'utf8');

testarBanco('boas-vindas: aplica migration duas vezes e disputa atomicamente no PostgreSQL sem privilegios publicos', async () => {
  const url = process.env['NOTO_SCHEMA_TEST_DATABASE_URL']!;
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  try {
    await pool.query(`
      ALTER TABLE public.usuarios ADD COLUMN conta_id uuid REFERENCES public.contas(id);
      ALTER TABLE public.usuarios ADD COLUMN auth_user_id uuid;
      ALTER TABLE public.medicos ADD COLUMN conta_id uuid REFERENCES public.contas(id);
      ALTER TABLE public.whatsapp_instancias ADD COLUMN conta_id uuid REFERENCES public.contas(id);
      INSERT INTO public.contas(id) VALUES ('00000000-0000-4000-8000-000000000001');
      UPDATE public.usuarios SET conta_id = '00000000-0000-4000-8000-000000000001',
        auth_user_id='00000000-0000-4000-8000-000000000020'
        WHERE id='00000000-0000-4000-8000-000000000010';
      UPDATE public.medicos SET conta_id='00000000-0000-4000-8000-000000000001'
        WHERE id='00000000-0000-4000-8000-000000000011';
      INSERT INTO public.whatsapp_instancias (
        id, medico_id, conta_id, nome_instancia, oficial, status, conectado_em
      ) VALUES (
        '00000000-0000-4000-8000-000000000030',
        '00000000-0000-4000-8000-000000000011',
        '00000000-0000-4000-8000-000000000001',
        'medico_000000000000', false, 'conectado', now()
      );
    `);
    // Mesmo caso do Cofre/agenda: médico da conta sem usuario_id legado.
    const alice='00000000-0000-4000-8000-000000000099';
    await pool.query("insert into medicos(id,conta_id,nome_completo) values($1,'00000000-0000-4000-8000-000000000001','Alice Castro Menezes Xavier')",[alice]);
    const porConta=await consultarStatusOnboarding(pool,alice);
    expect(porConta).toMatchObject({medicoId:alice,usuarioId:null,nomeUsuario:'Alice Castro Menezes Xavier',
      crm:null,rqe:null,liberadoParaEmitir:false,passos:{passo3CertificadoValido:false,passoProfissionalAprovado:false}});
    const certificado='00000000-0000-4000-8000-000000000098';
    await pool.query(`insert into medico_certificados (id,medico_id,status,valido_de,valido_ate)
      values ($1,$2,'ativo',current_date-1,current_date+1)`,[certificado,alice]);
    const prontidao=async()=>(await consultarStatusOnboarding(pool,alice)).passos.passo3CertificadoValido;
    expect(await prontidao()).toBe(false);
    await registrarConsentimentoFiscal(pool,alice,certificado,'00000000-0000-4000-8000-000000000010');
    // Este fixture não possui A1 ou prova de titularidade: o passo mede consentimento e vigência.
    expect(await prontidao()).toBe(true);
    await pool.query("delete from auditoria where dados->>'certificadoId'=$1",[certificado]);
    await pool.query('delete from medico_certificados where id=$1',[certificado]);
    await pool.query('delete from medicos where id=$1',[alice]);
    await pool.query(sqlBoasVindas);
    await pool.query(sqlBoasVindas);

    const concessoes = await pool.query(`
      SELECT has_table_privilege('anon','public.noto_boas_vindas_pareamento','SELECT') AS anon_le,
        has_table_privilege('authenticated','public.noto_boas_vindas_pareamento','SELECT') AS autenticado_le,
        has_table_privilege('service_role','public.noto_boas_vindas_pareamento','SELECT') AS backend_le,
        has_table_privilege('service_role','public.noto_boas_vindas_pareamento','INSERT') AS backend_grava,
        (SELECT relrowsecurity FROM pg_class
          WHERE oid='public.noto_boas_vindas_pareamento'::regclass) AS rls
    `);
    expect(concessoes.rows[0]).toMatchObject({
      anon_le: false, autenticado_le: false,
      backend_le: true, backend_grava: true, rls: true
    });

    const enviar = async (_telefone: string, _texto: string) => {
      enviados++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return true;
    };
    let enviados = 0;
    const deps = {
      pool, ativo: true, nomeInstancia: 'medico_000000000000',
      allowlist: ['5511999990000'], enviar
    };
    const resultados = await Promise.all(Array.from({ length: 10 },
      () => enviarBoasVindasAposPareamento(deps)));
    expect(resultados.filter(Boolean)).toHaveLength(1);
    expect(enviados).toBe(1);
    expect(await enviarBoasVindasAposPareamento(deps)).toBe(false);
    const estado = await pool.query('select estado, enviado_em is not null as confirmado from noto_boas_vindas_pareamento');
    expect(estado.rows).toEqual([{ estado: 'enviada', confirmado: true }]);
    const fiscal = await pool.query('select count(*)::integer as total from medico_perfil_fiscal');
    expect(fiscal.rows[0].total).toBe(0);
  } finally {
    await pool.end();
  }
});


const sqlConversa = readFileSync(fileURLToPath(new URL(
  '../scripts/migrations/20261104-noto-conversa-minima.sql', import.meta.url
)), 'utf8');

testarBanco('conversa: migra duas vezes, restringe grants e deduplica balões entre réplicas', async () => {
  const pool = new pg.Pool({connectionString:process.env['NOTO_SCHEMA_TEST_DATABASE_URL'],max:8});
  try {
    await pool.query(sqlConversa);
    await pool.query(sqlConversa);
    const acesso=await pool.query(
      "select has_table_privilege('anon','noto_agent_conversas','SELECT') as cliente, has_table_privilege('authenticated','noto_agent_mensagens','INSERT') as grava_cliente, has_table_privilege('service_role','noto_agent_mensagens','INSERT') as grava_backend, (select relrowsecurity from pg_class where oid='noto_agent_conversas'::regclass) as rls"
    );
    expect(acesso.rows[0]).toEqual({cliente:false,grava_cliente:false,grava_backend:true,rls:true});
    const contaId='00000000-0000-4000-8000-000000000001';
    const resultados=await Promise.all(Array.from({length:20},()=>reservarMensagemConversa(pool,contaId,'assistente','BAE569F0E38F858D')));
    expect(resultados.filter(Boolean)).toHaveLength(1);
    await salvarEstadoConversa(pool,contaId,{agendaEscolhida:'amplimed',perguntaPendente:'profissional'});
    expect(await lerEstadoConversa(pool,contaId)).toEqual({agendaEscolhida:'amplimed',perguntaPendente:'profissional'});
    await registrarBalaoConversa(pool,contaId,'assistente','BAE569F0E38F858D');
    await finalizarMensagemConversa(pool,contaId,'assistente','BAE569F0E38F858D',false);
    const r=await pool.query('select estado,baloes_confirmados from noto_agent_mensagens');
    expect(r.rows).toEqual([{estado:'incerta',baloes_confirmados:1}]);
    expect(await reservarMensagemConversa(pool,contaId,'assistente','BAE569F0E38F858D')).toBe(false);
    const fiscal=await pool.query('select count(*)::integer as total from medico_perfil_fiscal');
    expect(fiscal.rows[0].total).toBe(0);
  } finally {
    await pool.end();
  }
});
