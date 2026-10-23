import { afterEach, describe, expect, it, vi } from 'vitest';
import { classificarRetomadaEmissao, classificarStatusConsultaDps, ehRejeicaoRegraNegocio } from '../src/fiscal/retomada-recusa.js';
import { PostgresEmissaoLote } from '../src/io/postgres/postgres-emissao-lote.js';
import { PostgresEmissaoApiRepositorio } from '../src/io/postgres/postgres-emissao-api-repositorio.js';
import { PostgresFilaRepositorio } from '../src/io/postgres/postgres-fila-repositorio.js';
import { PostgresEmissorDpsService } from '../src/io/fiscal/postgres-emissor-dps-service.js';
afterEach(() => vi.restoreAllMocks());

it('classifica destino da consulta com emissão existente', () => {
  expect(classificarRetomadaEmissao({ estado: 'nota_gerada', recusaDefinitiva: false, notaFiscalId: null })).toBe('ja_faturada');
  expect(classificarRetomadaEmissao({ estado: 'erro', recusaDefinitiva: true, notaFiscalId: 'n' })).toBe('ja_faturada');
  expect(classificarRetomadaEmissao({ estado: 'erro', recusaDefinitiva: true, notaFiscalId: null })).toBe('reabrir');
  expect(classificarRetomadaEmissao({ estado: 'erro', recusaDefinitiva: false, notaFiscalId: null })).toBe('repetida');
  expect(classificarRetomadaEmissao({ estado: 'enfileirada', recusaDefinitiva: false, notaFiscalId: null })).toBe('repetida');
  expect(classificarRetomadaEmissao({ estado: 'emitindo', recusaDefinitiva: true, notaFiscalId: null })).toBe('repetida');
});

it('status da consulta DPS: 200=gerada e 404=nao_gerada (confirmado empiricamente 2026-10-22); resto indeterminado', () => {
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
  // E#### fora da classificação "Rej." do ANEXO I oficial nunca é recusa definitiva:
  expect(ehRejeicaoRegraNegocio({ httpStatus: 422, codigoErro: 'E9999', respostaRaw: { erros: [{ codigo: 'E9999' }] } })).toBe(false);
  expect(ehRejeicaoRegraNegocio({ httpStatus: 422, codigoErro: 'E0676', respostaRaw: { erros: [{ codigo: 'E0676' }] } })).toBe(false);
  for (const st of [401, 403, 408, 429, 500, 503]) expect(ehRejeicaoRegraNegocio({ httpStatus: st, codigoErro: 'E0207', respostaRaw: raw })).toBe(false);
});

const detalhe = { nome: 'Pessoa Ficticia', cpf: '52998224725', valorCobradoCentavos: 30000, contato: { celular: '11999990000' } };
const chave = (await import('../src/atendimento/comprovante.js')).chaveConsulta('pepper', 'medico-fixture', 'tribemd', '123');
const assinatura = new (await import('../src/io/postgres/postgres-lotes-emissao.js')).PostgresLotesEmissao({} as any, 'pepper').assinatura('medico-fixture', 'tribemd', '123', 30000);
const entrada = { medicoId: 'medico-fixture', loteId: 'l', item: { id: 'i', fonte: 'tribemd', idExterno: '123', chave, assinatura }, detalhe };

function cenarioRetomada(existente: Record<string, unknown> | null, interceptar?: (sql: string, p: unknown[]) => { rows: unknown[]; rowCount?: number } | undefined) {
  const chamadas: Array<{ sql: string; p: unknown[] }> = [];
  const query = vi.fn(async (sql: string, p: unknown[] = []) => {
    chamadas.push({ sql, p });
    if (interceptar) { const r = interceptar(sql, p); if (r !== undefined) return r; }
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

it('sem nova confirmação (lote sem "sim" novo) a recusa definitiva NÃO reabre', async () => {
  // Simula lote sem confirmado_em/resposta_confirmacao_id: o select do item não acha linha.
  const c = cenarioRetomada({ id: 'antiga', estado: 'erro', nota_fiscal_id: null, recusa_definitiva: true, tentativa: 1 },
    (sql) => sql.includes('from public.noto_lotes_itens') ? { rows: [] } : undefined);
  expect(await c.repo.emitir(entrada as any, c.executor)).toEqual({ estado: 'erro' });
  expect(c.emitir).not.toHaveBeenCalled();
  expect(c.chamadas.some(x => x.sql.includes('set substituida_em=now()'))).toBe(false);
  expect(c.chamadas.some(x => x.sql.includes('insert into public.noto_emissoes_comprovantes'))).toBe(false);
});

it('concorrência: duas emissões paralelas da mesma consulta resultam em UMA ativa; a outra vê repetida', async () => {
  let fase = 'antiga';
  const chamadas: Array<{ sql: string; p: unknown[] }> = [];
  const antiga = { id: 'antiga', estado: 'erro', nota_fiscal_id: null, recusa_definitiva: true, tentativa: 1 };
  const novaAtiva = { id: 'nova', estado: 'enfileirada', nota_fiscal_id: null, recusa_definitiva: false, tentativa: 2 };
  const query = vi.fn(async (sql: string, p: unknown[] = []) => {
    chamadas.push({ sql, p });
    if (sql.includes('select medico_id from solicitacoes_nota')) return { rows: [{ medico_id: 'medico-fixture' }] };
    if (sql.includes('from public.noto_lotes_itens')) return { rows: [{ paciente_id: 'p', data_hora: '2026-10-20T12:00:00Z', ambiente: 'homologacao', assinatura }] };
    if (sql.includes('from public.noto_emissoes_comprovantes') && sql.includes('for update')) return { rows: [fase === 'antiga' ? antiga : novaAtiva] };
    if (sql.includes('set substituida_em=now()')) { fase = 'substituida'; return { rows: [{ id: 'antiga' }], rowCount: 1 }; }
    if (sql.includes('insert into public.noto_emissoes_comprovantes')) { fase = 'nova'; return { rows: [{ id: 'nova' }], rowCount: 1 }; }
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
  const executor = { emissorDps: { emitir }, entregar };
  const resultados = await Promise.all([repo.emitir(entrada as any, executor as any), repo.emitir(entrada as any, executor as any)]);
  const estados = resultados.map(r => r.estado).sort();
  expect(estados).toEqual(['emitida', 'repetida']);
  expect(emitir).toHaveBeenCalledOnce();
  expect(chamadas.filter(x => x.sql.includes('set substituida_em=now()'))).toHaveLength(1);
  expect(chamadas.filter(x => x.sql.includes('insert into public.noto_emissoes_comprovantes'))).toHaveLength(1);
});

it('duplicidade (corrida fora da trava): violação do índice único parcial faz rollback e falha alto, sem reabrir', async () => {
  const c = cenarioRetomada({ id: 'antiga', estado: 'erro', nota_fiscal_id: null, recusa_definitiva: true, tentativa: 1 },
    (sql) => { if (sql.includes('insert into public.noto_emissoes_comprovantes')) throw Object.assign(new Error('duplicate key value violates unique constraint "noto_emissoes_medico_consulta_chave"'), { code: '23505' }); return undefined; });
  await expect(c.repo.emitir(entrada as any, c.executor)).rejects.toThrow('duplicate key');
  expect(c.emitir).not.toHaveBeenCalled();
  expect(c.chamadas.some(x => x.sql === 'rollback')).toBe(true);
});

describe('registrarResultadoParaRetomada (emissor, somente leitura + marcação)', () => {
  const dpsId = 'DPS' + '1'.repeat(42);
  const cert = { pfxBuffer: Buffer.from('x'), senhaCertificado: 's' };
  const rej = { sucesso: false as const, httpStatus: 422, codigoErro: 'E0207', respostaRaw: { erros: [{ codigo: 'E0207', descricao: 'CPF inexistente' }] } };
  function servico(resultadoConsulta: 'gerada' | 'nao_gerada' | 'indeterminado' | 'lanca', flag = true) {
    const chamadas: Array<{ sql: string; p: unknown[] }> = [];
    const pool = { query: vi.fn(async (sql: string, p: unknown[] = []) => { chamadas.push({ sql, p }); return { rows: [], rowCount: 1 }; }) };
    const consultarDpsGerada = vi.fn(async () => {
      if (resultadoConsulta === 'lanca') throw new Error('falha de rede na reconciliação');
      return { resultado: resultadoConsulta, httpStatus: 200 };
    });
    const svc = new PostgresEmissorDpsService(pool as any, 'k', undefined, undefined, undefined, { consultarDpsGerada } as any, false, false, flag);
    return { svc, chamadas, consultarDpsGerada };
  }
  it('Rej. oficial + HEAD 404 grava dps_id E recusa_definitiva', async () => {
    const { svc, chamadas, consultarDpsGerada } = servico('nao_gerada');
    await (svc as any).registrarResultadoParaRetomada('sol1', dpsId, rej, cert, 2);
    expect(chamadas.find(x => x.sql.includes('set dps_id'))?.p).toEqual(['sol1', dpsId]);
    expect(chamadas.find(x => x.sql.includes('recusa_definitiva = true'))?.p).toEqual(['sol1']);
    expect(consultarDpsGerada).toHaveBeenCalledWith(dpsId, { pfxBuffer: cert.pfxBuffer, senhaCertificado: cert.senhaCertificado, ambiente: 2 });
  });
  it.each(['gerada', 'indeterminado'] as const)('Rej. oficial + HEAD %s grava dps_id mas NUNCA recusa_definitiva', async (resultado) => {
    const { svc, chamadas } = servico(resultado);
    await (svc as any).registrarResultadoParaRetomada('sol1', dpsId, rej, cert, 2);
    expect(chamadas.some(x => x.sql.includes('set dps_id'))).toBe(true);
    expect(chamadas.some(x => x.sql.includes('recusa_definitiva = true'))).toBe(false);
  });
  it('falha não-Rej. (timeout, auth, 5xx) não reconcilia nem marca', async () => {
    const { svc, chamadas, consultarDpsGerada } = servico('nao_gerada');
    await (svc as any).registrarResultadoParaRetomada('sol1', dpsId, { sucesso: false, httpStatus: 503, codigoErro: 'SEFIN_INDISPONIVEL' }, cert, 2);
    expect(chamadas.some(x => x.sql.includes('set dps_id'))).toBe(true);
    expect(consultarDpsGerada).not.toHaveBeenCalled();
    expect(chamadas.some(x => x.sql.includes('recusa_definitiva = true'))).toBe(false);
  });
  it('falha na reconciliação deixa travado e não propaga erro para a emissão', async () => {
    const { svc, chamadas } = servico('lanca');
    await expect((svc as any).registrarResultadoParaRetomada('sol1', dpsId, rej, cert, 2)).resolves.toBeUndefined();
    expect(chamadas.some(x => x.sql.includes('recusa_definitiva = true'))).toBe(false);
  });
  it('flag desligada ou dps_id ausente: nenhuma escrita', async () => {
    const semFlag = servico('nao_gerada', false);
    await (semFlag.svc as any).registrarResultadoParaRetomada('sol1', dpsId, rej, cert, 2);
    expect(semFlag.chamadas).toHaveLength(0);
    const semDps = servico('nao_gerada');
    await (semDps.svc as any).registrarResultadoParaRetomada('sol1', undefined, rej, cert, 2);
    expect(semDps.chamadas).toHaveLength(0);
  });
});
