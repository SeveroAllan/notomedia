/**
 * Contratos e validações puras da camada de mídia do WhatsApp (áudio, imagem e
 * PDF de comprovantes). Separado de OpenAI, pdfjs e Evolution API para manter
 * limites de tamanho e MIME testáveis sem I/O.
 */

export const LIMITE_BYTES_MIDIA = 10 * 1024 * 1024;

export type TipoMidiaSuportada = 'audio' | 'imagem' | 'pdf';

export interface MidiaBaixada {
  buffer: Buffer;
  mimetype: string;
  nomeArquivo?: string;
}

export type MeioPagamentoComprovante = 'pix' | 'ted' | 'cartao' | 'boleto' | 'dinheiro' | 'outro';

export interface DadosComprovanteExtraido {
  ehComprovante: boolean;
  confianca: 'alta' | 'media' | 'baixa';
  valorCentavos: number | null;
  dataPagamento: string | null;
  nomePagador: string | null;
  cpfPagador: string | null;
  meioPagamento: MeioPagamentoComprovante | null;
  identificadorTransacao: string | null;
  resumoCurto?: string | null;
}

export interface PortaBaixarMidia {
  baixarBase64(instancia: string, mensagemId: string): Promise<{ base64?: string; mimetype?: string } | null>;
}

export interface PortaTranscreverAudio {
  transcrever(midia: MidiaBaixada): Promise<{ ok: true; texto: string } | { ok: false; motivo: string }>;
}

export interface PortaLerComprovante {
  ler(midia: MidiaBaixada): Promise<{ ok: true; dados: DadosComprovanteExtraido } | { ok: false; motivo: string }>;
}

export function classificarMimetypeMidia(mimetype: string): TipoMidiaSuportada | null {
  const limpo = mimetype.split(';')[0]?.trim().toLowerCase() ?? '';
  if (limpo.startsWith('audio/')) return 'audio';
  if (['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(limpo)) return 'imagem';
  if (limpo === 'application/pdf') return 'pdf';
  return null;
}

export function decodificarBase64Midia(
  base64Bruto: string | undefined,
  mimetypeBruto: string | undefined
): { ok: true; midia: MidiaBaixada; tipo: TipoMidiaSuportada } | { ok: false; motivo: string } {
  if (!base64Bruto?.trim()) return { ok: false, motivo: 'MIDIA_VAZIA' };
  const semPrefixo = base64Bruto.includes(';base64,')
    ? base64Bruto.slice(base64Bruto.indexOf(';base64,') + 8)
    : base64Bruto.trim();
  const mimetype = (mimetypeBruto?.trim() || extrairMimeDataUri(base64Bruto) || '').toLowerCase();
  const tipo = classificarMimetypeMidia(mimetype);
  if (!tipo) return { ok: false, motivo: 'MIMETYPE_NAO_SUPORTADO' };

  const buffer = Buffer.from(semPrefixo, 'base64');
  if (!buffer.length) return { ok: false, motivo: 'MIDIA_VAZIA' };
  if (buffer.length > LIMITE_BYTES_MIDIA) return { ok: false, motivo: 'MIDIA_ACIMA_DO_LIMITE' };
  return { ok: true, midia: { buffer, mimetype }, tipo };
}

function extrairMimeDataUri(valor: string): string | null {
  const m = /^data:([^;]+);base64,/i.exec(valor);
  return m?.[1]?.trim() ?? null;
}
