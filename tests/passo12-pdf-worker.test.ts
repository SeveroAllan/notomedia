import { expect, it, vi } from 'vitest';
import type pg from 'pg';
import { PDFDocument } from 'pdf-lib';
import { PostgresEmissorDpsService } from '../src/io/fiscal/postgres-emissor-dps-service.js';
import * as danfse from '../src/fiscal/danfse/gerar-danfse-pdf.js';
import { processarItemFila, type ProcessarItemFilaDeps } from '../src/worker/processar-item-fila.js';

const item = { id: 's', medicoId: 'm', pacienteId: 'p', emissaoComprovante: true as const, tentativas: 0, valorServicoCentavos: 20000, xdescServ: 'Consulta fictícia', ctribNac: '040101' };
// SQL falso, gerador PDF real, nenhuma transmissão fiscal ou Evolution.
const pool = { query: async (sql: string) => {
  if (sql.includes('from medicos m join solicitacoes_nota')) return { rows: [{ nome_completo: 'Clara Almeida Ficticia', crm: '12345/SC' }] };
  if (sql.includes('from medico_perfil_fiscal pf')) return { rows: [{ nome_completo: 'Clara Almeida Ficticia', razao_social: 'Clinica Ficticia', documento_limpo: '11222333000181', uf: 'SC', cod_municipio_ibge: '4205407', serie_dps: '1', ambiente: 'homologacao', opcao_simples_nacional: 'me_epp', regime_apuracao_sn: 'regime_1', regime_especial_tributacao: 0, percentual_tot_trib_sn: 6 }] };
  if (sql.includes('from pacientes')) return { rows: [{ cpf_limpo: '52998224725', nome: 'Ana Oliveira Ficticia', nome_validado: true }] };
  if (sql.includes('max(ndps)')) return { rows: [{ proximo: 1 }] };
  throw Error(`SQL não modelado: ${sql}`);
} } as unknown as pg.Pool;

it('comprovante também gera DANFSe válido com o mesmo gerador do legado', async () => {
  const gerar = vi.spyOn(danfse, 'generateDanfsePdf');
  try {
    const resultado = await new PostgresEmissorDpsService(pool, 'chave-falsa').emitir(item);
    expect(resultado.sucesso).toBe(true);
    if (!resultado.sucesso) throw Error('Esperava simulação autorizada');
    expect(gerar).toHaveBeenCalledTimes(1);
    expect(gerar.mock.calls[0][0]).toMatchObject({ ambiente: 'homologacao' });
    expect(resultado.pdfStoragePath).toMatch(/^data:application\/pdf;base64,/);
    const pdf = await PDFDocument.load(Buffer.from(resultado.pdfStoragePath!.split(',')[1], 'base64'));
    expect(pdf.getPageCount()).toBe(1);
  } finally { gerar.mockRestore(); }
});
it('falha no gerador PDF após autorização conserva sucesso e XML, com PDF pendente', async () => {
  const gerar = vi.spyOn(danfse, 'generateDanfsePdf').mockRejectedValue(Error('PDF indisponível'));
  try {
    expect(await new PostgresEmissorDpsService(pool, 'chave-falsa').emitir(item)).toMatchObject({ sucesso: true, xmlStoragePath: expect.stringContaining('.xml'), pdfStoragePath: null });
    expect(gerar).toHaveBeenCalledTimes(1);
  } finally { gerar.mockRestore(); }
});
it('falha na entrega depois de persistir nota não marca erro fiscal e não reemite', async () => {
  let estado = 'enfileirada'; const eventos: string[] = [];
  const emitir = vi.fn(async () => ({ sucesso: true as const, chaveAcesso: 'ficticia', ndps: 1, serie: '1', competencia: '2026-10', dataEmissao: new Date('2026-10-18'), valorServicosCentavos: 20000, xmlStoragePath: 'xml', pdfStoragePath: 'pdf' }));
  const deps: ProcessarItemFilaDeps = {
    emissorDps: { emitir }, enviarPdfDanfse: { enviarPdf: vi.fn() },
    notificadorAlertas: { notificarMedicoWhatsApp: vi.fn(), notificarDesenvolvedorEmail: vi.fn() },
    filaRepositorio: {
      iniciarEmissaoComprovante: async () => { if (estado !== 'enfileirada') return 'ocupada'; estado = 'emitindo'; return 'iniciada'; },
      registrarSucesso: async () => { estado = 'nota_gerada'; eventos.push('nota_persistida'); },
      registrarFalhaComprovante: vi.fn(), buscarETravarProximoItem: vi.fn(), buscarContextoEnvio: vi.fn(), reagendarTentativa: vi.fn(), marcarFalhaDefinitiva: vi.fn()
    },
    aoAutorizarComprovante: async () => { eventos.push('entrega'); throw Error('Evolution falsa indisponível'); }
  };
  expect(await processarItemFila(item, deps)).toMatchObject({ ok: true, status: 'emitida' });
  expect(eventos).toEqual(['nota_persistida', 'entrega']); expect(estado).toBe('nota_gerada');
  await processarItemFila(item, deps); expect(emitir).toHaveBeenCalledTimes(1);
  expect(deps.filaRepositorio.registrarFalhaComprovante).not.toHaveBeenCalled(); expect(deps.filaRepositorio.reagendarTentativa).not.toHaveBeenCalled();
});
