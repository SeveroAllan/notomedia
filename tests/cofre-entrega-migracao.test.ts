import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';
import { registrarAceiteLink, registrarEstadoEvolution, consultarEntregaLink } from '../src/whatsapp/repositorio-entrega-link.js';

const ler=(arquivo:string)=>readFileSync(fileURLToPath(new URL(arquivo,import.meta.url)),'utf8');
const sqlCofre=ler('../scripts/migrations/20261106-cofre-links-reconciliar-homologacao.sql');
const sqlEntrega=ler('../scripts/migrations/20261107-cofre-links-estado-whatsapp.sql');
const url=process.env['NOTO_SCHEMA_TEST_DATABASE_URL'];
const dbtest=url?it:it.skip;

dbtest('PostgreSQL real descartavel: hash, ACK, isolamento, RLS, idempotencia e dependencia da migration',async()=>{
 const admin=new pg.Client({connectionString:url});const nome='noto_link_receipts_'+randomBytes(5).toString('hex');
 let criado=false;await admin.connect();
 try {
   await admin.query('CREATE DATABASE '+nome);criado=true;
   const addr=new URL(url!);addr.pathname='/'+nome;const db=new pg.Client({connectionString:addr.toString()});
   await db.connect();
   try {
     await db.query(`DO $$ BEGIN
       PERFORM pg_advisory_xact_lock(76022026);
       IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
       IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
       IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
     END $$;`);
     await expect(db.query(sqlEntrega)).rejects.toThrow(/COFRE_LINKS_NAO_RECONCILIADOS/);
     await db.query('ROLLBACK');
     await db.query(`
       CREATE TABLE contas(id uuid PRIMARY KEY);
       CREATE TABLE medicos(id uuid PRIMARY KEY,conta_id uuid REFERENCES contas(id));
       INSERT INTO contas VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
       INSERT INTO contas VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
     `);
     await db.query(sqlCofre);await db.query(sqlEntrega);await db.query(sqlEntrega);
     const link=(await db.query(`
       INSERT INTO cofre_links(conta_id,agenda,token_hash,expira_em)
       VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','tribemd','hash-simulado',now()+interval '15 minutes')
       RETURNING id
     `)).rows[0].id;
     const senha='segredo-teste-hmac',tel='5551999998888',id='3EB0ABCDE456';
     await registrarAceiteLink(db,{linkId:link,instancia:'noto-assistente',mensagemId:id,telefone:tel,segredo:senha});
     await registrarAceiteLink(db,{linkId:link,instancia:'noto-assistente',mensagemId:id,telefone:tel,segredo:senha});
     expect((await db.query('select count(*)::int as n from cofre_links_entregas')).rows[0].n).toBe(1);
     const dados=(await db.query('select * from cofre_links_entregas')).rows[0];
     expect(dados).toMatchObject({link_id:link,mensagem_id:id,estado:'ACEITO_API'});
     expect(JSON.stringify(dados)).not.toContain(tel);
     expect(JSON.stringify(dados)).not.toContain('hash-simulado');
     const evento=(estado:string,numero=tel,instancia='noto-assistente')=>({
       event:'messages.update',instance:instancia,
       data:{keyId:id,remoteJid:numero+'@s.whatsapp.net',fromMe:true,status:estado}
     });
     expect(await registrarEstadoEvolution(db,evento('READ','5599999998888'),'noto-assistente',senha)).toBe(false);
     expect(await registrarEstadoEvolution(db,evento('READ',tel,'intruso'),'noto-assistente',senha)).toBe(false);
     expect(await registrarEstadoEvolution(db,evento('SERVER_ACK'),'noto-assistente',senha)).toBe(true);
     expect((await db.query('select estado from cofre_links_entregas')).rows[0].estado).toBe('SERVER_ACK');
     const pendente=await consultarEntregaLink(db,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','tribemd');
     expect(pendente?.estado).toMatch(/AGUARDANDO_ENTREGA|SEM_CONFIRMACAO/);
     expect(await consultarEntregaLink(db,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','tribemd')).toBeNull();
     expect(await registrarEstadoEvolution(db,evento('READ'),'noto-assistente',senha)).toBe(true);
     expect(await registrarEstadoEvolution(db,evento('ERROR'),'noto-assistente',senha)).toBe(false);
     expect((await db.query('select estado from cofre_links_entregas')).rows[0].estado).toBe('READ');
     expect((await consultarEntregaLink(db,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','tribemd'))?.estado).toBe('LIDO');
     const isrls=await db.query("select relrowsecurity from pg_class where oid='public.cofre_links_entregas'::regclass");
     expect(isrls.rows[0].relrowsecurity).toBe(true);
     for (const rol of ['anon','authenticated'])
       for(const acao of ['SELECT','INSERT','UPDATE','DELETE']){
         expect((await db.query('select has_table_privilege($1,$2,$3) as p',[rol,'public.cofre_links_entregas',acao])).rows[0].p).toBe(false);
       }
   } finally { await db.end(); }
 } finally { if(criado)await admin.query('DROP DATABASE '+nome+' WITH (FORCE)');await admin.end(); }
});
