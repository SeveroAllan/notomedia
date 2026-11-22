/**
 * Extrai parâmetros fiscais duradouros do médico a partir do XML parseado
 * da NFS-e Nacional (leiaute sped.fazenda.gov.br/nfse 1.01+).
 * Função 100% pura: nunca toca banco ou rede (seção 3 e 4 do plano).
 */

import { inferirUfDeMunicipioIbge } from './inferir-uf-de-municipio-ibge.js';
import { analisarReferenciaFiscal } from './analisar-referencia-fiscal.js';

export type ParametrosFiscaisExtraidos = {
  cnpj: string;
  inscricaoMunicipal: string;
  razaoSocial: string;
  nomeFantasia: string | null;
  codMunicipioIbge: string;
  uf: string;
  serieDps: string;
  opcaoSimplesNacional: 'nao_optante' | 'mei' | 'me_epp';
  regimeApuracaoSn: 'regime_1' | 'regime_2' | 'regime_3' | null;
  regimeEspecialTributacao: number;
  ambiente: 'producao' | 'homologacao';
  cnae: string | null;
  proximoNumeroSequencialSugerido: number;
  cclassTribPadrao: string | null;
  cindOpPadrao: string | null;
  dadosReformaTributaria: Record<string, unknown>;
};

function extrairNosPrincipais(xmlObj: any): { infNfse: any; infDps: any } {
  const raiz = xmlObj.NFSe || xmlObj.compNFSe || xmlObj.nfse || xmlObj;
  const infNfse = raiz.infNFSe || raiz;
  const infDps = infNfse.DPS?.infDPS || infNfse.infDPS || raiz.DPS?.infDPS || raiz.infDPS || {};
  return { infNfse, infDps };
}

function mapearOpcaoSimples(val?: string | number): 'nao_optante' | 'mei' | 'me_epp' {
  if (val === undefined || val === null || String(val).trim() === '') {
    throw new Error('O XML não contém a opção do Simples Nacional do prestador (opSimpNac).');
  }
  const s = String(val).trim();
  if (s === '1') return 'nao_optante';
  if (s === '2') return 'mei';
  if (s === '3') return 'me_epp';
  throw new Error(`Opção do Simples Nacional não reconhecida no XML: ${s}`);
}

function mapearRegimeApuracao(val?: string | number): 'regime_1' | 'regime_2' | 'regime_3' | null {
  if (!val) return null;
  const s = String(val).trim();
  if (s === '1') return 'regime_1';
  if (s === '2') return 'regime_2';
  if (s === '3') return 'regime_3';
  return null;
}

export function mapearParametrosFiscaisDoXml(xmlObj: any): ParametrosFiscaisExtraidos {
  const { infNfse, infDps } = extrairNosPrincipais(xmlObj);
  const emit = infNfse.emit || {};
  const prest = infDps.prest || {};
  const regTrib = prest.regTrib || {};
  const cServ = infDps.serv?.cServ || {};

  const cnpj = String(emit.CNPJ || prest.CNPJ || emit.CPF || prest.CPF || '').replace(/\D/g, '');
  if (!cnpj) throw new Error('XML não contém CNPJ/CPF do prestador emitente.');

  const im = String(emit.IM || prest.IM || '').trim();
  const razaoSocial = String(emit.xNome || prest.xNome || '').trim();
  const nomeFantasia = emit.xFant ? String(emit.xFant).trim() : null;

  const codMunicipioIbge = String(infDps.cLocEmi || infNfse.cLocIncid || '').trim();
  if (!codMunicipioIbge) {
    throw new Error('O XML não contém o código IBGE do município emissor (cLocEmi / cLocIncid).');
  }

  const uf = emit.enderNac?.UF || inferirUfDeMunicipioIbge(codMunicipioIbge);
  if (!uf) {
    throw new Error(`Não foi possível determinar a UF do prestador para o município IBGE: ${codMunicipioIbge}.`);
  }

  const serieBruta = String(infDps.serie || '00001').trim();
  // Séries 50000-99999 são reservadas ao Portal Web/App Nacional da NFS-e;
  // aplicativo próprio deve emitir na faixa 00001-49999 com sequência própria.
  const serieReservadaPortal = /^\d{1,5}$/.test(serieBruta) && Number(serieBruta) > 49999;
  const serieDps = serieReservadaPortal ? '00001' : serieBruta;
  const nDpsNum = Number(infDps.nDPS || infNfse.nNFSe || infNfse.nDFSe || 0);
  const proximoNumeroSequencialSugerido = serieReservadaPortal ? 1 : (nDpsNum > 0 ? nDpsNum + 1 : 1);

  const tpAmb = String(infDps.tpAmb || infNfse.ambGer || '1');
  const ambiente = tpAmb === '1' ? 'producao' : 'homologacao';

  const gIbscbs = infDps.IBSCBS?.valores?.trib?.gIBSCBS || {};

  return {
    cnpj,
    inscricaoMunicipal: im,
    razaoSocial,
    nomeFantasia,
    codMunicipioIbge,
    uf,
    serieDps,
    opcaoSimplesNacional: mapearOpcaoSimples(regTrib.opSimpNac),
    regimeApuracaoSn: mapearRegimeApuracao(regTrib.regApTribSN),
    regimeEspecialTributacao: Number(regTrib.regEspTrib ?? 0),
    ambiente,
    cnae: cServ.cIntContrib ? String(cServ.cIntContrib).trim() : null,
    proximoNumeroSequencialSugerido,
    cclassTribPadrao: gIbscbs.cClassTrib ? String(gIbscbs.cClassTrib) : null,
    cindOpPadrao: infDps.IBSCBS?.cIndOp ? String(infDps.IBSCBS.cIndOp) : null,
    dadosReformaTributaria: analisarReferenciaFiscal(xmlObj)
  };
}
