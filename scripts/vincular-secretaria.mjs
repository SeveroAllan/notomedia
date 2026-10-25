/** Vínculo administrativo explícito de uma secretária existente aos médicos permitidos. */
import 'dotenv/config';
import pg from 'pg';

const usuarioId=(process.env.SECRETARIA_USUARIO_ID||'').trim();
const medicos=(process.env.MEDICO_IDS||'').split(',').map(x=>x.trim()).filter(Boolean);
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL não configurada');
if(!/^[0-9a-f-]{36}$/i.test(usuarioId))throw new Error('SECRETARIA_USUARIO_ID inválido');
if(!medicos.length||medicos.some(x=>!/^[0-9a-f-]{36}$/i.test(x)))throw new Error('MEDICO_IDS deve conter UUIDs separados por vírgula');

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});
const c=await pool.connect();
try{
 await c.query('begin');
 const u=(await c.query('select id,conta_id from public.usuarios where id=$1 and ativo=true',[usuarioId])).rows[0];
 if(!u)throw new Error('Usuário da secretária não encontrado ou inativo');
 const {rows:existentes}=await c.query('select id from public.medicos where id=any($1::uuid[])',[medicos]);
 if(existentes.length!==medicos.length)throw new Error('Um ou mais médicos não existem');
 const secretaria=(await c.query(`insert into public.secretarias(usuario_id,conta_id) values($1,$2)
   on conflict(usuario_id) do update set conta_id=excluded.conta_id returning id`,[u.id,u.conta_id])).rows[0];
 for(const medicoId of medicos)await c.query('insert into public.secretaria_medico(secretaria_id,medico_id) values($1,$2) on conflict do nothing',[secretaria.id,medicoId]);
 await c.query('commit');
 console.log(JSON.stringify({ok:true,secretariaId:secretaria.id,medicosVinculados:medicos.length}));
}catch(e){await c.query('rollback');throw e;}finally{c.release();await pool.end();}
