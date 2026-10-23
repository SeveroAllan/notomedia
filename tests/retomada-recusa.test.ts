import { afterEach, expect, it, vi } from 'vitest';
import { classificarRetomadaEmissao, classificarStatusConsultaDps, ehRejeicaoRegraNegocio } from '../src/fiscal/retomada-recusa.js';
import { PostgresEmissaoLote } from '../src/io/postgres/postgres-emissao-lote.js';
import { PostgresEmissaoApiRepositorio } from '../src/io/postgres/postgres-emissao-api-repositorio.js';
import { PostgresFilaRepositorio } from '../src/io/postgres/postgres-fila-repositorio.js';
afterEach(() => vi.restoreAllMocks());

it('classifica destino da consulta com emissão existente', () => {
  expect(classificarRetomadaEmissao({ estado: 'nota_gerada', recusaDefinitiva: false, notaFiscalId: null })).toBe('ja_faturada');
  expect(classificarRetomadaEmissao({ estado: 'erro', recusaDefinitiva: true, notaFiscalId: 'n' })).toBe('ja_faturada');
  expect(classificarRetomadaEmissao({ estado: 'erro', recusaDefinitiva: true, notaFiscalId: null })).toBe('reabrir');
  expect(classificarRetomadaEmissao({ estado: 'erro', recusaDefinitiva: false, notaFiscalId: null })).toBe('repetida');
  expect(classificarRetomadaEmissao({ estado: 'enfileirada', recusaDefinitiva: false, notaFiscalId: null })).toBe('repetida');
  expect(classificarRetomadaEmissao({ estado: 'emitindo', recusaDefinitiva: true, notaFiscalId: null })).toBe('repetida');
});

it('status da consulta DPS: só o documentado libera leitura; o resto é indeterminado', () => {
  expect(classificarStatusConsultaDps(200)).toBe('gerada');
  expect(classificarStatusConsultaDps(404)).toBe('nao_gerada');
  for (const s of [0, 204, 400, 401, 403, 408, 429, 500, 503]) expect(classificarStatusConsultaDps(s)).toBe('indeterminado');
});

it('recusa definitiva exige resposta estruturada do provedor com código E####', () => {
  const raw = { erros: [{ codigo: 'E0207', descricao: 'CPF do tomador não encontrado no cadastro CPF.' }] };
  expect(ehRejeicaoRegraNegocio({ httpStatus: 422, codigoErro: 'E0207', respostaRaw: raw })).toBe(true);
  expect(ehRejeicaoRegraNegocio({ httpStatus: 400, codigoErro: 'E0207', respostaRaw: raw })).toBe(true);
  expect(ehRejeicaoRegraNegocio({ httpStatus: 422, codigoErro: 'E0207' })).toBe(false);
  expect(ehRejeicaoRegraNegocio({ httpStatus: 422, codigoErro: 'E0207', respostaRaw: { erros: [{ codigo: 'E9999' }] } })).toBe(false);
  expect(ehRejeicaoRegraNegocio({ httpStatus: 422, codigoErro: 'SEFIN_TIMEOUT', respostaRaw: raw })).toBe(false);
  for (const st of [401, 403, 408, 429, 500, 503]) expect(ehRejeicaoRegraNegocio({ httpStatus: st, codigoErro: 'E0207', respostaRaw: raw })).toBe(false);
});

const detalhe = { nome: 'Pessoa Ficticia', cpf: '52998224725', valorCobradoCentavos: 30000, contato: { celular: '11999990000' } };
const chave = (await import('../src/atendimento/comprovante.js')).chaveConsulta('pepper', 'medico-fixture', 'tribemd', '123');
const assinatura = new (await import('../src/io/postgres/postgres-lotes-emissao.js')).PostgresLotesEmissao({} as any, 'pepper').assinatura('medico-fixture', 'tribemd', '123', 30000);
const entrada = { medicoId: 'medico-fixture', loteId: 'l', item: { id: 'i', fonte: 'tribemd', idExterno: '123', chave, assinatura }, detalhe };

function cenarioRetomada(existente: Record<string, unknown> | null) {
  const chamadas: Array<{ sql: string; p: unknown[] }> = [];
  const query = vi.fn(async (sql: string, p: unknown[] = []) => {
    chamadas.push({ sql, p });
    if (sql.includes('select medico_id from solicitacoes_nota')) return { rows: [{ medico_id: 'medico-fixture' }] };
    if (sql.includes('from public.noto_lotes_itens')) return { rows: [{ paciente_id: 'p', data_hora: '2026-10-20T12:00:00Z', ambiente: 'homologacao', assinatura }] };
    if (sql.includes('from public.noto_emissoes_comprovantes') && sql.includes('for update')) return { rows: existente ? [existente] : [] };
    if (sql.includes('set substituida_em=now()')) return { rows: [{ id: existente?.id }], rowCount: 1 };
    if (sql.includes('insert into public.noto_emissoes_comprovantes')) return { rows: [{ id: 'nova' }], rowCount: 1 };
    if (sql.includes("set estado='emitindo'")) return { rows: [{ id: 'r' }], rowCount: 1 };
    if (sql.includes('ec.estado')) return { rows: [{ estado: 'enfileirada', ambiente: 'homologacao', aguardando_confirmacao_medico: false }] };
    return { rows: [], rowCount: 1 };
  });
  let trava = Promise.resolve();
  const pool = { query, connect: async () => { let soltar = () => {}; return { release: vi.fn(), query: async (sql: string, p: unknown[] = []) => {
    if (sql === 'begin') { const anterior = trava; trava = new Promise<void>(r => { soltar = r; }); await anterior; }
    const r = await query(sql, p); if (sql === 'commit' || sql === 'rollback') soltar(); return r;
  } }; } };
  const repo = new PostgresEmissaoLote(pool as any, 'chave-fixture', 'pepper', vi.fn(async () => true), true);
  vi.spyOn(PostgresEmissaoApiRepositorio.prototype, 'enfileirarSolicitacao').mockResolvedValue({ id: 's' } as any);
  vi.spyOn(PostgresEmissaoApiRepositorio.prototype, 'buscarPerfilFiscalMedico').mockResolvedValue({ medicoId: 'medico-fixture', nomeCompleto: 'Clara Ficticia', crm: '123', ctribNacPadrao: '040101', configuracaoCompleta: true } as any);
  vi.spyOn(PostgresFilaRepositorio.prototype, 'registrarSucesso').mockResolvedValue();
  const emitir = vi.fn(async () => ({ sucesso: true as const, chaveAcesso: 'chave-fiscal', ndps: 1, serie: '1', competencia: '2026-10-20', dataEmissao: new Date('2026-10-20'), valorServicosCentavos: 30000, xmlStoragePath: 'fixture.xml', pdfStoragePath: 'fixture.pdf' }));
  const entregar = vi.fn(async () => 'enviado' as const);
  return { repo, emitir, entregar, chamadas, executor: { emissorDps: { emitir }, entregar } };
}

it('recusa definitiva comprovada é substituída na mesma transação, com tentativa+1 e ligação auditável', async () => {
  const c = cenarioRetomada({ id: 'antiga', estado: 'erro', nota_fiscal_id: null, recusa_definitiva: true, tentativa: 2 });
  expect(await c.repo.emitir(entrada as any, c.executor)).toEqual({ estado: 'emitida', entrega: 'enviado', semContato: false });
  expect(c.emitir).toHaveBeenCalledOnce();
  const subst = c.chamadas.find(x => x.sql.includes('set substituida_em=now()'));
  expect(subst?.p).toEqual(['antiga']);
  const insert = c.chamadas.find(x => x.sql.includes('insert into public.noto_emissoes_comprovantes'));
  expect(insert?.p[4]).toBe(3);
  const ligacao = c.chamadas.find(x => x.sql.includes('substituida_por'));
  expect(ligacao?.p).toEqual(['antiga', 'nova']);
});

it.each([
  { id: 'a', estado: 'erro', nota_fiscal_id: null, recusa_definitiva: false, tentativa: 1, esperado: 'repetida' },
  { id: 'a', estado: 'erro', nota_fiscal_id: 'n', recusa_definitiva: true, tentativa: 1, esperado: 'ja_faturada' },
  { id: 'a', estado: 'nota_gerada', nota_fiscal_id: 'n', recusa_definitiva: false, tentativa: 1, esperado: 'ja_faturada' },
  { id: 'a', estado: 'enfileirada', nota_fiscal_id: null, recusa_definitiva: true, tentativa: 1, esperado: 'repetida' },
])('resultado incerto, nota ou reserva viva NUNCA reabre: %o', async ({ esperado, ...existente }) => {
  const c = cenarioRetomada(existente);
  expect(await c.repo.emitir(entrada as any, c.executor)).toEqual({ estado: esperado });
  expect(c.emitir).not.toHaveBeenCalled();
  expect(c.chamadas.some(x => x.sql.includes('set substituida_em=now()'))).toBe(false);
});
