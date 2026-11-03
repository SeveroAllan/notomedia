import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {expect,it} from 'vitest';
const load=(name:string)=>readFileSync(fileURLToPath(new URL('../scripts/migrations/'+name,import.meta.url)),'utf8');
const bootstrap=load('20261104-cofre-links-bootstrap.sql');
const upgrade=load('20261105-cofre-links-por-conta.sql');
const legacy=load('20261020-cofre-links.sql');
const dbUrl=process.env['NOTO_SCHEMA_TEST_DATABASE_URL'];
(dbUrl?it:it.skip)('banco sem tabelas: bootstrap e upgrade, reaplicação, segurança e compatibilidade',async()=>{
 const admin=new pg.Client({connectionString:dbUrl});const name='noto_cofre_empty_'+randomBytes(5).toString('hex');
 let created=false;await admin.connect();
 try {
  await admin.query('CREATE DATABASE '+name);created=true;
  const u=new URL(dbUrl!);u.pathname='/'+name;
  const c=new pg.Client({connectionString:u.toString()});await c.connect();
  try {
   await c.query(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
   END $$;
   CREATE TABLE public.contas(id uuid PRIMARY KEY);
   CREATE TABLE public.medicos(id uuid PRIMARY KEY);
   INSERT INTO public.contas VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
   INSERT INTO public.medicos VALUES('11111111-1111-4111-8111-111111111111');`);
   expect((await c.query(`select to_regclass('public.cofre_links') as links`)).rows[0].links).toBeNull();
   await c.query(bootstrap);await c.query(upgrade);
   await c.query(bootstrap);await c.query(upgrade);
   await c.query(`insert into public.cofre_links
    (medico_id,agenda,token_hash,expira_em) values
    ('11111111-1111-4111-8111-111111111111','tribemd','legado-pos',now()+interval '15 minutes')`);
   await c.query(`insert into public.cofre_links
    (conta_id,agenda,token_hash,expira_em,destino_telefone) values
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','tribemd','conta-pos',now()+interval '15 minutes','5551999998888')`);
   await c.query(`insert into public.cofre_links_auditoria(link_id,evento)
    select id,'concluido' from public.cofre_links where token_hash='conta-pos'`);
   expect((await c.query('select count(*)::int as n from public.cofre_links')).rows[0].n).toBe(2);
   for(const [medico,conta,token] of [
    [null,null,'nenhum'],['11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','dois']
   ]) {
    await expect(c.query(`insert into public.cofre_links(medico_id,conta_id,agenda,token_hash,expira_em)
      values($1,$2,'tribemd',$3,now())`,[medico,conta,token])).rejects.toThrow();
   }
   const r=await c.query(`select relrowsecurity from pg_class where oid in
    ('public.cofre_links'::regclass,'public.cofre_links_auditoria'::regclass)`);
   expect(r.rows).toHaveLength(2);expect(r.rows.every(x=>x.relrowsecurity)).toBe(true);
   const g=await c.query(`select count(*)::int as n from information_schema.role_table_grants
    where table_schema='public' and table_name in ('cofre_links','cofre_links_auditoria')
    and grantee in ('anon','authenticated')`);
   expect(g.rows[0].n).toBe(0);
  }finally{await c.end();}
 }finally{if(created)await admin.query('DROP DATABASE '+name+' WITH (FORCE)');await admin.end();}
});
it('fixtures executam SQL antigo literalmente, sem DDL reescrita',()=>{
 expect(legacy).toContain("('criado', 'aberto', 'enviado', 'expirado')");
 expect(legacy).not.toContain('destino_telefone');
 expect(bootstrap).toContain('COFRE_ESTADO_PARCIAL_EXIGE_REVISAO');
 expect(upgrade).toContain('ADD COLUMN IF NOT EXISTS destino_telefone text');
 expect(upgrade).toContain("'concluido'");
});
