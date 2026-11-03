import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';

const sql=readFileSync(fileURLToPath(new URL(
  '../scripts/migrations/20261105-cofre-links-por-conta.sql',import.meta.url)), 'utf8');
const dbUrl=process.env['NOTO_SCHEMA_TEST_DATABASE_URL'];
const testeBanco=dbUrl ? it : it.skip;

testeBanco('migração em PostgreSQL real: zero médicos, links conta/legado, FKs, exclusividade e RLS',async()=>{
  const admin=new pg.Client({connectionString:dbUrl});
  const nome='noto_cofre_'+randomBytes(5).toString('hex');
  let criado=false;
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE '+nome);
    criado=true;
    const url=new URL(dbUrl!);url.pathname='/'+nome;
    const banco=new pg.Client({connectionString:url.toString()});
    await banco.connect();
    try {
      await banco.query(`
        DO $$ BEGIN
          IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
          IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
          IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
        END $$;
        CREATE TABLE public.contas(id uuid PRIMARY KEY);
        CREATE TABLE public.medicos(id uuid PRIMARY KEY);
        CREATE TABLE public.cofre_links (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          medico_id uuid NOT NULL REFERENCES public.medicos(id) ON DELETE CASCADE,
          agenda text NOT NULL,
          token_hash text NOT NULL UNIQUE,
          expira_em timestamptz NOT NULL,
          usado_em timestamptz,
          criado_em timestamptz NOT NULL DEFAULT now(),
          destino_telefone text
        );
        CREATE TABLE public.cofre_links_auditoria (
          link_id uuid NOT NULL REFERENCES public.cofre_links(id) ON DELETE CASCADE,
          evento text NOT NULL,
          criado_em timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(link_id,evento)
        );
        INSERT INTO public.contas VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
        INSERT INTO public.contas VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
        INSERT INTO public.medicos VALUES ('11111111-1111-4111-8111-111111111111');
        INSERT INTO public.cofre_links(medico_id,agenda,token_hash,expira_em)
          VALUES ('11111111-1111-4111-8111-111111111111','tribemd','legado',now()+interval '15 minutes');
      `);
      await banco.query(sql);
      await banco.query(sql);
      const antes=await banco.query('select count(*)::int as n from public.medicos');
      expect(antes.rows[0].n).toBe(1);
      await banco.query(`
        insert into public.cofre_links(conta_id,medico_id,agenda,token_hash,expira_em)
        values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',null,'tribemd','nova-conta',now()+interval '15 minutes')
      `);
      const links=await banco.query('select medico_id,conta_id,token_hash from public.cofre_links order by token_hash');
      expect(links.rows).toHaveLength(2);
      expect(links.rows[0]).toMatchObject({token_hash:'legado',conta_id:null});
      expect(links.rows[1]).toMatchObject({token_hash:'nova-conta',medico_id:null,conta_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
      await expect(banco.query(`
        insert into public.cofre_links(medico_id,conta_id,agenda,token_hash,expira_em)
        values(null,null,'tribemd','sem-dono',now())`)).rejects.toThrow();
      await expect(banco.query(`
        insert into public.cofre_links(medico_id,conta_id,agenda,token_hash,expira_em)
        values('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','tribemd','dois-donos',now())`)).rejects.toThrow();
      await expect(banco.query(`
        insert into public.cofre_links(conta_id,agenda,token_hash,expira_em)
        values('cccccccc-cccc-4ccc-8ccc-cccccccccccc','tribemd','conta-inexistente',now())`)).rejects.toThrow();
      const rls=await banco.query(`
        select relname,relrowsecurity from pg_class
        where oid in ('public.cofre_links'::regclass,'public.cofre_links_auditoria'::regclass)
      `);
      expect(rls.rows).toHaveLength(2);
      expect(rls.rows.every((r:{relrowsecurity:boolean})=>r.relrowsecurity)).toBe(true);
      const grants=await banco.query(`
        select count(*)::int as total from information_schema.role_table_grants
        where table_schema='public' and table_name in ('cofre_links','cofre_links_auditoria')
          and grantee in ('anon','authenticated')
          and privilege_type in ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE')
      `);
      expect(grants.rows[0].total).toBe(0);
      const depois=await banco.query('select count(*)::int as n from public.medicos');
      expect(depois.rows[0].n).toBe(1);
      // Nenhuma operação administrativa cria/atribui médico na primeira conexão.
    } finally { await banco.end(); }
  } finally {
    if(criado) await admin.query('DROP DATABASE '+nome+' WITH (FORCE)');
    await admin.end();
  }
});
it('migração é apenas proposta, preserva conexão legada e nenhum seed de médico',()=>{
  expect(sql).toContain('ALTER COLUMN medico_id DROP NOT NULL');
  expect(sql).toContain('cofre_links_titular_exclusivo');
  expect(sql).toContain('REFERENCES public.contas(id)');
  expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
  expect(sql).toMatch(/REVOKE ALL/);
  expect(sql).not.toMatch(/insert\s+into\s+(?:public\.)?medicos/i);
});
