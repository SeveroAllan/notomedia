import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ResultadoExtracaoComprovante } from '../../atendimento/comprovante.js';

const MARCADOR_NOTA = /nota fiscal|nfs-?e|danfse|nota de servi[cç]o/i;

async function extrairTextoPdf(bytes: Buffer): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true }).promise;
  const partes: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const conteudo = await (await doc.getPage(i)).getTextContent();
    partes.push(conteudo.items.map(item => ('str' in item ? item.str : '')).join('\n'));
  }
  await doc.destroy();
  return partes.join('\n');
}

/** Leitura determinística do texto do PDF (sem IA): valor, data e nomes só saem por padrões explícitos. */
export async function extrairComprovantePdf(base64: string | null): Promise<ResultadoExtracaoComprovante> {
  if (!base64) throw new Error('COMPROVANTE_MIDIA_INDISPONIVEL');
  const bytes = Buffer.from(base64, 'base64');
  let texto: string;
  try { texto = await extrairTextoPdf(bytes); }
  catch { return { tipo: 'ilegivel' }; }
  const linhas = texto.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!linhas.length) return { tipo: 'ilegivel' };

  const valores = [...new Set(linhas.flatMap(l => [...l.matchAll(/\bR\$\s?(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})\b/g)].map(m => m[1])))];
  const valorCentavos = valores.length === 1 ? Math.round(Number(valores[0].replace(/\./g, '').replace(',', '.')) * 100) : null;
  const datas = [...new Set(linhas.flatMap(l => [...l.matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)].map(m => `${m[3]}-${m[2]}-${m[1]}`)))];
  const dataPagamento = datas.length === 1 ? datas[0] : null;
  const rotulo = (padrao: RegExp) => {
    const achados = [...new Set(linhas.map(l => l.match(padrao)?.[1]?.trim()).filter((v): v is string => !!v))];
    return achados.length === 1 ? achados[0] : null;
  };
  const nomePagador = rotulo(/^(?:de|pagador|nome do pagador|origem)\s*[:\-–]?\s*(.+)$/i);
  const nomeFavorecido = rotulo(/^(?:para|favorecido|benefici[aá]rio|recebedor|destino)\s*[:\-–]?\s*(.+)$/i);

  if (MARCADOR_NOTA.test(texto)) {
    const numeroNota = (() => { const m = texto.match(/n[úu]mero\s*(?:da\s*)?(?:nota|nfs-?e)?\s*(?:n[º°.]*\s*|[:\-–]\s*)?(\d{1,20})/i); return m ? m[1] : null; })();
    const emissao = texto.match(/emiss[aã]o\s*[:\-–]?\s*(\d{2}\/\d{2}\/\d{4})/i);
    const dataEmissao = emissao ? `${emissao[1].slice(6)}-${emissao[1].slice(3, 5)}-${emissao[1].slice(0, 2)}` : dataPagamento;
    const tomador = rotulo(/^(?:tomador(?:\s+de\s+servi[cç]os?)?|cliente)\s*[:\-–]?\s*(.+)$/i);
    const confiancaNota: Record<string, number> = {};
    if (numeroNota) confiancaNota.numeroNota = 0.95;
    if (dataEmissao) confiancaNota.dataEmissao = 0.95;
    if (valorCentavos != null) confiancaNota.valorCentavos = 0.95;
    if (tomador) confiancaNota.nomeTomador = 0.95;
    return { tipo: 'nota_pdf', campos: { numeroNota, dataEmissao, valorCentavos, nomeTomador: tomador, confianca: confiancaNota } };
  }
  if (valorCentavos == null && dataPagamento == null) return { tipo: 'nao_comprovante' };
  const confianca: Record<string, number> = {};
  if (valorCentavos != null) confianca.valorCentavos = 0.99;
  if (dataPagamento != null) confianca.dataPagamento = 0.99;
  if (nomePagador) confianca.nomePagador = 0.95;
  if (nomeFavorecido) confianca.nomeFavorecido = 0.95;
  return { tipo: 'extraido', campos: { valorCentavos, dataPagamento, nomePagador, nomeFavorecido, confianca } };
}
