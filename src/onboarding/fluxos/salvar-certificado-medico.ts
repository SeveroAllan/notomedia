/**
 * Armazenamento e ativação do certificado digital A1 (.pfx/.p12) do médico.
 * O arquivo binário é armazenado no bucket privado do Supabase Storage e
 * a senha é gravada no Supabase Vault,
 * mantendo apenas o UUID do segredo em `medico_certificados` (seção 1 e 4 do plano).
 */

import crypto from 'node:crypto';
import type pg from 'pg';
import { registrarConsentimentoFiscal } from './consentimento-fiscal.js';
import type { SupabaseClient } from '@supabase/supabase-js';

export type SalvarCertificadoInput = {
  medicoId: string;
  arquivoBuffer: Buffer;
  usuarioId: string;
  validoDe: Date;
  validoAte: Date;
  senhaCertificado: string;
};

export type ResultadoSalvarCertificado = {
  ok: boolean;
  certificadoId: string;
  storagePath: string;
  validoAte: string;
};

const BUCKET_CERTIFICADOS = 'certificados';

async function enviarCertificadoAoStorage(
  supabase: SupabaseClient,
  storagePath: string,
  arquivoBuffer: Buffer
): Promise<void> {
  const enviar = () => supabase.storage
    .from(BUCKET_CERTIFICADOS)
    .upload(storagePath, arquivoBuffer, {
      contentType: 'application/x-pkcs12',
      upsert: true
    });

  let resultado = await enviar();
  if (resultado.error && /bucket not found/i.test(resultado.error.message)) {
    const criacao = await supabase.storage.createBucket(BUCKET_CERTIFICADOS, {
      public: false,
      fileSizeLimit: 10 * 1024 * 1024,
      allowedMimeTypes: ['application/x-pkcs12', 'application/octet-stream']
    });
    if (criacao.error && !/already exists|duplicate/i.test(criacao.error.message)) {
      throw new Error(`Falha ao criar o armazenamento privado de certificados: ${criacao.error.message}`);
    }
    resultado = await enviar();
  }

  if (resultado.error) {
    throw new Error(`Falha ao armazenar o certificado A1: ${resultado.error.message}`);
  }
}

export async function salvarCertificadoMedico(
  pool: pg.Pool,
  supabase: SupabaseClient,
  input: SalvarCertificadoInput
): Promise<ResultadoSalvarCertificado> {
  const { medicoId, arquivoBuffer, senhaCertificado, usuarioId, validoDe, validoAte } = input;
  const hash = crypto.createHash('sha256').update(arquivoBuffer).digest('hex');
  let storagePath = `certificados/${medicoId}/${hash}.pfx`;
  const client = await pool.connect();

  try {
    await client.query('begin');
    const medico = await client.query('select id from public.medicos where id = $1 and conta_id is not null for update', [medicoId]);
    if (!medico.rows.length) throw new Error('MEDICO_NAO_ENCONTRADO');

    const certificados = await client.query(`select id, arquivo_storage_path, status
      from public.medico_certificados where medico_id = $1
      order by (arquivo_storage_path = $2) desc, criado_em desc`, [medicoId, storagePath]);
    let existente = certificados.rows.find(c => c.arquivo_storage_path === storagePath);
    // O upload anterior ao uso do hash nomeava o objeto pelo UUID da linha.
    for (const candidato of certificados.rows) {
      if (existente) break;
      if (candidato.arquivo_storage_path !== `certificados/${medicoId}/${candidato.id}.pfx`) continue;
      const { data, error } = await supabase.storage.from(BUCKET_CERTIFICADOS).download(candidato.arquivo_storage_path);
      if (error || !data) throw new Error('CERTIFICADO_ANTERIOR_INDISPONIVEL');
      if (Buffer.from(await data.arrayBuffer()).equals(arquivoBuffer)) existente = candidato;
    }

    const certId = existente?.id ?? crypto.randomUUID();
    if (existente?.status === 'revogado') throw new Error('CERTIFICADO_REVOGADO');
    if (existente) {
      storagePath = existente.arquivo_storage_path;
    } else {
      await enviarCertificadoAoStorage(supabase, storagePath, arquivoBuffer);
      const resVault = await client.query('select vault.create_secret($1, $2, $3) as id', [
        senhaCertificado, `cert_medico_${medicoId}_${certId}`, 'Senha do certificado digital A1'
      ]);
      const secretUuid = resVault.rows[0]?.id;
      if (!secretUuid) throw new Error('O Vault nao retornou o identificador do segredo.');
      await client.query(`insert into public.medico_certificados (
        id, medico_id, arquivo_storage_path, senha_secret_id, valido_de, valido_ate, status
      ) values ($1, $2, $3, $4, $5, $6, 'pendente')`, [
        certId, medicoId, storagePath, secretUuid, validoDe.toISOString().slice(0, 10), validoAte.toISOString().slice(0, 10)
      ]);
    }

    await registrarConsentimentoFiscal(client, medicoId, certId, usuarioId);
    await client.query(`update public.medico_certificados set status = 'vencido'
      where medico_id = $1 and status = 'ativo' and id <> $2`, [medicoId, certId]);
    await client.query(`update public.medico_certificados set status = 'ativo', valido_de = $2, valido_ate = $3
      where id = $1`, [certId, validoDe.toISOString().slice(0, 10), validoAte.toISOString().slice(0, 10)]);
    await client.query('commit');
    return { ok: true, certificadoId: certId, storagePath, validoAte: validoAte.toISOString().slice(0, 10) };
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    // Um commit de resultado incerto pode ter referenciado o objeto. O reenvio reutiliza a mesma chave.
    throw err;
  } finally {
    client.release();
  }
}
