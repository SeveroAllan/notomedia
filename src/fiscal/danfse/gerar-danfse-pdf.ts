/**
 * Gerador oficial do DANFSe v2.0 (Documento Auxiliar da NFS-e Padrão Nacional) em PDF.
 * Alinhado 100% ao modelo visual e estrutural emitido pelo Portal Nacional da NFS-e
 * (Receita Federal do Brasil / SEFIN e Reforma Tributária do Consumo - RTC 2026).
 */

import { PDFDocument, StandardFonts, type PDFImage } from 'pdf-lib';
import QRCode from 'qrcode';
import type { DanfsePdfOptions } from './danfse-pdf-options.js';
import type { ContextoRenderizacaoDanfse } from './renderizar-secoes-danfse.js';
import { renderizarCabecalho, renderizarDadosNotaEQrCode } from './renderizar-cabecalho-e-nota.js';
import {
  renderizarPrestador,
  renderizarTomador,
  renderizarBarrasDestinatarioEIntermediario
} from './renderizar-participantes.js';
import {
  renderizarServico,
  renderizarTributacaoMunicipal,
  renderizarTributacaoFederalExcetoCbs,
  renderizarTributacaoIbsCbs,
  renderizarValoresTotais,
  renderizarInformacoesComplementares,
  renderizarCanhotoCientificacao,
  renderizarMarcaDagua
} from './renderizar-servicos-e-totais.js';
import { comporChaveAcessoNacional } from './formatadores-fiscais.js';

export async function generateDanfsePdf(options: DanfsePdfOptions = {}): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4 padrão
  const { width, height } = page.getSize();

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const marginX = 18;
  const contentWidth = width - marginX * 2;
  const ctx: ContextoRenderizacaoDanfse = {
    page,
    fontRegular,
    fontBold,
    width,
    height,
    marginX,
    contentWidth,
    currentY: height - 18
  };

  const chaveLimpa = obterOuGerarChave50(options);
  const qrImg = await gerarImagemQrCode(pdfDoc, chaveLimpa);

  // 1. Cabeçalho Oficial (NFSe Logo, DANFSe v2.0, Município)
  renderizarCabecalho(ctx, options);

  // 2. Chave de acesso contínua, Grade 3x3 e QR Code
  renderizarDadosNotaEQrCode(ctx, options, qrImg);

  // 3. Prestador e Fornecedor
  renderizarPrestador(ctx, options.prestador);

  // 4. Tomador e Adquirente
  renderizarTomador(ctx, options.tomador, options.prestador);

  // 5. Barras de Destinatário e Intermediário
  renderizarBarrasDestinatarioEIntermediario(ctx);

  // 6. Serviço Prestado e Discriminação
  renderizarServico(ctx, options.servico, options.prestador);

  // 7. Tributação Municipal (ISSQN)
  renderizarTributacaoMunicipal(ctx, options.servico, options.prestador);

  // 8. Tributação Federal (Exceto CBS)
  renderizarTributacaoFederalExcetoCbs(ctx, options.servico);

  // 9. Tributação IBS/CBS (RTC 2026)
  renderizarTributacaoIbsCbs(ctx, options.servico, options.prestador);

  // 10. Valores Totais da NFS-e
  renderizarValoresTotais(ctx, options.servico);

  // 11. Informações Complementares
  renderizarInformacoesComplementares(ctx, options.servico);

  // 12. Canhoto de Cientificação no rodapé
  renderizarCanhotoCientificacao(ctx, options);

  // 13. Sinalização de Marca d'água (Homologação / Cancelada)
  renderizarMarcaDagua(ctx, options);

  return pdfDoc.save();
}

export const gerarDanfsePdf = generateDanfsePdf;

function obterOuGerarChave50(options: DanfsePdfOptions): string {
  const chaveLimpa = (options.chaveAcesso || '').replace(/\D/g, '');
  if (chaveLimpa.length === 50) return chaveLimpa;

  return comporChaveAcessoNacional({
    codIbgeMunicipio: options.prestador?.municipio || '4314902',
    ambiente: options.ambiente || 'producao',
    anoMes: options.competencia || new Date().toISOString().slice(0, 7),
    cnpjOuCpf: options.prestador?.cnpj || '33841732000190',
    serie: options.serie || '00001',
    ndps: options.numero || '1'
  });
}

async function gerarImagemQrCode(pdfDoc: PDFDocument, chave50: string): Promise<PDFImage | undefined> {
  const qrUrl = `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${chave50}`;

  try {
    const qrBuffer = await QRCode.toBuffer(qrUrl, {
      margin: 1,
      width: 140,
      errorCorrectionLevel: 'M'
    });
    return await pdfDoc.embedPng(qrBuffer);
  } catch {
    return undefined;
  }
}
