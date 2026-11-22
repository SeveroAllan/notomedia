/**
 * Extrai texto de arquivos PDF (como comprovantes bancários) usando `pdfjs-dist`.
 * Isolado num módulo de I/O próprio para que leitores de comprovante possam
 * aproveitar texto nativo antes de recorrer à visão computacional.
 */

const MAX_PAGINAS_PDF = 4;
const MAX_CARACTERES_PDF = 8000;

export async function extrairTextoPdf(buffer: Buffer): Promise<string> {
  if (!buffer.length) return '';
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true
    }).promise;
    const limitePaginas = Math.min(doc.numPages, MAX_PAGINAS_PDF);
    const partes: string[] = [];
    for (let i = 1; i <= limitePaginas; i++) {
      const pagina = await doc.getPage(i);
      const conteudo = await pagina.getTextContent();
      const linha = conteudo.items
        .map(item => ('str' in item && typeof item.str === 'string' ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (linha) partes.push(linha);
    }
    await doc.destroy().catch(() => undefined);
    return partes.join('\n').slice(0, MAX_CARACTERES_PDF).trim();
  } catch {
    return '';
  }
}
