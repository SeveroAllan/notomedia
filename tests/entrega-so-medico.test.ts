import { expect, it, vi } from 'vitest';
import { carregarConfig } from '../src/config.js';
import { ComunicacaoHomologacao } from '../src/whatsapp/comunicacao-homologacao.js';

function cenario(opcoes: { ativo?: boolean; ambiente?: string; allowlist?: string[]; escolha?: string } = {}) {
  const reservas = new Set<string>();
  const query = vi.fn(async (sql: string, p: unknown[] = []) => {
    if (sql.includes('select sn.id as solicitacao_id')) return { rows: [{ solicitacao_id: 's' }] };
    if (sql.includes('from notas_fiscais')) return { rows: [{ nota_fiscal_id: 'n', origem: 'lote', contato_telefone: null,
      telefone_medico: '5511888880000', ambiente: opcoes.ambiente ?? 'homologacao', pdf_storage_path: 'data:application/pdf;base64,cGRm' }] };
    if (sql.includes('insert into public.noto_envios_homologacao')) {
      const k = JSON.stringify(p); if (reservas.has(k)) return { rows: [] }; reservas.add(k); return { rows: [{ id: 'r' }] };
    }
    return { rows: [] };
  });
  const enviarPdf = vi.fn(async () => ({ sucesso: true }));
  const permissoes = { ler: async () => ({ valor: opcoes.escolha ?? 'so_medico' }), permite: async () => false, linkJaCriado: async () => true };
  const c = new ComunicacaoHomologacao({ query } as any, { ...carregarConfig({}), envioMedicoRealAtivo: opcoes.ativo ?? true,
    envioPacienteRealAtivo: false, envioRealAllowlist: opcoes.allowlist ?? ['11888880000'] }, { enviarTexto: vi.fn(), enviarPdf }, vi.fn(), permissoes as any);
  return { c, enviarPdf, query };
}
it('so_medico entrega PDF ao médico mesmo sem contato/instância do paciente e não duplica em corrida', async () => {
  const { c, enviarPdf, query } = cenario();
  const entrada = { medicoId: 'm', solicitacaoId: 's' };
  const r = await Promise.all([c.paciente(entrada, { enviarPdf }), c.paciente(entrada, { enviarPdf })]);
  expect(r.sort()).toEqual(['enviado', 'repetido']);
  expect(enviarPdf).toHaveBeenCalledExactlyOnceWith({ instanciaNome: 'notomed_assistente', contatoTelefone: '5511888880000',
    pdfPathOuUrl: 'data:application/pdf;base64,cGRm', nomeArquivo: 'DANFSe.pdf', legenda: expect.stringContaining('sem valor fiscal') });
  expect(query.mock.calls.some(([sql]) => /insert into notas_fiscais|update solicitacoes_nota/.test(sql))).toBe(false);
});
it.each([{ ativo: false }, { ambiente: 'producao' }, { allowlist: [] }, { allowlist: ['11999990000'] }])('PDF ao médico mantém gates %j', async opcoes => {
  const { c, enviarPdf } = cenario(opcoes);
  await c.paciente({ medicoId: 'm', solicitacaoId: 's' }, { enviarPdf });
  expect(enviarPdf).not.toHaveBeenCalled();
});
it('retoma após escolha usando somente notas autorizadas existentes e não reemite', async () => {
  const { c, enviarPdf, query } = cenario();
  await c.retomarEntregaMedico('m', { enviarPdf });
  await c.retomarEntregaMedico('m', { enviarPdf });
  expect(enviarPdf).toHaveBeenCalledTimes(1);
  expect(query.mock.calls.find(([sql]) => sql.includes('select sn.id as solicitacao_id'))?.[0]).toContain("nf.status='autorizada'");
});
it('porta sem contato recusa escolha paciente antes de tentar entrega', async () => {
  const {c,enviarPdf,query}=cenario({escolha:'paciente'});
  expect(await c.entregarAoMedicoSemContato('m','s',{enviarPdf})).toBe('sem_permissao');
  expect(enviarPdf).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();
});
