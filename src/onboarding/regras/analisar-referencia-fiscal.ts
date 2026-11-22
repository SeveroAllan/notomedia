/**
 * Registra a origem e os limites do que pode ser reaproveitado. Campos operacionais
 * da nota anterior nunca viram impostos fixos ou dados de um próximo paciente.
 */
import { extrairIbscbsReferencia } from './extrair-ibscbs-referencia.js';
import { parametrosEmissaoSchema } from '../../fiscal/preparacao/parametros-emissao.js';
import { extrairSugestaoEmissao } from './extrair-sugestao-emissao.js';
import { extrairMetadadosDanfseDoXml } from '../../fiscal/danfse/extrair-metadados-danfse-xml.js';

export function analisarReferenciaFiscal(xmlObj: any) {
  const nfse = xmlObj.NFSe?.infNFSe || xmlObj.compNFSe?.infNFSe || xmlObj.nfse?.infNFSe || {};
  const dps = nfse.DPS?.infDPS || {};
  const ibscbs = extrairIbscbsReferencia(dps);
  const pendencias = [...ibscbs.pendencias];
  const detectar = (obj: any, conhecidos: string[], caminho: string) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { pendencias.push(`${caminho}: múltiplos grupos não suportados.`); return; }
    for (const chave of Object.keys(obj)) if (!chave.startsWith('@_') && !conhecidos.includes(chave)) {
      pendencias.push(`${caminho}/${chave}: precisa de tratamento específico antes de reutilizar a referência.`);
    }
  };
  if (!nfse.DPS?.infDPS) pendencias.push('A nota de referência precisa conter a DPS original do padrão nacional.');
  if (String(dps.tpEmit) !== '1') pendencias.push('A referência precisa ser uma emissão pelo próprio prestador.');
  if (!ibscbs.presente && (nfse.IBSCBS || nfse.IBSCBSSEL)) pendencias.push('Há IBS/CBS calculado, mas faltam os parâmetros declarados na DPS.');
  detectar(dps, ['tpAmb','dhEmi','verAplic','serie','nDPS','dCompet','tpEmit','cLocEmi','subst','prest','toma','serv','valores','IBSCBS'], 'DPS');
  // A substituição identifica a operação anterior. Não vira política tributária
  // nem vínculo de substituição nas próximas notas; o XML de origem fica preservado.
  if (dps.subst !== undefined && (!dps.subst || typeof dps.subst !== 'object')) {
    pendencias.push('DPS/subst: grupo de substituição inválido.');
  }
  detectar(dps.subst, ['chSubstda','cMotivo','xMotivo'], 'DPS/subst');
  detectar(dps.prest?.regTrib, ['opSimpNac','regApTribSN','regEspTrib'], 'prest/regTrib');
  detectar(dps.serv?.cServ, ['cTribNac','cTribMun','cNBS','xDescServ'], 'serv/cServ');
  detectar(dps.serv, ['locPrest','cServ','infoCompl'], 'serv');
  detectar(dps.serv?.locPrest, ['cLocPrestacao'], 'serv/locPrest');
  detectar(dps.valores, ['vServPrest','trib'], 'valores');
  detectar(dps.valores?.vServPrest, ['vServ'], 'valores/vServPrest');
  const trib = dps.valores?.trib;
  const naoOptante = String(dps.prest?.regTrib?.opSimpNac) === '1';
  detectar(trib, ['tribMun','tribFed','totTrib'], 'valores/trib');
  const permiteAliqMun = naoOptante || String(dps.prest?.regTrib?.regApTribSN) === '2' || String(trib?.tribMun?.tpRetISSQN) === '2';
  detectar(trib?.tribMun, ['tribISSQN','tpRetISSQN', ...(permiteAliqMun ? ['pAliq'] : [])], 'tribMun');
  detectar(trib?.tribFed, ['piscofins'], 'tribFed');
  const pis = trib?.tribFed?.piscofins;
  const calculaPis = naoOptante && ['01', '02'].includes(String(pis?.CST).padStart(2, '0'));
  detectar(pis, ['CST', ...(calculaPis ? ['vBCPisCofins','pAliqPis','pAliqCofins','vPis','vCofins','tpRetPisCofins'] : [])], 'tribFed/piscofins');
  if (calculaPis) {
    if (pis?.vBCPisCofins !== undefined || pis?.vPis !== undefined || pis?.vCofins !== undefined) {
      const valor = Number(dps.valores?.vServPrest?.vServ);
      const base = Number(pis.vBCPisCofins);
      if (!Number.isFinite(base) || base <= 0 || base !== valor) pendencias.push('tribFed/piscofins: a base de cálculo precisa corresponder ao valor integral do serviço; base reduzida exige revisão.');
      for (const [aliquota, montante] of [['pAliqPis','vPis'], ['pAliqCofins','vCofins']]) {
        const taxa = Number(pis[aliquota]), declarado = Number(pis[montante]);
        const esperadoCentavos = Math.round(Math.round(base * 100) * Math.round(taxa * 100) / 10000);
        if (!/^\d+(?:\.\d{1,2})?$/.test(String(pis[aliquota])) || !/^\d+(?:\.\d{1,2})?$/.test(String(pis[montante])) || !Number.isFinite(taxa) || !Number.isFinite(declarado) || Math.round(declarado * 100) !== esperadoCentavos) {
          pendencias.push(`tribFed/piscofins/${montante}: o valor não comprova o cálculo com a alíquota declarada.`);
        }
      }
    } else {
      for (const aliquota of ['pAliqPis', 'pAliqCofins']) {
        const taxa = Number(pis?.[aliquota]);
        if (!/^\d+(?:\.\d{1,2})?$/.test(String(pis?.[aliquota])) || !Number.isFinite(taxa) || taxa < 0) {
          pendencias.push(`tribFed/piscofins/${aliquota}: a alíquota precisa ser informada.`);
        }
      }
    }
  }
  detectar(trib?.totTrib, ['pTotTribSN','indTotTrib', ...(naoOptante ? ['pTotTrib'] : [])], 'totTrib');
  if (String(dps.prest?.regTrib?.opSimpNac) === '3' && trib?.totTrib?.indTotTrib !== undefined) {
    pendencias.push('A forma de totalização da referência para ME/EPP ainda não é suportada.');
  }
  if (naoOptante) {
    if (dps.prest?.regTrib?.regApTribSN !== undefined) pendencias.push('prest/regTrib/regApTribSN: não informar apuração do Simples para não optante.');
    detectar(trib?.totTrib?.pTotTrib, ['pTotTribFed','pTotTribEst','pTotTribMun'], 'totTrib/pTotTrib');
    if (Object.keys(trib?.totTrib || {}).filter(k => !k.startsWith('@_')).length !== 1) pendencias.push('totTrib: deve existir uma única forma de totalização.');
    const validacao = parametrosEmissaoSchema.safeParse({ ...extrairSugestaoEmissao(xmlObj), vigenciaInicio: '2000-01-01' /* apenas valida o formato; a vigência real é definida na confirmação */ });
    if (!validacao.success) for (const erro of validacao.error.issues) pendencias.push(`${erro.path.join('.')}: ${erro.message}`);
  }
  if (String(dps.prest?.regTrib?.opSimpNac) === '2' && String(trib?.totTrib?.indTotTrib) !== '0') {
    pendencias.push('Confirmar suporte à forma de totalização dos tributos do MEI.');
  }
  const cServ = dps.serv?.cServ || {};
  const servico = { ctribNac: String(cServ.cTribNac || '').padStart(6, '0'),
    ctribMun: cServ.cTribMun ? String(cServ.cTribMun).padStart(3, '0') : null, cnbs: cServ.cNBS ? String(cServ.cNBS) : null };
  const metadadosDanfse = extrairMetadadosDanfseDoXml(xmlObj);
  return { versao: 2 as const, servico, numero: String(nfse.nNFSe || nfse.nDFSe || ''),
    emitidaEm: String(dps.dhEmi || ''), competencia: String(dps.dCompet || ''),
    layout: String(xmlObj.NFSe?.['@_versao'] || nfse.DPS?.['@_versao'] || ''),
    ibscbsPresente: ibscbs.presente, parametrosSugeridos: extrairSugestaoEmissao(xmlObj),
    ...(metadadosDanfse ? { metadadosDanfse } : {}), pendencias };
}
