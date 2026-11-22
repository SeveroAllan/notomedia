/**
 * Renderização do Cabeçalho Oficial e Dados da Nota Fiscal com QR Code (Bandas 1 e 2).
 * Reproduz com fidelidade absoluta o modelo do Portal Nacional da NFS-e (DANFSe v2.0):
 * Logomarca oficial, Chave de Acesso contínua de 50 dígitos, grade 3x3 e QR Code.
 */

import type { PDFImage } from 'pdf-lib';
import type { DanfsePdfOptions } from './danfse-pdf-options.js';
import {
  type ContextoRenderizacaoDanfse,
  CORES_DANFSE,
  desenharCaixa,
  desenharCelula,
  desenharLogoNfseNacional
} from './renderizar-secoes-danfse.js';
import {
  resolverNomeMunicipio,
  comporChaveAcessoNacional
} from './formatadores-fiscais.js';

export function renderizarCabecalho(
  ctx: ContextoRenderizacaoDanfse,
  options: DanfsePdfOptions
): void {
  const h = 42;
  desenharCaixa(ctx, ctx.marginX, ctx.currentY - h, ctx.contentWidth, h);

  // 1. Logotipo oficial da NFS-e
  desenharLogoNfseNacional(ctx, ctx.marginX + 8, ctx.currentY - 4);

  // Linhas divisórias verticais
  const col1W = 150;
  const col2W = 255;
  const xDiv1 = ctx.marginX + col1W;
  const xDiv2 = xDiv1 + col2W;

  ctx.page.drawLine({
    start: { x: xDiv1, y: ctx.currentY },
    end: { x: xDiv1, y: ctx.currentY - h },
    thickness: 0.5,
    color: CORES_DANFSE.border
  });
  ctx.page.drawLine({
    start: { x: xDiv2, y: ctx.currentY },
    end: { x: xDiv2, y: ctx.currentY - h },
    thickness: 0.5,
    color: CORES_DANFSE.border
  });

  // 2. Títulos Centrais
  const centroX = xDiv1 + col2W / 2;
  const t1 = 'DANFSe v2.0';
  const t2 = 'Documento Auxiliar da NFS-e';
  const w1 = ctx.fontBold.widthOfTextAtSize(t1, 11);
  const w2 = ctx.fontBold.widthOfTextAtSize(t2, 9.5);

  ctx.page.drawText(t1, {
    x: centroX - w1 / 2,
    y: ctx.currentY - 17,
    size: 11,
    font: ctx.fontBold,
    color: CORES_DANFSE.black
  });
  ctx.page.drawText(t2, {
    x: centroX - w2 / 2,
    y: ctx.currentY - 29,
    size: 9.5,
    font: ctx.fontBold,
    color: CORES_DANFSE.black
  });

  // 3. Informações da Direita (Município e Ambientes)
  const nomeMun = resolverNomeMunicipio(options.prestador?.municipio, options.prestador?.municipio);
  const uf = (options.prestador?.uf || 'RS').toUpperCase();
  const dirX = xDiv2 + 6;

  ctx.page.drawText(`Município: ${nomeMun} - ${uf}`, {
    x: dirX,
    y: ctx.currentY - 14,
    size: 7,
    font: ctx.fontRegular,
    color: CORES_DANFSE.black
  });
  ctx.page.drawText('Ambiente Gerador: 2', {
    x: dirX,
    y: ctx.currentY - 24,
    size: 7,
    font: ctx.fontRegular,
    color: CORES_DANFSE.black
  });
  const codAmbiente = options.ambiente === 'homologacao' ? '2' : '1';
  ctx.page.drawText(`Tipo de Ambiente: ${codAmbiente}`, {
    x: dirX,
    y: ctx.currentY - 34,
    size: 7,
    font: ctx.fontRegular,
    color: CORES_DANFSE.black
  });

  ctx.currentY -= h;
}

export function renderizarDadosNotaEQrCode(
  ctx: ContextoRenderizacaoDanfse,
  options: DanfsePdfOptions,
  qrImg?: PDFImage
): void {
  const dadosNfseH = 82;
  const qrColW = 120;
  const dadosColW = ctx.contentWidth - qrColW;
  desenharCaixa(ctx, ctx.marginX, ctx.currentY - dadosNfseH, ctx.contentWidth, dadosNfseH);

  // Linha vertical separando dados do QR Code
  ctx.page.drawLine({
    start: { x: ctx.marginX + dadosColW, y: ctx.currentY },
    end: { x: ctx.marginX + dadosColW, y: ctx.currentY - dadosNfseH },
    thickness: 0.5,
    color: CORES_DANFSE.border
  });

  // 1. Chave de acesso contínua de 50 dígitos no topo
  const chave = obterChave50Digitos(options);
  ctx.page.drawText('CHAVE DE ACESSO DA NFS-e', {
    x: ctx.marginX + 3,
    y: ctx.currentY - 8,
    size: 6.5,
    font: ctx.fontBold,
    color: CORES_DANFSE.black
  });
  ctx.page.drawText(chave, {
    x: ctx.marginX + 3,
    y: ctx.currentY - 17,
    size: 7.5,
    font: ctx.fontRegular,
    color: CORES_DANFSE.black
  });

  // Linha horizontal sob a chave de acesso
  ctx.page.drawLine({
    start: { x: ctx.marginX, y: ctx.currentY - 21 },
    end: { x: ctx.marginX + dadosColW, y: ctx.currentY - 21 },
    thickness: 0.5,
    color: CORES_DANFSE.border
  });

  renderizarGrade3x3(ctx, dadosColW, options);
  renderizarQuadroQrCode(ctx, dadosColW, qrColW, qrImg);

  ctx.currentY -= dadosNfseH;
}

function obterChave50Digitos(options: DanfsePdfOptions): string {
  const digitos = (options.chaveAcesso || '').replace(/\D/g, '');
  if (digitos.length === 50) return digitos;

  return comporChaveAcessoNacional({
    codIbgeMunicipio: options.prestador?.municipio || '4314902',
    ambiente: options.ambiente || 'producao',
    anoMes: options.competencia || new Date().toISOString().slice(0, 7),
    cnpjOuCpf: options.prestador?.cnpj || '33841732000190',
    serie: options.serie || '00001',
    ndps: options.numero || '1'
  });
}

function renderizarGrade3x3(
  ctx: ContextoRenderizacaoDanfse,
  dadosColW: number,
  options: DanfsePdfOptions
): void {
  const cW3 = dadosColW / 3;
  const rowH = 20;
  let rY = ctx.currentY - 21;

  const dataEmissao = options.dataEmissao || new Date().toISOString();
  const dataFmt = formatarDataHora(dataEmissao);
  const dataApenas = dataEmissao.slice(0, 10).split('-').reverse().join('/');

  // Linha 1
  const competenciaFmt = formatarCompetencia(options.competencia) || dataApenas;
  desenharCelula(ctx, ctx.marginX, rY, cW3, rowH, 'NÚMERO DA NFS-e', options.numero || '1', true);
  desenharCelula(ctx, ctx.marginX + cW3, rY, cW3, rowH, 'COMPETÊNCIA DA NFS-e', competenciaFmt);
  desenharCelula(ctx, ctx.marginX + cW3 * 2, rY, cW3, rowH, 'DATA E HORA DA EMISSÃO DA NFS-e', dataFmt);

  // Linha 2
  rY -= rowH;
  desenharCelula(ctx, ctx.marginX, rY, cW3, rowH, 'NÚMERO DA DPS', options.numero || '1', false);
  desenharCelula(ctx, ctx.marginX + cW3, rY, cW3, rowH, 'SÉRIE DA DPS', options.serie || '70000', false);
  desenharCelula(ctx, ctx.marginX + cW3 * 2, rY, cW3, rowH, 'DATA E HORA DA EMISSÃO DA DPS', dataFmt);

  // Linha 3
  rY -= rowH;
  const situacao = options.cancelada
    ? 'CANCELADA'
    : options.contingenciaHomologacao
      ? 'HOMOLOGAÇÃO (CONTINGÊNCIA)'
      : 'EMITIDA COM SUCESSO';
  desenharCelula(ctx, ctx.marginX, rY, cW3, 21, 'EMITENTE DA NFS-e', 'Prestador', false);
  desenharCelula(ctx, ctx.marginX + cW3, rY, cW3, 21, 'SITUAÇÃO DA NFS-e', situacao, true);
  desenharCelula(ctx, ctx.marginX + cW3 * 2, rY, cW3, 21, 'FINALIDADE', options.finalidade || 'NFS-e Regular');
}

function formatarCompetencia(competencia?: string): string {
  if (!competencia) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(competencia)) return competencia.split('-').reverse().join('/');
  if (/^\d{4}-\d{2}$/.test(competencia)) return `${competencia.slice(5, 7)}/${competencia.slice(0, 4)}`;
  return competencia;
}

function formatarDataHora(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    const dia = String(d.getDate()).padStart(2, '0');
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const ano = d.getFullYear();
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return `${dia}/${mes}/${ano} ${h}:${m}:${s}`;
  } catch {
    return isoString;
  }
}

function renderizarQuadroQrCode(
  ctx: ContextoRenderizacaoDanfse,
  dadosColW: number,
  qrColW: number,
  qrImg?: PDFImage
): void {
  const qrBoxX = ctx.marginX + dadosColW;
  if (qrImg) {
    ctx.page.drawImage(qrImg, {
      x: qrBoxX + (qrColW - 52) / 2,
      y: ctx.currentY - 52 - 4,
      width: 52,
      height: 52
    });
  }

  const t1 = 'A autenticidade desta NFS-e pode ser verificada';
  const t2 = 'pela leitura deste código QR ou pela consulta da';
  const t3 = 'chave de acesso no portal nacional da NFS-e';
  const cx = qrBoxX + qrColW / 2;

  drawCenteredText(ctx, t1, cx, ctx.currentY - 62, 4.8);
  drawCenteredText(ctx, t2, cx, ctx.currentY - 69, 4.8);
  drawCenteredText(ctx, t3, cx, ctx.currentY - 76, 4.8);
}

function drawCenteredText(
  ctx: ContextoRenderizacaoDanfse,
  text: string,
  cx: number,
  y: number,
  size: number
): void {
  const w = ctx.fontRegular.widthOfTextAtSize(text, size);
  ctx.page.drawText(text, {
    x: cx - w / 2,
    y,
    size,
    font: ctx.fontRegular,
    color: CORES_DANFSE.black
  });
}
