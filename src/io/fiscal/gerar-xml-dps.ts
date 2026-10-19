/**
 * Geração pura do XML da DPS (Padrão Nacional SEFIN v1.01).
 * Constrói os elementos XML estritamente na ordem exigida pelo XSD oficial
 * e gera o identificador oficial Id="DPS..." de 42 dígitos para assinatura.
 */

import type { EmissaoInput, ConfigPrestador } from './montar-dps.js';
import { xmlTributosNaoOptante } from '../../fiscal/preparacao/tributos-nao-optante.js';
import { momentoSP } from './montar-dps.js';
import { gerarGrupoIbscbs } from '../../fiscal/preparacao/ibscbs.js';
import { ajustarIndFinalTomador } from '../../fiscal/preparacao/classificar-servico-saude-reforma.js';

export interface ResultadoXmlDps {
  dpsId: string;
  xml: string;
}

function escaparXml(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function gerarXmlDps(
  input: EmissaoInput,
  cfg: ConfigPrestador,
  agora: Date = new Date()
): ResultadoXmlDps {
  const { dhEmi, dCompet } = momentoSP(agora);
  const cnpjLimpo = cfg.cnpj.replace(/\D/g, '');
  const serie = (cfg.serie || '00001').padStart(5, '0').slice(0, 5);
  const numeroDps = input.nDPS.replace(/\D/g, '').padStart(15, '0').slice(-15);
  const codMun = cfg.codMunicipio.replace(/\D/g, '').padStart(7, '0').slice(0, 7);

  // Id oficial: DPS + município (7) + tipo de inscrição (1) + inscrição
  // federal (14) + série (5) + número da DPS (15) = 42 dígitos.
  const tipoInscricaoFederal = cnpjLimpo.length === 11 ? '1' : '2';
  const inscricaoFederal = cnpjLimpo.padStart(14, '0');
  const dpsIdNumerico = `${codMun}${tipoInscricaoFederal}${inscricaoFederal}${serie}${numeroDps}`;
  const dpsId = `DPS${dpsIdNumerico}`;

  if (input.fiscal && cfg.regTrib.opSimpNac !== ({ nao_optante: 1, mei: 2, me_epp: 3 } as const)[input.fiscal.opcaoSimplesNacional]) throw new Error('Regime da DPS diverge da política confirmada.');
  const ehMei = cfg.regTrib.opSimpNac === 2;
  const meEpp = cfg.regTrib.opSimpNac === 3;
  const regTribXml = [
    `<opSimpNac>${cfg.regTrib.opSimpNac}</opSimpNac>`,
    meEpp ? `<regApTribSN>${cfg.regTrib.regApTribSN}</regApTribSN>` : '',
    `<regEspTrib>${cfg.regTrib.regEspTrib}</regEspTrib>`
  ].filter(Boolean).join('');

  const tomaDocXml = input.tomador.CPF
    ? `<CPF>${input.tomador.CPF.replace(/\D/g, '')}</CPF>`
    : `<CNPJ>${(input.tomador.CNPJ || '').replace(/\D/g, '')}</CNPJ>`;

  let tomaEndXml = '';
  if (input.tomador.end) {
    const end = input.tomador.end;
    const endNac = `<endNac><cMun>${end.cMun.replace(/\D/g, '')}</cMun><CEP>${end.CEP.replace(/\D/g, '')}</CEP></endNac>`;
    const cpl = end.xCpl ? `<xCpl>${escaparXml(end.xCpl)}</xCpl>` : '';
    tomaEndXml = `<end>${endNac}<xLgr>${escaparXml(end.xLgr)}</xLgr><nro>${escaparXml(end.nro)}</nro>${cpl}<xBairro>${escaparXml(end.xBairro)}</xBairro></end>`;
  }

  const foneXml = input.tomador.fone ? `<fone>${input.tomador.fone.replace(/\D/g, '')}</fone>` : '';
  const emailXml = input.tomador.email ? `<email>${escaparXml(input.tomador.email)}</email>` : '';
  const inscricaoMunicipalXml = cfg.im?.trim()
    ? `<IM>${escaparXml(cfg.im.trim())}</IM>`
    : '';

  const vServFmt = Number(input.vServ).toFixed(2);
  const pTotTribFmt = Number(input.fiscal?.percentualTotTribSN ?? input.pTotTribSN ?? cfg.pTotTribSN).toFixed(2);
  const tribFedXml = ehMei ? '' : `<tribFed><piscofins><CST>${input.fiscal ? input.fiscal.cstPisCofins : '08'}</CST></piscofins></tribFed>`;
  const totTribXml = ehMei
    ? `<totTrib><indTotTrib>0</indTotTrib></totTrib>`
    : `<totTrib><pTotTribSN>${pTotTribFmt}</pTotTribSN></totTrib>`;
  const tomadorCpf = Boolean(input.tomador.CPF);
  const tpRetMun = tomadorCpf ? 1 : (input.fiscal?.tpRetISSQN ?? 1);
  const aliqMunXml = (input.fiscal?.aliquotaIss !== undefined && (input.fiscal.regimeApuracaoSn === 'regime_2' || tpRetMun === 2))
    ? `<pAliq>${input.fiscal.aliquotaIss.toFixed(2)}</pAliq>`
    : '';
  const tribMunXml = `<tribMun><tribISSQN>${input.fiscal?.tribISSQN ?? 1}</tribISSQN><tpRetISSQN>${tpRetMun}</tpRetISSQN>${aliqMunXml}</tribMun>`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">` +
      `<infDPS Id="${dpsId}">` +
        `<tpAmb>${cfg.ambiente}</tpAmb>` +
        `<dhEmi>${dhEmi}</dhEmi>` +
        `<verAplic>1.0</verAplic>` +
        `<serie>${serie}</serie>` +
        `<nDPS>${input.nDPS}</nDPS>` +
        `<dCompet>${input.fiscal?.competencia ?? dCompet}</dCompet>` +
        `<tpEmit>1</tpEmit>` +
        `<finNFSe>0</finNFSe>` +
        `<cLocEmi>${codMun}</cLocEmi>` +
        `<prest>` +
          (cnpjLimpo.length === 11 ? `<CPF>${cnpjLimpo}</CPF>` : `<CNPJ>${cnpjLimpo}</CNPJ>`) +
          `${inscricaoMunicipalXml}` +
          `<regTrib>${regTribXml}</regTrib>` +
        `</prest>` +
        `<toma>` +
          `${tomaDocXml}` +
          `<xNome>${escaparXml(input.tomador.xNome)}</xNome>` +
          `${tomaEndXml}` +
          `${foneXml}` +
          `${emailXml}` +
        `</toma>` +
        `<serv>` +
          `<locPrest><cLocPrestacao>${input.fiscal?.municipioPrestacao ?? codMun}</cLocPrestacao></locPrest>` +
          `<cServ>` +
            `<cTribNac>${input.cTribNac.replace(/\D/g, '')}</cTribNac>` +
            (input.fiscal && input.cTribMun ? `<cTribMun>${escaparXml(input.cTribMun)}</cTribMun>` : '') +
            `<xDescServ>${escaparXml(input.xDescServ)}</xDescServ>` +
            (input.fiscal && input.cNBS ? `<cNBS>${escaparXml(input.cNBS)}</cNBS>` : '') +
          `</cServ>` +
        `</serv>` +
        `<valores>` +
          `<vServPrest><vServ>${vServFmt}</vServ></vServPrest>` +
          `<trib>` +
            (input.fiscal?.opcaoSimplesNacional === 'nao_optante' ? xmlTributosNaoOptante(input.fiscal, input.vServ, tomadorCpf) :
              `${tribMunXml}${tribFedXml}${totTribXml}`) +
          `</trib>` +
        `</valores>` +
        (input.fiscal?.ibscbs ? gerarGrupoIbscbs(ajustarIndFinalTomador(input.fiscal.ibscbs, tomadorCpf)) : '') +
      `</infDPS>` +
    `</DPS>`;

  return { dpsId, xml };
}
