/** Migração aditiva: profissional_externo_id em noto_medico_agenda_referencias (vínculo médico-agenda por código estável). */
import 'dotenv/config';
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
const client = await pool.connect();
try {
  await client.query('begin');
  await client.query(await readFile(new URL('./migrations/20261026-profissional-externo-id.sql', import.meta.url), 'utf8'));
  await client.query('commit');
  console.log('Migração de profissional_externo_id aplicada com sucesso.');
} catch (erro) {
  await client.query('rollback');
  throw erro;
} finally {
  client.release();
  await pool.end();
}
