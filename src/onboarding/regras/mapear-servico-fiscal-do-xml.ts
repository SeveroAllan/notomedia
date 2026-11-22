/**
 * Mapeamento puro de serviço fiscal inicial do médico a partir do XML.
 * Extrai cTribNac, cTribMun, alíquota de ISS e gera sugestão de especialidade
 * para a confirmação manual no onboarding (seções 3.2 e 5.1 do plano).
 */

import { extrairSugestaoEmissao } from './extrair-sugestao-emissao.js';
import { inferirEspecialidadeDeXdescserv } from './inferir-especialidade-de-xdescserv.js';

export type ServicoFiscalExtraido = {
  nomeServico: string;
  parametrosSugeridos?: Record<string, unknown>;
  ctribNac: string;
  ctribMun: string | null;
  cnbs: string | null;
  xdescServ: string;
  aliquotaIss: number | null;
  valorPadraoCentavos: number | null;
  especialidadeSugerida: string | null;
};

export function mapearServicoFiscalDoXml(xmlObj: any): ServicoFiscalExtraido {
  const raiz = xmlObj.NFSe || xmlObj.compNFSe || xmlObj.nfse || xmlObj;
  const infNfse = raiz.infNFSe || raiz;
  const infDps = infNfse.DPS?.infDPS || infNfse.infDPS || raiz.DPS?.infDPS || raiz.infDPS || {};
  const cServ = infDps.serv?.cServ || {};
  const tribMun = infDps.valores?.trib?.tribMun || infNfse.valores?.tribMun || {};
  const vServ = infDps.valores?.vServPrest?.vServ || infNfse.valores?.vServPrest?.vServ;

  if (!cServ.cTribNac) {
    throw new Error('O XML não contém o código de tributação nacional do serviço (cTribNac).');
  }

  const rawCtribNac = String(cServ.cTribNac).trim();
  const ctribNac = rawCtribNac.length < 6 ? rawCtribNac.padStart(6, '0') : rawCtribNac;
  const ctribMun = cServ.cTribMun ? String(cServ.cTribMun).trim().padStart(3, '0') : null;
  const cnbs = cServ.cNBS ? String(cServ.cNBS).trim() : null;
  const rawXDesc = cServ.xDescServ ? String(cServ.xDescServ).trim() : null;
  const especialidadeSugerida = inferirEspecialidadeDeXdescserv(rawXDesc);

  const aliqBruta = tribMun.pAliq ?? infNfse.valores?.pAliqAplic;
  const aliquotaIss = aliqBruta !== undefined && aliqBruta !== null && aliqBruta !== ''
    ? Number(aliqBruta)
    : null;
  const valorPadraoCentavos = vServ !== undefined && vServ !== null && vServ !== ''
    ? Math.round(Number(vServ) * 100)
    : null;

  return {
    parametrosSugeridos: extrairSugestaoEmissao(xmlObj),
    nomeServico: especialidadeSugerida ? `Consulta - ${especialidadeSugerida}` : 'Consulta Médica',
    ctribNac,
    ctribMun,
    cnbs,
    xdescServ: rawXDesc || 'Consulta médica e atendimento clínico especializado',
    aliquotaIss,
    valorPadraoCentavos,
    especialidadeSugerida
  };
}
