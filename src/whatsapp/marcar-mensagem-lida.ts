/**
 * Marca a mensagem recebida no WhatsApp como lida (read receipt)
 * no início do atendimento, indicando ao usuário que sua mensagem
 * está sendo processada.
 */

export interface ChaveMensagemLeitura { id: string; remoteJid: string; remoteJidAlt?: string | null; fromMe: boolean }
export interface ParamsLeitura { instanciaNome: string; mensagemId: string; contatoTelefone: string; chaveMensagem?: ChaveMensagemLeitura }
export interface LeitorMensagemWhatsApp {
  marcarLida(params: ParamsLeitura): Promise<{ sucesso: boolean; erro?: string }>;
}

export async function marcarMensagemLida(
  leitor: LeitorMensagemWhatsApp,
  params: ParamsLeitura
): Promise<{ sucesso: boolean; erro?: string }> {
  if (!params.mensagemId || !params.instanciaNome || !params.contatoTelefone) {
    return { sucesso: false, erro: 'parametros_obrigatorios_ausentes' };
  }

  try {
    return await leitor.marcarLida(params);
  } catch {
    return { sucesso: false, erro: 'erro_ao_marcar_lida' };
  }
}
