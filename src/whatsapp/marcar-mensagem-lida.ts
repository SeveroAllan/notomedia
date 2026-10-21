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
