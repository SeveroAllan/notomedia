/**
 * Portas de notificação para falhas de emissão e incidentes operacionais.
 * 1. Avisa o médico pela instância assistente, com flag, homologação e allowlist.
 * 2. Avisa o desenvolvedor por e-mail via Resend em caso de bug inesperado (item 8).
 */

export interface NotificarMedicoParams {
  telefoneMedico: string;
  medicoId?:string;
  solicitacaoId?:string;
  nomePaciente?: string | null;
  valorCentavos: number;
  motivoErro: string;
  pendenciasFiscais?: Array<{ campo: string; codigo: string; mensagem: string }>;
}

export interface NotificarDesenvolvedorParams {
  assunto: string;
  detalhesErro: string;
  solicitacaoId?: string;
  medicoId?: string;
}

export interface NotificadorAlertas {
  notificarMedicoWhatsApp(params: NotificarMedicoParams): Promise<void>;
  notificarDesenvolvedorEmail(params: NotificarDesenvolvedorParams): Promise<void>;
}

