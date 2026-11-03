/** Código diagnóstico limitado; nunca registra mensagens, DSNs, consultas nem credenciais. */
export function codigoSeguroFalhaReady(erro: unknown): string {
  if (!erro || typeof erro !== 'object' || !('code' in erro)) return 'INDEFINIDO';
  const codigo = (erro as { code?: unknown }).code;
  if (typeof codigo !== 'string') return 'INDEFINIDO';
  // SQLSTATE (ex.: 42703, 42P01, 28P01) ou erros de rede do Node.
  if (/^[A-Z0-9]{5}$/.test(codigo)) return codigo;
  if (/^E[A-Z_]{2,20}$/.test(codigo)) return codigo;
  return 'INDEFINIDO';
}
