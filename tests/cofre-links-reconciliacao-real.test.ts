import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

// Mantem a migracao historica INTACTA no fixture: sem destino_telefone,
// com CHECK que originalmente nao aceita 'concluido'.
const sqlAntigo = readFileSync(fileURLToPath(new URL(
  '../scripts/migrations/20261020-cofre-links.sql', import.meta.url
)), 'utf8');
const sqlReconciliar = readFileSync(fileURLToPath(new URL(
  '../scripts/migrations/20261106-cofre-links-reconciliar-homologacao.sql', import.meta.url
)), 'utf8');
const sqlPorConta = readFileSync(fileURLToPath(new URL(
  '../scripts/migrations/20261105-cofre-links-por-conta.sql', import.meta.url
)), 'utf8');

const urlBanco = process.env['NOTO_SCHEMA_TEST_DATABASE_URL'];
const testeBanco = urlBanco ? it : it.skip;
const contaA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const contaB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const medicoA = '11111111-1111-4111-8111-111111111111';

async function bancoIsolado(executar: (banco: pg.Client) => Promise<void>) {
  const admin = new pg.Client({ connectionString: urlBanco });
  const nome = 'noto_cofre_reconcile_' + randomBytes(5).toString('hex');
  let criado = false;
  await admin.connect();
  try {
    // So usa postgres descartavel criado pelo job de CI, nunca Supabase.
    await admin.query('CREATE DATABASE ' + nome);
    criado = true;
    const url = new URL(urlBanco!);
    url.pathname = '/' + nome;
    const banco = new pg.Client({ connectionString: url.toString() });
    await banco.connect();
    try {
      // Papéis globais podem ja existir pelo teste de schema da mesma suite.
      await banco.query(`
        DO $ BEGIN
          PERFORM pg_advisory_xact_lock(76022026);
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
            CREATE ROLE anon; END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
            CREATE ROLE authenticated; END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
            CREATE ROLE service_role; END IF;
        END $$;
        CREATE TABLE public.contas (id uuid PRIMARY KEY);
        CREATE TABLE public.medicos (id uuid PRIMARY KEY, conta_id uuid REFERENCES public.contas(id));
        INSERT INTO public.contas (id) VALUES
          ('${contaA}'),('${contaB}');
      `);
      await executar(banco);
    } finally { await banco.end(); }
  } finally {
    if (criado) await admin.query('DROP DATABASE ' + nome + ' WITH (FORCE)');
    await admin.end();
  }
}

async function exigirProtecoes(banco: pg.Client) {
  const tabelas = await banco.query(`
    SELECT relname, relrowsecurity
    FROM pg_class
    WHERE oid IN ('public.cofre_links'::regclass,
                  'public.cofre_links_auditoria'::regclass)
  `);
  expect(tabelas.rows).toHaveLength(2);
  expect(tabelas.rows.every((r: {relrowsecurity: boolean}) => r.relrowsecurity)).toBe(true);
  for (const nome of ['cofre_links','cofre_links_auditoria']) {
    for (const rol of ['anon','authenticated']) {
      for (const acao of ['SELECT','INSERT','UPDATE','DELETE']) {
        const permissao = await banco.query(
          'select has_table_privilege($1,$2,$3) as permitido',
          [rol, 'public.'+nome, acao]);
        expect(permissao.rows[0].permitido, nome+' '+rol+' '+acao).toBe(false);
      }
    }
    for (const acao of ['SELECT','INSERT','UPDATE','DELETE']) {
      const permissao = await banco.query(
        'select has_table_privilege($1,$2,$3) as permitido',
        ['service_role','public.'+nome,acao]);
      expect(permissao.rows[0].permitido, 'backend '+nome+' '+acao).toBe(true);
    }
  }
  await banco.query('SET ROLE authenticated');
  try {
    await expect(banco.query('select id from public.cofre_links limit 1'))
      .rejects.toThrow(/permission denied/i);
  } finally {
    await banco.query('RESET ROLE');
  }
}
async function titularExclusivo(banco: pg.Client) {
  await expect(banco.query(`
    INSERT INTO public.cofre_links
      (agenda,token_hash,expira_em)
    VALUES ('tribemd','sem-dono',now()+interval '15 minutes')
  `)).rejects.toThrow();
  await expect(banco.query(`
    INSERT INTO public.cofre_links
      (medico_id,conta_id,agenda,token_hash,expira_em)
    VALUES ($1,$2,'tribemd','duplo-dono',now()+interval '15 minutes')
  `,[medicoA,contaA])).rejects.toThrow();
  await expect(banco.query(`
    INSERT INTO public.cofre_links
      (conta_id,agenda,token_hash,expira_em)
    VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','tribemd','conta-inexistente',now())
  `)).rejects.toThrow();
}

describe('Cofre: migracao real sem fixture artificial', () => {
  it('o arquivo antigo historico continua sem os campos novos e impede concluido', () => {
    expect(sqlAntigo).not.toMatch(/destino_telefone|conta_id/);
    expect(sqlAntigo).toMatch(/evento in \('criado', 'aberto', 'enviado', 'expirado'\)/i);
    expect(sqlAntigo).not.toMatch(/'concluido'/);
  });

  testeBanco('criacao do zero: tabelas ausentes -> esquema completo, RLS, backend, reexecucao', async () => {
    await bancoIsolado(async banco => {
      // A conta nasce sem QUALQUER linha em medicos e sem tabelas Cofre.
      expect((await banco.query('select count(*)::int n from medicos')).rows[0].n).toBe(0);
      expect((await banco.query(`
        select to_regclass('public.cofre_links') as links,
               to_regclass('public.cofre_links_auditoria') as auditoria
      `)).rows[0]).toEqual({links:null,auditoria:null});

      await banco.query(sqlReconciliar);
      await banco.query(`
        INSERT INTO public.cofre_links
          (conta_id,agenda,token_hash,expira_em,destino_telefone)
        VALUES ($1,'tribemd','token-conta',now()+interval '15 minutes','5551999998888')
      `,[contaA]);
      const link = (await banco.query(
        "select id,medico_id,conta_id,destino_telefone from public.cofre_links where token_hash='token-conta'"
      )).rows[0];
      expect(link).toMatchObject({
        medico_id:null,conta_id:contaA,destino_telefone:'5551999998888'
      });
      for (const evento of ['criado','aberto','enviado','expirado','concluido']) {
        await banco.query(
          'insert into public.cofre_links_auditoria(link_id,evento) values($1,$2)',
          [link.id,evento]);
      }
      await expect(banco.query(
        "insert into public.cofre_links_auditoria(link_id,evento) values($1,'concluido')",
        [link.id]
      )).rejects.toThrow(); // PK idempotencia por evento
      const antes = (await banco.query(
        'select evento, criado_em from public.cofre_links_auditoria order by evento'
      )).rows;
      const colunas = await banco.query(`
        select column_name,data_type from information_schema.columns
        where table_schema='public' and table_name='cofre_links'
          and column_name in ('conta_id','destino_telefone')
        order by column_name
      `);
      expect(colunas.rows.map((r:{column_name:string})=>r.column_name))
        .toEqual(['conta_id','destino_telefone']);
      expect((await banco.query('select count(*)::int n from medicos')).rows[0].n).toBe(0);
      await exigirProtecoes(banco);
      await titularExclusivo(banco);
      await banco.query(sqlReconciliar);
      expect((await banco.query(
        'select evento, criado_em from public.cofre_links_auditoria order by evento'
      )).rows).toEqual(antes);
      expect((await banco.query(
        "select conta_id,destino_telefone from cofre_links where token_hash='token-conta'"
      )).rows[0]).toEqual({conta_id:contaA,destino_telefone:'5551999998888'});
      await exigirProtecoes(banco);

      // 20261105 anterior continua aplicavel se o operador estiver em rollout
      // de scripts ordenados; nao e necessario executar novamente em homologacao.
      await banco.query(sqlPorConta);
      await banco.query(sqlReconciliar);
      await exigirProtecoes(banco);
    });
  });

  testeBanco('SQL 20261020 literal + dados reais -> reparacao sem perder links/auditoria; old API e new API', async () => {
    await bancoIsolado(async banco => {
      await banco.query('insert into medicos(id,conta_id) values($1,$2)',[medicoA,contaA]);
      await banco.query(sqlAntigo); // Sem adicionar campos e sem remover CHECK!
      await banco.query(`
        INSERT INTO public.cofre_links
          (medico_id,agenda,token_hash,expira_em,usado_em,criado_em)
        VALUES ($1,'tribemd','legado-conectado',
          now()+interval '2 hours',now(),now()-interval '1 hour')
      `,[medicoA]);
      const antigo = (await banco.query(
        "select * from public.cofre_links where token_hash='legado-conectado'"
      )).rows[0];
      await banco.query(`
        insert into public.cofre_links_auditoria(link_id,evento)
        values($1,'criado'),($1,'enviado')
      `,[antigo.id]);
      const auditoriaAntiga = (await banco.query(
        'select * from public.cofre_links_auditoria order by evento'
      )).rows;
      expect((await banco.query(`
        select count(*)::int as n from information_schema.columns
        where table_name='cofre_links' and column_name='destino_telefone'
      `)).rows[0].n).toBe(0);
      await expect(banco.query(
        "insert into public.cofre_links_auditoria(link_id,evento) values($1,'concluido')",
        [antigo.id]
      )).rejects.toThrow(); // falha da antiga migration reproduzida!

      await banco.query(sqlReconciliar);
      await banco.query(sqlReconciliar);
      const reparado = (await banco.query(
        "select * from public.cofre_links where token_hash='legado-conectado'"
      )).rows[0];
      expect(reparado).toMatchObject({...antigo,conta_id:null,destino_telefone:null});
      expect((await banco.query(
        "select link_id,evento,criado_em from public.cofre_links_auditoria where link_id=$1 order by evento",
        [antigo.id]
      )).rows).toEqual(auditoriaAntiga.map(({link_id,evento,criado_em})=>({link_id,evento,criado_em})));
      // Evento do codigo anterior (20261020 nao aceitava concluido) agora funciona.
      await banco.query(
        "insert into public.cofre_links_auditoria(link_id,evento) values($1,'concluido')",
        [antigo.id]
      );
      const eventoConcluido=(await banco.query(
        "select count(*)::int n from cofre_links_auditoria where link_id=$1 and evento='concluido'",
        [antigo.id]
      )).rows[0].n;
      expect(eventoConcluido).toBe(1);
      // Contrato do codigo antigo: medico_id continua funcionando e destino
      // do WhatsApp pode ser registrado sem exigir conta_id.
      await banco.query(`
        insert into public.cofre_links
          (medico_id,agenda,token_hash,expira_em,criado_em,destino_telefone)
        values ($1,'amplimed','medico-antigo',now()+interval '15 minutes',now(),'5551991112222')
      `,[medicoA]);
      const legadoConsumido = (await banco.query(`
        update cofre_links set usado_em=now()
        where token_hash='medico-antigo' and usado_em is null and expira_em>now()
        returning medico_id,id,agenda,destino_telefone
      `)).rows[0];
      expect(legadoConsumido).toMatchObject({
        medico_id:medicoA,agenda:'amplimed',destino_telefone:'5551991112222'
      });
      // Contrato novo: dono e a conta, sem identidade clinica.
      await banco.query(`
        insert into cofre_links(conta_id,agenda,token_hash,expira_em,destino_telefone)
        values ($1,'tribemd','conta-nova',now()+interval '15 minutes','5551993334444')
      `,[contaB]);
      expect((await banco.query(
        "select medico_id,conta_id from cofre_links where token_hash='conta-nova'"
      )).rows[0]).toEqual({medico_id:null,conta_id:contaB});
      await exigirProtecoes(banco);
      await titularExclusivo(banco);
      const contagem = (await banco.query(
        'select count(*)::int n from cofre_links'
      )).rows[0].n;
      await banco.query(sqlReconciliar);
      expect((await banco.query('select count(*)::int n from cofre_links')).rows[0].n)
        .toBe(contagem);
      expect((await banco.query(
        "select count(*)::int n from cofre_links_auditoria where evento='concluido'"
      )).rows[0].n).toBe(1);
    });
  });

  testeBanco('esquema existente incompatível falha com rollback sem alterar dados', async () => {
    await bancoIsolado(async banco => {
      await banco.query(`
        CREATE TABLE public.cofre_links (
          id uuid primary key default gen_random_uuid(),
          medico_id uuid not null references public.medicos(id),
          agenda text not null,token_hash integer not null,
          expira_em timestamptz not null,usado_em timestamptz,
          criado_em timestamptz not null default now()
        )
      `);
      await expect(banco.query(sqlReconciliar))
        .rejects.toThrow(/COFRE_COLUNA_INCOMPATIVEL|COFRE_TOKEN_UNIQUE_AUSENTE/);
      // O SQL inicia BEGIN; em erro real o cliente precisa encerrar a
      // transacao abortada. So depois verificamos o rollback integral.
      await banco.query('ROLLBACK');
      const check = await banco.query(`
        select count(*)::int n from information_schema.columns
        where table_name='cofre_links' and column_name in ('conta_id','destino_telefone')
      `);
      expect(check.rows[0].n).toBe(0); // rollback de TODA a reconciliacao
      expect((await banco.query(
        "select to_regclass('public.cofre_links_auditoria') as tabela"
      )).rows[0].tabela).toBeNull();
    });
  });
});
