/**
 * Renderização dos blocos de serviços, tributação municipal (ISSQN),
 * tributação federal (exceto CBS), tributação IBS/CBS (RTC 2026),
 * valores totais, informações complementares e canhoto de cientificação.
 * Segue 1:1 o layout oficial do Portal Nacional da NFS-e.
 */

import { degrees, rgb } from 'pdf-lib';
import type { DanfsePdfOptions, DanfseServico, DanfsePrestador } from './danfse-pdf-options.js';
import {
  type ContextoRenderizacaoDanfse,
  CORES_DANFSE,
  desenharCaixa,
  desenharCelula
} from './renderizar-secoes-danfse.js';
import { resolverNomeMunicipio } from './formatadores-fiscais.js';

function formatarReaisDanfse(valor?: number): string {
  if (valor === undefined || !Number.isFinite(valor)) return '-';
  return `R$ ${valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatarPctDanfse(valor?: number): string {
  if (valor === undefined || !Number.isFinite(valor)) return '-';
  return `${valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

export function renderizarServico(
  ctx: ContextoRenderizacaoDanfse,
  servico: DanfseServico = {},
  prestador: DanfsePrestador = {}
): void {
  const rowH = 16;
  let y = ctx.currentY;

  // Linha 1: Título | Código Trib Nac/Mun | Código NBS | Local da Prestação
  const municipio = servico.municipioPrestacao ?? prestador.municipio;
  const munNome = resolverNomeMunicipio(municipio, municipio);
  const uf = (servico.ufPrestacao || prestador.uf || '-').toUpperCase();
  const locPrest = `${munNome} / ${uf} / BR`;

  desenharCelula(ctx, ctx.marginX, y, 130, rowH, '', 'SERVIÇO PRESTADO', true);
  desenharCelula(ctx, ctx.marginX + 130, y, 140, rowH, 'Código de Tributação Nacional/Municipal', `${servico.cTribNac || '-'} / ${servico.cTribMun || '-'}`);
  desenharCelula(ctx, ctx.marginX + 270, y, 145, rowH, 'Código da NBS', servico.cNBS || '-');
  desenharCelula(ctx, ctx.marginX + 415, y, ctx.contentWidth - 415, rowH, 'Local da Prestação / Sigla UF / País', locPrest);
  y -= rowH;

  // Linha 2: Descrição da atividade e Discriminação dos Serviços
  const descH = 26;
  desenharCaixa(ctx, ctx.marginX, y - descH, ctx.contentWidth, descH);

  // Sub-descrição da NBS (linha superior)
  const subTexto = servico.descricaoAtividade
    || 'Atos e procedimentos médicos, consultas clínicas, diagnósticos e atendimentos profissionais em saúde humana.';
  ctx.page.drawText(subTexto, {
    x: ctx.marginX + 3,
    y: y - 7.5,
    size: 5.5,
    font: ctx.fontRegular,
    color: CORES_DANFSE.grayText
  });

  // Label Descrição do Serviço
  ctx.page.drawText('Descrição do Serviço', {
    x: ctx.marginX + 3,
    y: y - 14.5,
    size: 5.5,
    font: ctx.fontBold,
    color: CORES_DANFSE.black
  });

  // Conteúdo real digitado pelo médico
  const descReal = servico.discriminacao || 'Serviços médicos profissionais.';
  const maxChars = Math.floor(ctx.contentWidth / 4.4);
  const descDisplay = descReal.length > maxChars ? `${descReal.slice(0, maxChars - 3)}...` : descReal;

  ctx.page.drawText(descDisplay, {
    x: ctx.marginX + 3,
    y: y - 22,
    size: 6.8,
    font: ctx.fontRegular,
    color: CORES_DANFSE.black
  });
  y -= descH;

  ctx.currentY = y;
}

export function renderizarTributacaoMunicipal(
  ctx: ContextoRenderizacaoDanfse,
  servico: DanfseServico = {},
  prestador: DanfsePrestador = {}
): void {
  const rowH = 16;
  let y = ctx.currentY;
  const municipio = servico.municipioPrestacao ?? prestador.municipio;
  const munNome = resolverNomeMunicipio(municipio, municipio);
  const uf = (servico.ufPrestacao || prestador.uf || '-').toUpperCase();
  const incidMun = municipio ? `${munNome} / ${uf} / BR` : '-';

  // Linha 1
  desenharCelula(ctx, ctx.marginX, y, 170, rowH, '', 'TRIBUTAÇÃO MUNICIPAL (ISSQN)', true);
  desenharCelula(ctx, ctx.marginX + 170, y, 175, rowH, 'Tipo de Tributação do ISSQN', servico.tipoTributacao ?? '-');
  desenharCelula(ctx, ctx.marginX + 345, y, ctx.contentWidth - 345, rowH, 'Município / Sigla UF / País de Incidência do ISSQN', incidMun);
  y -= rowH;

  // Linha 2
  const cW4 = ctx.contentWidth / 4;
  desenharCelula(ctx, ctx.marginX, y, cW4, rowH, 'BC ISSQN', formatarReaisDanfse(servico.baseCalculoIss));
  desenharCelula(ctx, ctx.marginX + cW4, y, cW4, rowH, 'Alíquota Aplicada', formatarPctDanfse(servico.aliquota));
  desenharCelula(ctx, ctx.marginX + cW4 * 2, y, cW4, rowH, 'Retenção do ISSQN', servico.tipoRetencao ?? '-');
  desenharCelula(ctx, ctx.marginX + cW4 * 3, y, ctx.contentWidth - cW4 * 3, rowH, 'ISSQN Apurado', formatarReaisDanfse(servico.issApurado));
  y -= rowH;

  ctx.currentY = y;
}

export function renderizarTributacaoFederalExcetoCbs(
  ctx: ContextoRenderizacaoDanfse,
  servico: DanfseServico = {}
): void {
  const rowH = 16;
  let y = ctx.currentY;

  // Linha 1
  const cW3Dir = (ctx.contentWidth - 170) / 3;
  desenharCelula(ctx, ctx.marginX, y, 170, rowH, '', 'TRIBUTAÇÃO FEDERAL (EXCETO CBS)', true);
  desenharCelula(ctx, ctx.marginX + 170, y, cW3Dir, rowH, 'IRRF', '-');
  desenharCelula(ctx, ctx.marginX + 170 + cW3Dir, y, cW3Dir, rowH, 'Contribuição Previdenciária - Retida', '-');
  desenharCelula(ctx, ctx.marginX + 170 + cW3Dir * 2, y, ctx.contentWidth - 170 - cW3Dir * 2, rowH, 'Contribuições Sociais - Retidas', '-');
  y -= rowH;

  // Linha 2
  const pisTexto = servico.valorPis !== undefined
    ? `${formatarReaisDanfse(servico.valorPis)} (${formatarPctDanfse(servico.aliquotaPis)})`
    : '-';
  const cofinsTexto = servico.valorCofins !== undefined
    ? `${formatarReaisDanfse(servico.valorCofins)} (${formatarPctDanfse(servico.aliquotaCofins)})`
    : '-';
  desenharCelula(ctx, ctx.marginX, y, 170, rowH, 'PIS - Débito Apuração Própria', pisTexto);
  desenharCelula(ctx, ctx.marginX + 170, y, 175, rowH, 'COFINS - Débito Apuração Própria', cofinsTexto);
  desenharCelula(ctx, ctx.marginX + 345, y, ctx.contentWidth - 345, rowH, 'Descrição Contrib. Sociais - Retidas', servico.retencaoPisCofinsTexto ?? '-');
  y -= rowH;

  ctx.currentY = y;
}

export function renderizarTributacaoIbsCbs(
  ctx: ContextoRenderizacaoDanfse,
  servico: DanfseServico = {},
  prestador: DanfsePrestador = {}
): void {
  const rowH = 16;
  let y = ctx.currentY;
  const codIbge = servico.municipioPrestacao ?? prestador.municipio;
  const munNome = codIbge ? resolverNomeMunicipio(codIbge, codIbge) : '-';
  const uf = (servico.ufPrestacao || prestador.uf || '-').toUpperCase();
  const cstClass = servico.cstIbsCbs || servico.cClassTrib
    ? `${servico.cstIbsCbs || '-'} / ${servico.cClassTrib || '-'}`
    : '- / -';
  const linhaIndOp = servico.cIndOp
    ? `${servico.cIndOp} / ${codIbge || '-'} / ${munNome} / ${uf}`
    : '- / - / - / -';

  // Linha 1
  desenharCelula(ctx, ctx.marginX, y, 140, rowH, '', 'TRIBUTAÇÃO IBS/CBS', true);
  desenharCelula(ctx, ctx.marginX + 140, y, 140, rowH, 'CST / cClassTrib', cstClass);
  desenharCelula(ctx, ctx.marginX + 280, y, ctx.contentWidth - 280, rowH, 'Indicador de Operação / Código IBGE Incidência / Município Incidência / Sigla UF', linhaIndOp);
  y -= rowH;

  // Linha 2
  const cW4 = ctx.contentWidth / 4;
  const aliqIbsPar = servico.aliquotaIbsUf !== undefined || servico.aliquotaIbsMun !== undefined
    ? `${formatarPctDanfse(servico.aliquotaIbsUf)} / ${formatarPctDanfse(servico.aliquotaIbsMun)}`
    : '- / -';
  desenharCelula(ctx, ctx.marginX, y, cW4, rowH, 'Exclusões e Reduções da Base de Cálculo', servico.baseCalculoIbsCbs !== undefined ? formatarReaisDanfse(0) : '-');
  desenharCelula(ctx, ctx.marginX + cW4, y, cW4, rowH, 'Base de Cálculo Após Exclusões e Reduções', formatarReaisDanfse(servico.baseCalculoIbsCbs));
  desenharCelula(ctx, ctx.marginX + cW4 * 2, y, cW4, rowH, 'Red. Alíquota IBS / Red. Alíquota CBS', servico.baseCalculoIbsCbs !== undefined ? '0,00% / 0,00%' : '- / -');
  desenharCelula(ctx, ctx.marginX + cW4 * 3, y, ctx.contentWidth - cW4 * 3, rowH, 'Alíquota - IBS UF / IBS Mun', aliqIbsPar);
  y -= rowH;

  // Linha 3
  desenharCelula(ctx, ctx.marginX, y, cW4, rowH, 'Aliq. Efetiva Municipal - IBS', formatarPctDanfse(servico.aliquotaIbsMun));
  desenharCelula(ctx, ctx.marginX + cW4, y, cW4, rowH, 'Valor Apurado Municipal - IBS', formatarReaisDanfse(servico.valorIbsMun));
  desenharCelula(ctx, ctx.marginX + cW4 * 2, y, cW4, rowH, 'Aliq. Efetiva Estadual - IBS', formatarPctDanfse(servico.aliquotaIbsUf));
  desenharCelula(ctx, ctx.marginX + cW4 * 3, y, ctx.contentWidth - cW4 * 3, rowH, 'Valor Apurado Estadual - IBS', formatarReaisDanfse(servico.valorIbsUf));
  y -= rowH;

  // Linha 4
  desenharCelula(ctx, ctx.marginX, y, cW4, rowH, 'Valor Total Apurado - IBS', formatarReaisDanfse(servico.valorIbsTotal ?? servico.valorIbs));
  desenharCelula(ctx, ctx.marginX + cW4, y, cW4, rowH, 'Alíquota - CBS', formatarPctDanfse(servico.aliquotaCbs));
  desenharCelula(ctx, ctx.marginX + cW4 * 2, y, cW4, rowH, 'Alíquota Efetiva - CBS', formatarPctDanfse(servico.aliquotaCbs));
  desenharCelula(ctx, ctx.marginX + cW4 * 3, y, ctx.contentWidth - cW4 * 3, rowH, 'Valor Total Apurado - CBS', formatarReaisDanfse(servico.valorCbs));
  y -= rowH;

  ctx.currentY = y;
}

export function renderizarValoresTotais(ctx: ContextoRenderizacaoDanfse, servico: DanfseServico = {}): void {
  const rowH = 16;
  let y = ctx.currentY;
  const cW4 = ctx.contentWidth / 4;
  const vServ = formatarReaisDanfse(servico.valor || 0);
  const vRetencoes = servico.retencoes && servico.retencoes > 0 ? formatarReaisDanfse(servico.retencoes) : '-';
  const vLiquido = formatarReaisDanfse(Math.max(0, (servico.valor || 0) - (servico.retencoes || 0) - (servico.desconto || 0)));

  // Linha 1
  desenharCelula(ctx, ctx.marginX, y, cW4, rowH, '', 'VALOR TOTAL DA NFS-e', true);
  desenharCelula(ctx, ctx.marginX + cW4, y, cW4, rowH, 'VALOR DA OPERAÇÃO / SERVIÇO', vServ, true);
  desenharCelula(ctx, ctx.marginX + cW4 * 2, y, cW4, rowH, 'Desconto Incondicionado', servico.desconto ? formatarReaisDanfse(servico.desconto) : '-');
  desenharCelula(ctx, ctx.marginX + cW4 * 3, y, ctx.contentWidth - cW4 * 3, rowH, 'Desconto Condicionado', '-');
  y -= rowH;

  // Linha 2
  desenharCelula(ctx, ctx.marginX, y, cW4, rowH, 'Total das Retenções (ISSQN / Federais)', vRetencoes);
  desenharCelula(ctx, ctx.marginX + cW4, y, cW4, rowH, 'VALOR LÍQUIDO DA NFS-e', vLiquido, true);
  desenharCelula(ctx, ctx.marginX + cW4 * 2, y, cW4, rowH, 'Total do IBS/CBS', formatarReaisDanfse(servico.totalIbsCbs));
  desenharCelula(ctx, ctx.marginX + cW4 * 3, y, ctx.contentWidth - cW4 * 3, rowH, 'VALOR LÍQUIDO DA NFS-e + IBS/CBS', servico.totalIbsCbs !== undefined ? vLiquido : '-');
  y -= rowH;

  ctx.currentY = y;
}

export function renderizarInformacoesComplementares(
  ctx: ContextoRenderizacaoDanfse,
  servico: DanfseServico = {}
): void {
  const h = 26;
  desenharCaixa(ctx, ctx.marginX, ctx.currentY - h, ctx.contentWidth, h);

  ctx.page.drawText('INFORMAÇÕES COMPLEMENTARES', {
    x: ctx.marginX + 3,
    y: ctx.currentY - 8,
    size: 5.5,
    font: ctx.fontBold,
    color: CORES_DANFSE.black
  });

  const tot = servico.totalTributosAproximados;
  let texto = 'Totais aproximados dos Tributos cfe. Lei n° 12.741/2012: Federais: -; Estaduais: -; Municipais: -;';
  if (tot?.federalPct !== undefined || tot?.municipalPct !== undefined) {
    const fed = `${formatarReaisDanfse(tot.federalValor)} (${formatarPctDanfse(tot.federalPct)})`;
    const est = `${formatarReaisDanfse(tot.estadualValor)} (${formatarPctDanfse(tot.estadualPct)})`;
    const mun = `${formatarReaisDanfse(tot.municipalValor)} (${formatarPctDanfse(tot.municipalPct)})`;
    texto = `Totais aproximados dos Tributos cfe. Lei n° 12.741/2012: Federais: ${fed}; Estaduais: ${est}; Municipais: ${mun};`;
  } else if (tot?.snPct !== undefined) {
    texto = `Totais aproximados dos Tributos (Simples Nacional) cfe. Lei n° 12.741/2012: ${formatarReaisDanfse(tot.snValor)} (${formatarPctDanfse(tot.snPct)});`;
  }

  ctx.page.drawText(texto, {
    x: ctx.marginX + 3,
    y: ctx.currentY - 17,
    size: 6,
    font: ctx.fontRegular,
    color: CORES_DANFSE.black
  });

  ctx.currentY -= h;
}

export function renderizarCanhotoCientificacao(
  ctx: ContextoRenderizacaoDanfse,
  options: DanfsePdfOptions
): void {
  const yBottom = 20;
  const h = 22;
  const col1W = 145;
  const col2W = 195;

  // Caixa externa
  desenharCaixa(ctx, ctx.marginX, yBottom, ctx.contentWidth, h);

  // Linhas verticais separadoras
  ctx.page.drawLine({
    start: { x: ctx.marginX + col1W, y: yBottom },
    end: { x: ctx.marginX + col1W, y: yBottom + h },
    thickness: 0.5,
    color: CORES_DANFSE.border
  });
  ctx.page.drawLine({
    start: { x: ctx.marginX + col1W + col2W, y: yBottom },
    end: { x: ctx.marginX + col1W + col2W, y: yBottom + h },
    thickness: 0.5,
    color: CORES_DANFSE.border
  });

  // Coluna 1: Data Cientificação
  ctx.page.drawText('DATA CIENTIFICAÇÃO:', {
    x: ctx.marginX + 3,
    y: yBottom + h - 8,
    size: 6,
    font: ctx.fontBold,
    color: CORES_DANFSE.black
  });

  // Coluna 2: Identificação e Assinatura
  ctx.page.drawText('IDENTIFICAÇÃO E ASSINATURA', {
    x: ctx.marginX + col1W + 3,
    y: yBottom + h - 8,
    size: 6,
    font: ctx.fontBold,
    color: CORES_DANFSE.black
  });

  // Coluna 3: N° NFS-e / Chave
  const xCol3 = ctx.marginX + col1W + col2W;
  ctx.page.drawText('N° NFS-e / CHAVE NFS-e', {
    x: xCol3 + 3,
    y: yBottom + h - 8,
    size: 6,
    font: ctx.fontBold,
    color: CORES_DANFSE.black
  });

  const num = options.numero || '1';
  const chaveLimpa = (options.chaveAcesso || '').replace(/\D/g, '');
  ctx.page.drawText(`${num} / ${chaveLimpa}`, {
    x: xCol3 + 3,
    y: yBottom + 5,
    size: 5.8,
    font: ctx.fontRegular,
    color: CORES_DANFSE.black
  });
}

export function renderizarMarcaDagua(ctx: ContextoRenderizacaoDanfse, options: DanfsePdfOptions): void {
  if (options.cancelada) {
    ctx.page.drawText('CANCELADA', {
      x: ctx.width / 2 - 170,
      y: ctx.height / 2 - 40,
      size: 62,
      font: ctx.fontBold,
      color: rgb(0.9, 0.15, 0.15),
      opacity: 0.28,
      rotate: degrees(35)
    });
    return;
  }

  if (options.ambiente === 'homologacao' && options.contingenciaHomologacao) {
    ctx.page.drawText('HOMOLOGAÇÃO OFFLINE - SEM VALOR FISCAL', {
      x: ctx.width / 2 - 235,
      y: ctx.height / 2 - 20,
      size: 21,
      font: ctx.fontBold,
      color: rgb(0.85, 0.15, 0.15),
      opacity: 0.25,
      rotate: degrees(30)
    });
    ctx.page.drawText('DPS ASSINADA COM A1 (SEFIN HOMOLOGAÇÃO INDISPONÍVEL)', {
      x: ctx.width / 2 - 210,
      y: ctx.height / 2 - 52,
      size: 13,
      font: ctx.fontBold,
      color: rgb(0.85, 0.15, 0.15),
      opacity: 0.25,
      rotate: degrees(30)
    });
    return;
  }

  if (options.ambiente === 'homologacao') {
    ctx.page.drawText('NFS-e SEM VALIDADE JURÍDICA', {
      x: ctx.width / 2 - 225,
      y: ctx.height / 2 - 40,
      size: 30,
      font: ctx.fontBold,
      color: rgb(0.85, 0.15, 0.15),
      opacity: 0.2,
      rotate: degrees(30)
    });
  }
}
