import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extrairComprovantePdf } from '../src/io/pdf/extrator-comprovante-pdf.js';

async function pdfCom(linhas: string[]): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  linhas.forEach((l, i) => page.drawText(l, { x: 50, y: 780 - i * 18, size: 12, font }));
  return Buffer.from(await doc.save()).toString('base64');
}

describe('extrairComprovantePdf (determinístico, sem IA)', () => {
  it('extrai valor, data e nomes rotulados de um comprovante em PDF', async () => {
    const base64 = await pdfCom([
      'Comprovante de Transferência Pix', 'Valor: R$ 250,00', 'Data: 15/10/2026',
      'De: Paciente Fictício da Silva', 'Para: Médica Fictícia Xavier', 'Instituição: Banco Fictício S.A.'
    ]);
    const r = await extrairComprovantePdf(base64);
    expect(r.tipo).toBe('extraido');
    if (r.tipo !== 'extraido') return;
    expect(r.campos.valorCentavos).toBe(25000);
    expect(r.campos.dataPagamento).toBe('2026-10-15');
    expect(r.campos.nomePagador).toBe('Paciente Fictício da Silva');
    expect(r.campos.nomeFavorecido).toBe('Médica Fictícia Xavier');
    expect(r.campos.confianca?.valorCentavos).toBeGreaterThanOrEqual(0.9);
  });

  it('valores ambíguos ou sem data ficam nulos e sem confiança inventada', async () => {
    const base64 = await pdfCom(['Comprovante Pix', 'Valor: R$ 250,00', 'Total: R$ 300,00']);
    const r = await extrairComprovantePdf(base64);
    expect(r.tipo === 'extraido' || r.tipo === 'nao_comprovante').toBe(true);
    if (r.tipo !== 'extraido') return;
    expect(r.campos.valorCentavos).toBeNull();
    expect(r.campos.dataPagamento).toBeNull();
    expect(r.campos.confianca?.valorCentavos).toBeUndefined();
  });

  it('pdf sem texto vira ilegível; pdf inválido vira ilegível; sem mídia falha', async () => {
    expect((await extrairComprovantePdf(await pdfCom([]))).tipo).toBe('ilegivel');
    expect((await extrairComprovantePdf(Buffer.from('não é pdf').toString('base64'))).tipo).toBe('ilegivel');
    await expect(extrairComprovantePdf(null)).rejects.toThrow('COMPROVANTE_MIDIA_INDISPONIVEL');
  });
});

describe('PDF de nota fiscal (fase inicial do médico)', () => {
  it('identifica nota e extrai número, data, valor e tomador, sem guardar conteúdo', async () => {
    const base64 = await pdfCom([
      'Prefeitura do Município Fictício', 'Nota Fiscal de Serviços Eletrônica - NFS-e',
      'Número da Nota: 12345', 'Data de Emissão: 10/10/2026', 'Valor dos Serviços: R$ 300,00',
      'Tomador: Paciente Fictício da Silva', 'Prestador: Médica Fictícia Xavier'
    ]);
    const r = await extrairComprovantePdf(base64);
    expect(r.tipo).toBe('nota_pdf');
    if (r.tipo !== 'nota_pdf') return;
    expect(r.campos?.numeroNota).toBe('12345');
    expect(r.campos?.dataEmissao).toBe('2026-10-10');
    expect(r.campos?.valorCentavos).toBe(30000);
    expect(r.campos?.nomeTomador).toBe('Paciente Fictício da Silva');
  });

  it('PDF de nota na decisão: fase inicial avisa o médico sem emitir; fora dela vira não-comprovante', async () => {
    const { decidirPedidoComprovante } = await import('../src/atendimento/comprovante.js');
    const nota = { tipo: 'nota_pdf' as const, campos: { numeroNota: '9', dataEmissao: '2026-10-10', valorCentavos: 10000, nomeTomador: 'Fictício' } };
    const base = { medicoId: 'm', paciente: { nome: null, cpf: null }, ultimaConsulta: null };
    const dentro = decidirPedidoComprovante(nota, { ...base, notaFaseInicial: true }, []);
    expect(dentro.tipo).toBe('perguntar_medico');
    if (dentro.tipo !== 'perguntar_medico') return;
    expect(dentro.motivo).toBe('NOTA_FASE_INICIAL');
    expect(dentro.detalheNota?.numeroNota).toBe('9');
    const fora = decidirPedidoComprovante(nota, base, []);
    expect(fora.tipo === 'perguntar_medico' && fora.motivo).toBeTruthy();
    if (fora.tipo === 'perguntar_medico') expect(fora.motivo).toBe('NAO_COMPROVANTE');
  });
});
