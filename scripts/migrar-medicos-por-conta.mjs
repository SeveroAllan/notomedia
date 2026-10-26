/** Permite médicos administrados pela conta sem login próprio. Não envia mensagens. */
import 'dotenv/config';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { validarProjetoHomolog } from './validar-projeto-homolog.mjs';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada');
validarProjetoHomolog(process.env.DATABASE_URL);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
try {
  for (const arquivo of [
    './migrations/20261031-contadores-delegacoes.sql',
    './migrations/20261101-medicos-por-conta.sql'
  ]) {
    const sql = await readFile(new URL(arquivo, import.meta.url), 'utf8');
    await pool.query(sql);
  }
  console.log('Migrações de delegações e médicos por conta aplicadas. Nenhuma mensagem foi enviada.');
} finally {
  await pool.end();
}
