/**
 * Presença "digitando..." do WhatsApp enquanto uma resposta está sendo processada.
 * É apenas feedback visual: indisponibilidade de presença não bloqueia a conversa.
 */
export interface ParametrosDigitacao {
  instanciaNome: string;
  contatoTelefone: string;
}

export interface SessaoDigitacao {
  parar(): Promise<void>;
}

export interface TransporteDigitacao {
  iniciarDigitacao(params: ParametrosDigitacao): Promise<SessaoDigitacao | null>;
}
