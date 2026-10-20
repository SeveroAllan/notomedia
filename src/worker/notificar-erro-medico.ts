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
  codigoErro?: string;
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


const mensagensFalha: Record<string, string> = {
  PERFIL_FISCAL_INCOMPLETO: 'Faltam informações do consultório; revise seu cadastro com seu contador antes de pedir uma nova tentativa.',
  DADOS_PROFISSIONAIS_INCOMPLETOS: 'Faltam seu nome completo e registro profissional; confira esses dados no cadastro antes de pedir uma nova tentativa.',
  CERTIFICADO_AUSENTE: 'Não encontrei um certificado digital ativo; cadastre um certificado válido antes de pedir uma nova tentativa.',
  CERTIFICADO_INVALIDO: 'Não consegui usar seu certificado digital; confira a validade e a senha na área segura antes de pedir uma nova tentativa.',
  PACIENTE_CPF_INVALIDO: 'Não consegui validar o documento do paciente; confira o cadastro antes de pedir uma nova tentativa.',
  PACIENTE_NOME_INVALIDO: 'Não consegui validar o nome do paciente; confira o nome completo no cadastro antes de pedir uma nova tentativa.',
  PARAMETROS_FISCAIS_PENDENTES: 'As informações de impostos precisam ser conferidas; peça ao seu contador para revisar a configuração antes de pedir uma nova tentativa.',
  REJEICAO_TRIBUTOS: 'O serviço de emissão recusou as informações de impostos; peça ao seu contador para conferir a configuração antes de pedir uma nova tentativa.',
  PREPARACAO_NECESSARIA: 'O cadastro do consultório precisa de revisão antes da emissão; peça ao suporte para conferir a configuração.',
  AMBIENTE_FISCAL_BLOQUEADO: 'A configuração não permite continuar este teste de emissão; peça ao suporte para conferir.',
  INTEGRACAO_FISCAL_INDISPONIVEL: 'Não consegui acessar o serviço de emissão; peça ao suporte para conferir a conexão.',
  SEFIN_INDISPONIVEL: 'O serviço de emissão da prefeitura está indisponível; aguarde uma orientação antes de pedir nova tentativa.',
  SEFIN_TIMEOUT: 'O serviço de emissão demorou a responder; aguarde a conferência do resultado antes de pedir nova tentativa.',
  E0014: 'A numeração informada já está em uso; aguarde o suporte conferir para evitar uma nota duplicada.',
  E0160: 'O cadastro do consultório está diferente do registrado no serviço de emissão; peça ao seu contador para conferir.',
  E0676: 'O cadastro do consultório está diferente do registrado no serviço de emissão; peça ao seu contador para conferir.',
  E0710: 'O cadastro do consultório está diferente do registrado no serviço de emissão; peça ao seu contador para conferir.',
  FALHA_ENTREGA_PDF: 'A nota foi emitida, mas não consegui entregar o documento; confira a conexão do WhatsApp e peça o reenvio, sem emitir outra nota.',
  INSTANCIA_INDISPONIVEL: 'A nota foi emitida, mas seu WhatsApp está desconectado; conecte-o e peça o reenvio, sem emitir outra nota.',
  PERSISTENCIA_COMPROVANTE_PENDENTE: 'A emissão foi autorizada, mas o registro precisa de conferência; aguarde o suporte e não peça outra emissão para a mesma consulta.'
};

/** Nunca usa mensagens técnicas ou texto livre para construir a fala ao médico. */
export function traduzirFalhaEmissao(codigo: unknown): string {
  if (typeof codigo === 'string' && Object.hasOwn(mensagensFalha, codigo)) return `${mensagensFalha[codigo]} Não vou tentar emitir novamente sozinho.`;
  return 'Não consegui concluir a emissão da nota; vou avisar o suporte e te retorno, sem tentar emitir novamente sozinho.';
}
