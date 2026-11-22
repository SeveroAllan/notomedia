/**
 * Extrai metadados complementares de exibição do XML oficial da NFS-e Nacional
 * (endereço/contato do emitente, alíquota ISSQN aplicada, descrições xTribNac/xNBS
 * e alíquotas IBS/CBS do grupo infNFSe) para compor fielmente o DANFSe v2.0.
 * Mantido puro e separado de `analisar-referencia-fiscal.ts` sem alterar `parametrosSugeridos`.
 */

export interface MetadadosDanfseReferencia {
  prestador?: {
    endereco?: string;
    cep?: string;
    telefone?: string;
    email?: string;
  };
  aliquotaIssAplicada?: number;
  descricaoTribNac?: string;
  descricaoNbs?: string;
  ibscbsAliquotas?: {
    pIbsUf?: number;
    pIbsMun?: number;
    pCbs?: number;
  };
}

function numeroValido(valor: unknown): number | undefined {
  if (valor === undefined || valor === null || valor === '') return undefined;
  const n = Number(String(valor).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function textoLimpo(valor: unknown): string | undefined {
  const s = String(valor ?? '').trim();
  return s || undefined;
}

function montarEnderecoEmitente(enderNac: any): string | undefined {
  if (!enderNac || typeof enderNac !== 'object') return undefined;
  const partes = [
    textoLimpo(enderNac.xLgr),
    textoLimpo(enderNac.nro),
    textoLimpo(enderNac.xCpl),
    textoLimpo(enderNac.xBairro)
  ].filter(Boolean);
  return partes.length ? partes.join(', ') : undefined;
}

export function extrairMetadadosDanfseDoXml(xmlObj: any): MetadadosDanfseReferencia | undefined {
  const raiz = xmlObj?.NFSe || xmlObj?.compNFSe || xmlObj?.nfse || xmlObj || {};
  const infNfse = raiz.infNFSe || raiz;
  const infDps = infNfse.DPS?.infDPS || infNfse.infDPS || {};
  const emit = infNfse.emit || {};
  const prest = infDps.prest || {};

  const endereco = montarEnderecoEmitente(emit.enderNac);
  const cep = textoLimpo(emit.enderNac?.CEP)?.replace(/\D/g, '') || undefined;
  const telefone = textoLimpo(prest.fone) ?? textoLimpo(emit.fone);
  const email = textoLimpo(prest.email) ?? textoLimpo(emit.email);

  const aliquotaIssAplicada =
    numeroValido(infNfse.valores?.pAliqAplic)
    ?? numeroValido(infDps.valores?.trib?.tribMun?.pAliq);

  const descricaoTribNac = textoLimpo(infNfse.xTribNac);
  const descricaoNbs = textoLimpo(infNfse.xNBS);

  const ibsVals = infNfse.IBSCBS?.valores || {};
  const pIbsUf = numeroValido(ibsVals.uf?.pAliqEfetUF ?? ibsVals.uf?.pIBSUF);
  const pIbsMun = numeroValido(ibsVals.mun?.pAliqEfetMun ?? ibsVals.mun?.pIBSMun);
  const pCbs = numeroValido(ibsVals.fed?.pAliqEfetCBS ?? ibsVals.fed?.pCBS);

  const temPrestador = Boolean(endereco || cep || telefone || email);
  const temIbsCbs = pIbsUf !== undefined || pIbsMun !== undefined || pCbs !== undefined;

  if (!temPrestador && aliquotaIssAplicada === undefined && !descricaoTribNac && !descricaoNbs && !temIbsCbs) {
    return undefined;
  }

  return {
    ...(temPrestador ? { prestador: { ...(endereco ? { endereco } : {}), ...(cep ? { cep } : {}), ...(telefone ? { telefone } : {}), ...(email ? { email } : {}) } } : {}),
    ...(aliquotaIssAplicada !== undefined ? { aliquotaIssAplicada } : {}),
    ...(descricaoTribNac ? { descricaoTribNac } : {}),
    ...(descricaoNbs ? { descricaoNbs } : {}),
    ...(temIbsCbs ? { ibscbsAliquotas: { ...(pIbsUf !== undefined ? { pIbsUf } : {}), ...(pIbsMun !== undefined ? { pIbsMun } : {}), ...(pCbs !== undefined ? { pCbs } : {}) } } : {})
  };
}
