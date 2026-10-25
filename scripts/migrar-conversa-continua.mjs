/** Migração aditiva da memória contínua. Não envia WhatsApp nem altera o painel. */
import 'dotenv/config';
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
try {
  const sql = await readFile(new URL('./migrations/20261025-conversa-continua.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  console.log('Migração de conversa contínua aplicada no Supabase/Postgres. Nenhuma mensagem foi enviada.');
} finally {
  await pool.end();
}
