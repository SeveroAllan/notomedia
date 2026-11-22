/**
 * Regras puras de projeção tributária para exibição fiel no DANFSe v2.0
 * (ISSQN, PIS/COFINS, IBS/CBS RTC 2026 e Lei 12.741/2012) a partir dos
 * parâmetros fiscais extraídos do XML de referência e validados na DPS.
 * Mantido sem I/O para ser testado diretamente contra XMLs reais do ADN.
 */

import type { ParametrosEmissao } from '../preparacao/parametros-emissao.js';
import type { DanfseServico, DanfseTotaisAproximados } from './danfse-pdf-options.js';
import type { MetadadosDanfseReferencia } from './extrair-metadados-danfse-xml.js';

const ROTULO_TRIB_ISSQN: Record<number, string> = {
  1: 'Operação Tributável',
  2: 'Imunidade',
  3: 'Exportação de Serviço',
  4: 'Não Incidência'
};

const ROTULO_RET_ISSQN: Record<number, string> = {
  1: 'Não Retido',
  2: 'Retido pelo Tomador',
  3: 'Retido pelo Intermediário'
};

function arredondar2(valor: number): number {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

function calcularPercentual(base: number, aliquota: number): number {
  return arredondar2((base * aliquota) / 100);
}

export function descreverFinalidadeNfse(finNFSe?: string): string {
  if (finNFSe === '1') return 'NFS-e Substituta';
  return 'NFS-e Regular';
}

export function montarServicoDanfseComTributos(entrada: {
  valorServico: number;
  discriminacao: string;
  cTribNac: string;
  cTribMun?: string;
  cNBS?: string;
  municipioPrestacao?: string;
  ufPrestacao?: string;
  fiscal?: ParametrosEmissao;
  metadados?: MetadadosDanfseReferencia;
  aliquotaIssFallback?: number;
  pTotTribSnFallback?: number;
}): DanfseServico {
  const { valorServico, fiscal, metadados } = entrada;
  const tributavelIss = !fiscal || fiscal.tribISSQN === 1;

  const aliquotaIss =
    fiscal?.aliquotaIss
    ?? metadados?.aliquotaIssAplicada
    ?? (fiscal?.totalTributos?.tipo === 'percentual' ? fiscal.totalTributos.municipal : undefined)
    ?? entrada.aliquotaIssFallback;

  const baseCalculoIss = tributavelIss ? valorServico : 0;
  const issApurado = tributavelIss && aliquotaIss !== undefined
    ? calcularPercentual(baseCalculoIss, aliquotaIss)
    : undefined;

  const pisCfg = fiscal?.pisCofinsCalculo;
  const valorPis = pisCfg ? calcularPercentual(valorServico, pisCfg.aliquotaPis) : undefined;
  const valorCofins = pisCfg ? calcularPercentual(valorServico, pisCfg.aliquotaCofins) : undefined;
  const retencaoPisCofinsTexto = fiscal?.cstPisCofins
    ? `CST ${fiscal.cstPisCofins} - ${pisCfg?.tipoRetencao === 2 ? 'Retido' : 'Não Retido'}`
    : undefined;

  const ibscbs = fiscal?.ibscbs;
  const baseCalculoIbsCbs = ibscbs ? arredondar2(Math.max(0, valorServico - (issApurado ?? 0))) : undefined;
  const aliquotaIbsUf = ibscbs ? (metadados?.ibscbsAliquotas?.pIbsUf ?? 0.1) : undefined;
  const aliquotaIbsMun = ibscbs ? (metadados?.ibscbsAliquotas?.pIbsMun ?? 0) : undefined;
  const aliquotaCbs = ibscbs ? (metadados?.ibscbsAliquotas?.pCbs ?? 0.9) : undefined;
  const valorIbsUf = baseCalculoIbsCbs !== undefined && aliquotaIbsUf !== undefined
    ? calcularPercentual(baseCalculoIbsCbs, aliquotaIbsUf) : undefined;
  const valorIbsMun = baseCalculoIbsCbs !== undefined && aliquotaIbsMun !== undefined
    ? calcularPercentual(baseCalculoIbsCbs, aliquotaIbsMun) : undefined;
  const valorIbsTotal = valorIbsUf !== undefined && valorIbsMun !== undefined
    ? arredondar2(valorIbsUf + valorIbsMun) : undefined;
  const valorCbs = baseCalculoIbsCbs !== undefined && aliquotaCbs !== undefined
    ? calcularPercentual(baseCalculoIbsCbs, aliquotaCbs) : undefined;
  const totalIbsCbs = valorIbsTotal !== undefined && valorCbs !== undefined
    ? arredondar2(valorIbsTotal + valorCbs) : undefined;

  const totalTributosAproximados = calcularTotaisAproximados(valorServico, fiscal, entrada.pTotTribSnFallback);
  const descricaoAtividade = [metadados?.descricaoTribNac, metadados?.descricaoNbs].filter(Boolean).join(' - ') || undefined;

  return {
    municipioPrestacao: fiscal?.municipioPrestacao ?? entrada.municipioPrestacao,
    ufPrestacao: entrada.ufPrestacao,
    tipoTributacao: fiscal ? (ROTULO_TRIB_ISSQN[fiscal.tribISSQN] ?? 'Operação Tributável') : undefined,
    tipoRetencao: fiscal ? (ROTULO_RET_ISSQN[fiscal.tpRetISSQN] ?? 'Não Retido') : undefined,
    cTribNac: entrada.cTribNac,
    cTribMun: entrada.cTribMun,
    cNBS: entrada.cNBS || undefined,
    descricaoAtividade,
    discriminacao: entrada.discriminacao,
    valor: valorServico,
    baseCalculoIss,
    aliquota: aliquotaIss,
    issApurado,
    cstPisCofins: fiscal?.cstPisCofins,
    aliquotaPis: pisCfg?.aliquotaPis,
    valorPis,
    aliquotaCofins: pisCfg?.aliquotaCofins,
    valorCofins,
    retencaoPisCofinsTexto,
    cstIbsCbs: ibscbs?.CST,
    cClassTrib: ibscbs?.cClassTrib,
    cIndOp: ibscbs?.cIndOp,
    baseCalculoIbsCbs,
    aliquotaIbsUf,
    valorIbsUf,
    aliquotaIbsMun,
    valorIbsMun,
    valorIbsTotal,
    aliquotaCbs,
    valorCbs,
    totalIbsCbs,
    totalTributosAproximados
  };
}

function calcularTotaisAproximados(
  valorServico: number,
  fiscal?: ParametrosEmissao,
  pTotTribSnFallback?: number
): DanfseTotaisAproximados | undefined {
  if (fiscal?.totalTributos?.tipo === 'percentual') {
    const { federal, estadual, municipal } = fiscal.totalTributos;
    return {
      federalPct: federal,
      federalValor: calcularPercentual(valorServico, federal),
      estadualPct: estadual,
      estadualValor: calcularPercentual(valorServico, estadual),
      municipalPct: municipal,
      municipalValor: calcularPercentual(valorServico, municipal)
    };
  }
  const snPct = fiscal?.percentualTotTribSN ?? pTotTribSnFallback;
  if (snPct !== undefined && snPct > 0) {
    return { snPct, snValor: calcularPercentual(valorServico, snPct) };
  }
  return undefined;
}
