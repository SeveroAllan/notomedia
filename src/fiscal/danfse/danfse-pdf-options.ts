/**
 * Tipos e opções de dados para a geração do DANFSe v2.0 em PDF.
 * Define o contrato independente de fonte de dados (banco, SEFIN ou simulação),
 * cobrindo integralmente as especificações da NT 008/2026 e RTC 2026 (IBS/CBS).
 */

export interface DanfsePrestador {
  razaoSocial?: string;
  nomeFantasia?: string;
  cnpj?: string;
  inscricaoMunicipal?: string;
  endereco?: string;
  municipio?: string;
  uf?: string;
  cep?: string;
  telefone?: string;
  email?: string;
  simplesNacional?: boolean;
  opcaoSimplesNacional?: 'nao_optante' | 'mei' | 'me_epp';
  regimeApuracaoSn?: 'regime_1' | 'regime_2' | 'regime_3' | null;
}

export interface DanfseTomador {
  nome?: string;
  cpf?: string;
  inscricaoMunicipal?: string;
  endereco?: string;
  municipio?: string;
  uf?: string;
  cep?: string;
  telefone?: string;
  email?: string;
}

export interface DanfseTotaisAproximados {
  federalPct?: number;
  federalValor?: number;
  estadualPct?: number;
  estadualValor?: number;
  municipalPct?: number;
  municipalValor?: number;
  snPct?: number;
  snValor?: number;
}

export interface DanfseServico {
  municipioPrestacao?: string;
  ufPrestacao?: string;
  tipoTributacao?: string;
  tipoRetencao?: string;
  cTribNac?: string;
  cTribMun?: string;
  cNBS?: string;
  descricaoAtividade?: string;
  discriminacao?: string;
  valor?: number;
  baseCalculoIss?: number;
  aliquota?: number;
  issApurado?: number;
  desconto?: number;
  retencoes?: number;
  deducoes?: number;
  cstPisCofins?: string;
  aliquotaPis?: number;
  valorPis?: number;
  aliquotaCofins?: number;
  valorCofins?: number;
  retencaoPisCofinsTexto?: string;
  cstIbsCbs?: string;
  cClassTrib?: string;
  cIndOp?: string;
  baseCalculoIbsCbs?: number;
  aliquotaIbsUf?: number;
  valorIbsUf?: number;
  aliquotaIbsMun?: number;
  valorIbsMun?: number;
  valorIbsTotal?: number;
  aliquotaCbs?: number;
  valorCbs?: number;
  aliquotaIbs?: number;
  valorIbs?: number;
  totalIbsCbs?: number;
  totalTributosAproximados?: DanfseTotaisAproximados;
}

export interface DanfsePdfOptions {
  chaveAcesso?: string;
  numero?: string;
  serie?: string;
  dataEmissao?: string;
  competencia?: string;
  codigoVerificacao?: string;
  finalidade?: string;
  ambiente?: 'producao' | 'homologacao';
  contingenciaHomologacao?: boolean;
  cancelada?: boolean;
  prestador?: DanfsePrestador;
  tomador?: DanfseTomador;
  servico?: DanfseServico;
}
