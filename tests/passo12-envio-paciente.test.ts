import { expect, it, vi } from 'vitest';
import type pg from 'pg';
import { carregarConfig } from '../src/config.js';
import { ComunicacaoHomologacao } from '../src/whatsapp/comunicacao-homologacao.js';
import type { EnviarPdfDanfseParams } from '../src/whatsapp/enviar-pdf-danfse.js';

const nota = { nota_fiscal_id: 'nota-ficticia', ambiente: 'homologacao', contato_telefone: '5511999990000', nome_instancia: 'medica-propria', instancia_medico_id: 'm', instancia_status: 'conectado', pdf_storage_path: 'data:application/pdf;base64,cGRm' };
it.each([
  [false, ['11999990000'], { ...nota }],
  [true, [], { ...nota }],
  [true, ['11988880000'], { ...nota }],
  [true, ['11999990000'], { ...nota, ambiente: 'producao' }],
  [true, ['11999990000'], { ...nota, ambiente: null }],
  [true, ['11999990000'], { ...nota, nome_instancia: 'notomed_oficial' }],
  [true, ['11999990000'], { ...nota, nome_instancia: 'notomed_assistente' }],
  [true, ['11999990000'], { ...nota, instancia_medico_id: 'outro' }],
  [true, ['11999990000'], { ...nota, instancia_status: 'desconectado' }],
  [true, ['11999990000'], { ...nota, pdf_storage_path: null }]
])('protege entrega: flag=%s allowlist=%j nota=%j', async (ativo, allowlist, dados) => {
  const enviarTexto = vi.fn(async () => ({ sucesso: true }));
  const enviarPdf = vi.fn(async (_p: EnviarPdfDanfseParams) => ({ sucesso: true }));
  const query = vi.fn(async (_sql: string) => ({ rows: [dados] }));
  const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, { ...carregarConfig({}), envioPacienteRealAtivo: ativo, envioRealAllowlist: allowlist }, { enviarTexto }, vi.fn());
  await c.paciente({ medicoId: 'm', solicitacaoId: 's' }, { enviarPdf });
  expect(enviarPdf).not.toHaveBeenCalled(); expect(enviarTexto).not.toHaveBeenCalled();
  expect(query.mock.calls.some(c => c[0].includes('insert into'))).toBe(false);
});
it('PDF segue pela instância própria uma vez por nota, inclusive com corrida e falha de transporte', async () => {
  const reservas = new Set<string>(), escritos: any[] = [];
  const query = vi.fn(async (sql: string, p: any[] = []) => {
    if (sql.includes('from notas_fiscais')) return { rows: [nota] };
    escritos.push(p);
    if (sql.includes('insert into')) { const chave = JSON.stringify(p); if (reservas.has(chave)) return { rows: [] }; reservas.add(chave); return { rows: [{ id: 'r' }] }; }
    if (sql.includes('update ')) return { rows: [] };
    throw Error('SQL não modelado');
  });
  const enviarPdf = vi.fn(async (_p: EnviarPdfDanfseParams) => ({ sucesso: false }));
  const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, { ...carregarConfig({}), envioPacienteRealAtivo: true, envioRealAllowlist: ['11999990000'] }, { enviarTexto: vi.fn() }, vi.fn());
  await Promise.all([c.paciente({ medicoId: 'm', solicitacaoId: 's' }, { enviarPdf }), c.paciente({ medicoId: 'm', solicitacaoId: 's' }, { enviarPdf })]);
  await c.paciente({ medicoId: 'm', solicitacaoId: 's' }, { enviarPdf });
  expect(enviarPdf).toHaveBeenCalledExactlyOnceWith({ instanciaNome: 'medica-propria', contatoTelefone: '5511999990000', pdfPathOuUrl: nota.pdf_storage_path, nomeArquivo: 'DANFSe.pdf', legenda: expect.stringContaining('sem valor fiscal') });
  expect(JSON.stringify(escritos)).not.toContain('5511999990000');
  expect(JSON.stringify(escritos)).not.toContain('nota-ficticia');
  expect(query.mock.calls.every(c => !/insert into notas_fiscais|solicitacoes_nota set/.test(c[0]))).toBe(true);
});
it('sem instância conectada avisa o médico passando pelos mesmos bloqueios', async () => {
  const enviarTexto = vi.fn(async (_p: any) => ({ sucesso: true }));
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('from notas_fiscais')) return { rows: [{ ...nota, nome_instancia: null }] };
    if (sql.includes('from medicos m')) return { rows: [{ telefone: '11988880000', ambiente: 'homologacao' }] };
    return { rows: [{ id: 'r' }] };
  });
  const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, { ...carregarConfig({}), envioPacienteRealAtivo: true, envioMedicoRealAtivo: true, envioRealAllowlist: ['11999990000', '11988880000'] }, { enviarTexto }, vi.fn());
  const enviarPdf = vi.fn();
  await c.paciente({ medicoId: 'm', solicitacaoId: 's' }, { enviarPdf });
  expect(enviarPdf).not.toHaveBeenCalled();
  expect(enviarTexto).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instanciaNome: 'notomed_assistente', contatoTelefone: '11988880000', texto: 'A nota já foi emitida, mas seu WhatsApp está desconectado. Conecte-o e peça apenas o reenvio do PDF.' }));
});
