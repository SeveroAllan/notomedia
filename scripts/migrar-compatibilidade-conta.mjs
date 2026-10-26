/** Corrige compatibilidade de origem, memória por conta e visibilidade RLS. Não envia WhatsApp. */
import 'dotenv/config';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { validarProjetoHomolog } from './validar-projeto-homolog.mjs';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada');
validarProjetoHomolog(process.env.DATABASE_URL);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
try {
  for (const arquivo of [
    './migrations/20261102-origem-operador-conta.sql',
    './migrations/20261103-memoria-conta-e-visibilidade.sql'
  ]) {
    const sql = await readFile(new URL(arquivo, import.meta.url), 'utf8');
    await pool.query(sql);
  }
  console.log('Correções de compatibilidade da conta aplicadas. Nenhuma mensagem foi enviada.');
} finally {
  await pool.end();
}
