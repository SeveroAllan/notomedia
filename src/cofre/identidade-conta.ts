/** Chave estável por conta para o Cofre criptografado.
 * Não corresponde a médico, usuário ou profissional da agenda.
 * Prefixo ASCII aceito pelo formato atual dos envelopes AES-GCM.
 */
export const cofreIdDaConta = (contaId: string): string => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(contaId)) {
    throw new Error('CONTA_INVALIDA');
  }
  return 'conta_' + contaId.toLowerCase();
};
export const contaDoCofreId = (id: string): string | null => {
  if (!id.startsWith('conta_')) return null;
  try {
    const contaId = id.slice(6);
    return cofreIdDaConta(contaId) === id ? contaId : null;
  } catch { return null; }
};
