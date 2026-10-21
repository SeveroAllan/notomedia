/** Cria a memória da conversa; não envia mensagens. */
import 'dotenv/config';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
const client = await pool.connect();
try {
  await client.query('begin');
  await client.query(await readFile(new URL('./migrations/20261020-conversa-mensagens.sql', import.meta.url), 'utf8'));
  await client.query('commit');
  console.log('Migração da memória de conversa aplicada. Nenhuma mensagem foi enviada.');
} catch (erro) {
  await client.query('rollback');
  throw erro;
} finally {
  client.release();
  await pool.end();
}
