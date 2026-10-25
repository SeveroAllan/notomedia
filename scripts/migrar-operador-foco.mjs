/** Migração aditiva para secretária multi-médico, foco e destino de links. Não envia mensagens. */
import 'dotenv/config';
import pg from 'pg';
import { validarProjetoHomolog } from './validar-projeto-homolog.mjs';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada');
validarProjetoHomolog(process.env.DATABASE_URL);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
try {
  const sql = await readFile(new URL('./migrations/20261025-operador-foco.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  console.log('Migração de operador multi-médico aplicada. Nenhuma mensagem foi enviada.');
} finally {
  await pool.end();
}
