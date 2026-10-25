export const NOTO_HOMOLOG_PROJECT_REF = 'gvriqdvahxhsqjtqkcqk';

export function extrairProjectRefSupabase(databaseUrl) {
  let url;
  try { url = new URL(databaseUrl); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const direto = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1] ?? null;
  const usuario = decodeURIComponent(url.username || '').match(/^postgres\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? null;
  if (direto && usuario && direto !== usuario) throw new Error('SUPABASE_PROJECT_REF_INCONSISTENTE');
  return direto ?? usuario;
}

export function validarProjetoHomolog(databaseUrl, projectRefExplicito = process.env.SUPABASE_PROJECT_REF) {
  const inferido = extrairProjectRefSupabase(databaseUrl);
  const explicito = projectRefExplicito?.trim().toLowerCase() || null;
  if (inferido && explicito && inferido !== explicito) throw new Error('SUPABASE_PROJECT_REF_INCONSISTENTE');
  const selecionado = inferido ?? explicito;
  if (!selecionado) {
    throw new Error('SUPABASE_PROJECT_REF_NAO_CONFIRMADO: defina SUPABASE_PROJECT_REF e confira a conexão antes da migration');
  }
  if (selecionado !== NOTO_HOMOLOG_PROJECT_REF) {
    throw new Error(`SUPABASE_PROJECT_REF_INCORRETO: esperado ${NOTO_HOMOLOG_PROJECT_REF}, recebido ${selecionado}`);
  }
  return selecionado;
}
