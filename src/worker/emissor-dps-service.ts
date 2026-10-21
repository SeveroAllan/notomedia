/**
 * Porta de integração com o serviço de montagem/assinatura da DPS e envio à SEFIN.
 * Isola a chamada externa ao fork do kursku/emissor-nfse do loop do worker,
 * permitindo testes do worker sem depender de certificado A1 ou ambiente SEFIN.
 */

export interface SolicitacaoEmissaoItem {
  id: string;
  emissaoComprovante?: true;
  origemLote?: true;
  tomadorAoVivo?: import('../io/fiscal/postgres-emissor-dps-service.js').TomadorAoVivo;
  medicoId: string;
  pacienteId: string;
  xdescServ: string;
  valorServicoCentavos: number;
  ctribNac: string;
  cnbs?: string | null;
  cclassTrib?: string | null;
  cindOp?: string | null;
}

export type ResultadoEmissaoDps =
  | {
      sucesso: true;
      chaveAcesso: string;
      ndps: number;
      serie: string;
      competencia: string;
      dataEmissao: Date;
      valorServicosCentavos: number;
      xmlStoragePath: string;
      pdfStoragePath: string | null;
      respostaSefinRaw?: Record<string, unknown>;
    }
  | {
      sucesso: false;
      erro: string;
      dadosProfissionaisPendentes?: boolean;
      pendenciasFiscais?: Array<{ campo: string; codigo: string; mensagem: string }>;
      codigoErroSefin?: string;
      httpStatus?: number;
      xmlDpsOriginal?: string;
      falhaAntesDoEnvio?: 'EAI_AGAIN' | 'ECONNREFUSED';
      contextoTecnico?: Record<string, unknown>;
      respostaSefinRaw?: Record<string, unknown>;
    };

export interface EmissorDpsService {
  emitir(item: SolicitacaoEmissaoItem): Promise<ResultadoEmissaoDps>;
  corrigirRejeicao?(item: SolicitacaoEmissaoItem, falha: Extract<ResultadoEmissaoDps, { sucesso: false }>): Promise<ResultadoEmissaoDps>;
}
