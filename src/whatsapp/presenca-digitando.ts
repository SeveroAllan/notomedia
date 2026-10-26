/** Presença "digitando..." na conversa assistente↔médico; encerramento explícito com 'paused'. */
export type TipoPresencaMedico = 'composing' | 'paused';
export interface TransportePresenca {
  enviarPresenca(params: { instanciaNome: string; contatoTelefone: string; presence: TipoPresencaMedico; delayMs: number }): Promise<{ sucesso: boolean; erro?: string }>;
}
