/**
 * Porta de persistência para o fluxo de atendimento por WhatsApp.
 * Isola as tabelas de conversas, agendamentos, pacientes e solicitações
 * de nota fiscal das regras de orquestração do webhook.
 */

export interface InstanciaRegistro {
  id: string;
  medicoId: string | null;
  nomeInstancia: string;
  oficial: boolean;
}

export interface ConversaRegistro {
  id: string;
  instanciaId: string;
  medicoId: string | null;
  contatoTelefone: string;
  contatoNome?: string | null;
  pacienteId: string | null;
  aguardandoCpfDesde: Date | null;
}

export interface PacienteRegistro {
  id: string;
  medicoId: string;
  telefone: string;
  nome: string | null;
  cpfHash: string | null;
  email?: string | null;
  dataNascimento?: Date | null;
  nomeValidado?: boolean;
}

export interface MedicoDadosRegistro {
  id: string;
  nomeCompleto: string;
  especialidade: string | null;
  crm: string | null;
  rqe: string | null;
  ctribNacPadrao: string;
  telefone?: string;
}

export interface OperadorMedicoRegistro {
  usuarioId: string;
  tipo: 'medico' | 'secretaria';
  telefone: string;
  medicos: Array<{ id: string; nomeCompleto: string; crm: string | null }>;
}

export interface ConsultaEmAbertoRegistro {
  id: string;
  dataHora: Date;
  valorConsultaCentavos: number | null;
}

export interface SolicitacaoAguardandoDataRegistro {
  id: string;
  medicoId: string;
  pacienteId: string;
  nomePaciente: string;
  telefoneMedico: string;
  valorServicoCentavos: number;
  ctribNac: string;
  criadoEm: Date;
}

export interface AtendimentoRepositorio {
  buscarInstanciaPorNome(nomeInstancia: string): Promise<InstanciaRegistro | null>;
  buscarOuCriarConversa(instanciaId: string, medicoId: string | null, contatoTelefone: string, contatoNome?: string | null): Promise<ConversaRegistro>;
  buscarPacientePorTelefone(medicoId: string, telefone: string): Promise<PacienteRegistro | null>;
  criarPacienteMinimo(params: {
    medicoId: string;
    telefone: string;
    nome?: string | null;
    email?: string | null;
    cpfHash?: string | null;
    cpf?: string | null;
    origemCadastro?: string;
  }): Promise<PacienteRegistro>;

  atualizarCpfPaciente(params: {
    pacienteId: string;
    cpfHash: string;
    cpf?: string | null;
    nome?: string | null;
    dataNascimento?: Date | null;
    nomeValidado?: boolean;
  }): Promise<void>;

  vincularPacienteConversa(conversaId: string, pacienteId: string): Promise<void>;
  buscarMedicoPorTelefone(telefone: string): Promise<MedicoDadosRegistro | null>;
  buscarOperadorPorTelefone?(telefone: string): Promise<OperadorMedicoRegistro | null>;
  lerFocoOperador?(usuarioId: string): Promise<string | null>;
  salvarFocoOperador?(usuarioId: string, medicoId: string): Promise<boolean>;
  salvarMensagem?(params: {
    conversaId: string;
    direcao: 'recebida' | 'enviada';
    tipoMensagem?: string;
    conteudo: string;
    payloadBruto?: unknown;
    comandoDetectado?: string | null;
    criadoEm?: Date;
  }): Promise<void>;
  salvarMensagensEmLote?(mensagens: Array<{
    conversaId: string;
    direcao: 'recebida' | 'enviada';
    tipoMensagem?: string;
    conteudo: string;
    payloadBruto?: unknown;
    comandoDetectado?: string | null;
    criadoEm?: Date;
  }>): Promise<void>;
}
