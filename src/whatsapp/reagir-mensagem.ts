import type { ChaveMensagemLeitura } from './marcar-mensagem-lida.js';

export const REACOES_PERMITIDAS = ['👀', '🤔', '✅', '👍', '😊', '🙏', '🎉'] as const;
export type ReacaoMedico = typeof REACOES_PERMITIDAS[number];
export interface TransporteReacao {
  enviarReacao(params: { instanciaNome: string; chave: ChaveMensagemLeitura; reacao: ReacaoMedico }): Promise<{ sucesso: boolean }>;
}
