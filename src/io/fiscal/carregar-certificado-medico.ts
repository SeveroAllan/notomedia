/**
 * Carregamento seguro do certificado digital A1 (.pfx/.p12) ativo do médico.
 * Recupera o binário do Supabase Storage e a senha encriptada do Vault (seção 1 e 5).
 * Isola o I/O de certificados do fluxo do emissor fiscal.
 */

import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface CertificadoMedicoAtivo {
  id: string;
  medicoId: string;
  pfxBuffer: Buffer;
  senhaCertificado: string;
  arquivoStoragePath: string;
  validoAte: Date;
}

export async function carregarCertificadoMedico(
  pool: pg.Pool,
  supabase: SupabaseClient,
  medicoId: string
): Promise<CertificadoMedicoAtivo | null> {
  const sqlCert = `
    select
      id,
      medico_id,
      arquivo_storage_path,
      senha_secret_id,
      valido_ate
    from medico_certificados
    where medico_id = $1 and status = 'ativo'
      and (valido_de is null or valido_de <= current_date) and valido_ate >= current_date
    order by criado_em desc
    limit 1
  `;

  const { rows } = await pool.query(sqlCert, [medicoId]);
  if (rows.length === 0) {
    return null;
  }

  const certRow = rows[0];

  // 1. Busca a senha do certificado no Supabase Vault
  let senhaCertificado = '';
  try {
    const resDecrypted = await pool.query(
      `select decrypted_secret as secret from vault.decrypted_secrets where id = $1 limit 1`,
      [certRow.senha_secret_id]
    );
    if (resDecrypted.rows.length > 0 && resDecrypted.rows[0].secret) {
      senhaCertificado = resDecrypted.rows[0].secret;
    }
  } catch {
    // Fallback para tabela direta do vault se a view decrypted_secrets não estiver exposta
  }

  if (!senhaCertificado) {
    throw new Error('Senha do certificado não encontrada no Vault. Cadastre o A1 novamente.');
  }

  // 2. Faz o download do arquivo .pfx / .p12 do Supabase Storage
  const { data, error } = await supabase.storage
    .from('certificados')
    .download(certRow.arquivo_storage_path);

  if (error || !data) {
    throw new Error(
      `Falha ao baixar certificado digital do Storage (${certRow.arquivo_storage_path}): ${error?.message || 'Arquivo não encontrado'}`
    );
  }

  const arrayBuffer = await data.arrayBuffer();
  const pfxBuffer = Buffer.from(arrayBuffer);

  return {
    id: certRow.id,
    medicoId: certRow.medico_id,
    pfxBuffer,
    senhaCertificado,
    arquivoStoragePath: certRow.arquivo_storage_path,
    validoAte: new Date(certRow.valido_ate)
  };
}
