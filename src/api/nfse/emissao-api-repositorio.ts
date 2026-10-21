/**
 * Porta de persistência para a API pública de emissão de NFS-e.
 * Define os métodos de consulta de idempotência por referência, perfil fiscal do médico,
 * resolução de paciente e inserção na fila de processamento assíncrono.
 */

export interface SolicitacaoRefRegistro {
  id: string;
  medicoId: string;
  referenciaExterna: string;
  status: string;
  fila: string | null;
  erro?: string | null;
  criadoEm: Date;
  notaFiscal?: {
    chaveAcesso: string;
    ndps: number;
    serie: string;
    dataEmissao: Date;
    xmlStoragePath?: string | null;
    pdfStoragePath?: string | null;
  } | null;
}

export interface PerfilFiscalMedicoRegistro {
  medicoId: string;
  nomeCompleto: string;
  especialidade?: string | null;
  crm?: string | null;
  rqe?: string | null;
  ctribNacPadrao: string;
  cnbs?: string | null;
  cclassTrib?: string | null;
  cindOp?: string | null;
  configuracaoCompleta: boolean;
}

export interface CriarSolicitacaoEmissaoParams {
  origem?: 'api' | 'whatsapp' | 'lote';
  contatoPaciente?: string | null;
  ref: string;
  medicoId: string;
  pacienteId: string;
  valorServicoCentavos: number;
  xdescServ: string;
  ctribNac: string;
  cnbs?: string | null;
  cclassTrib?: string | null;
  cindOp?: string | null;
  datasConsultaTexto?: string | null;
}

export interface EmissaoApiRepositorio {
  buscarPorReferencia(medicoId: string, ref: string): Promise<SolicitacaoRefRegistro | null>;
  buscarPerfilFiscalMedico(medicoId: string): Promise<PerfilFiscalMedicoRegistro | null>;
  buscarOuCriarPaciente(
    medicoId: string,
    paciente: { cpfLimpo: string; nome: string; email?: string | null; telefone?: string | null }
  ): Promise<{ id: string }>;
  enfileirarSolicitacao(params: CriarSolicitacaoEmissaoParams): Promise<{ id: string }>;
}
