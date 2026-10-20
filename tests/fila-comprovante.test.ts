import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { PostgresFilaRepositorio } from '../src/io/postgres/postgres-fila-repositorio.js';

function banco(ambiente: unknown = 'homologacao', estado = 'enfileirada') {
  const query = vi.fn(async (sql: string, _valores?: unknown[]): Promise<any> => {
    if (sql.includes('for update') && sql.includes('noto_emissoes_comprovantes')) return { rows: [{ estado, ambiente }], rowCount: 1 };
    if (sql.includes('returning') && sql.includes('notas_fiscais')) return { rows: [{ id: 'nota-1' }], rowCount: 1 };
    if (sql.includes('returning') && sql.includes('solicitacoes_nota')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  return { pool: { query, connect: vi.fn(async () => ({ query, release })) } as unknown as pg.Pool, query, release };
}

describe('persistência da fila de comprovantes', () => {
  it('flag desligada mantém SQL legado sem acessar a tabela nova', async () => {
    const b = banco();
    await new PostgresFilaRepositorio(b.pool).buscarETravarProximoItem('worker');
    expect(b.query).toHaveBeenCalledTimes(1);
    const sql = b.query.mock.calls[0][0];
    expect(sql).toContain("origem = 'api'");
    expect(sql).not.toContain('noto_emissoes_comprovantes');
  });
  it('flag ativa exige vínculo enfileirado e nunca recupera lock expirado de comprovante', async () => {
    const b = banco();
    await new (PostgresFilaRepositorio as any)(b.pool, false, true).buscarETravarProximoItem('worker');
    const sql = b.query.mock.calls[0][0];
    expect(sql).toContain('noto_emissoes_comprovantes');
    expect(sql).toContain("enfileirada");
    expect(sql).toMatch(/origem = 'api'.*bloqueada_em|bloqueada_em.*origem = 'api'/s);
  });
  it.each(['producao', null, 'invalido'])('revalida ambiente %s e bloqueia sem liberar para emissão', async ambiente => {
    const b = banco(ambiente);
    const repo = new (PostgresFilaRepositorio as any)(b.pool, false, true);
    expect(await repo.iniciarEmissaoComprovante('sol-1')).toBe('bloqueada');
    expect(b.query.mock.calls.map(c => c[0]).join('\n')).toContain('AMBIENTE_FISCAL_BLOQUEADO');
    expect(b.query.mock.calls.map(c => c[0]).join('\n')).toContain('commit');
  });
  it('flag desligada não inicia emissão nem consulta tabela nova', async () => {
    const b = banco();
    expect(await (new PostgresFilaRepositorio(b.pool) as any).iniciarEmissaoComprovante('sol-1')).toBe('bloqueada');
    expect(b.query).not.toHaveBeenCalled();
  });
  it('vínculo já emitindo impede reprocessamento', async () => {
    const b = banco('homologacao', 'emitindo');
    expect(await new (PostgresFilaRepositorio as any)(b.pool, false, true).iniciarEmissaoComprovante('sol-1')).toBe('ocupada');
    expect(b.query.mock.calls.some(c => /set estado = 'emitindo'/.test(c[0]))).toBe(false);
  });
});

it('nota e vínculo são gravados na mesma transação, com identificador retornado', async () => {
  const b = banco();
  await new (PostgresFilaRepositorio as any)(b.pool, false, true).registrarSucesso({ solicitacaoId: 'sol-1', medicoId: 'med-1', chaveAcesso: 'chave', ndps: 1, serie: '1', competencia: '2026-10-01', dataEmissao: new Date(), valorServicosCentavos: 10000, xmlStoragePath: 'xml', pdfStoragePath: 'pdf', emissaoComprovante: true });
  const chamadas = b.query.mock.calls;
  const vinculo = chamadas.find(c => c[0].includes('nota_fiscal_id') && c[0].includes('noto_emissoes_comprovantes'));
  expect(vinculo).toBeDefined();
  expect(vinculo![1]).toContain('nota-1');
  expect(chamadas[0][0]).toBe('begin');
  expect(chamadas.at(-1)![0]).toBe('commit');
});

it('falha ao vincular nota faz rollback em vez de marcar sucesso parcial', async () => {
  const b = banco();
  b.query.mockImplementation(async (sql: string): Promise<any> => {
    if (sql.includes('insert into notas_fiscais')) return { rows: [{ id: 'nota-1' }], rowCount: 1 };
    if (sql.includes('nota_fiscal_id') && sql.includes('noto_emissoes_comprovantes')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  });
  await expect(new (PostgresFilaRepositorio as any)(b.pool, false, true).registrarSucesso({ solicitacaoId: 'sol-1', medicoId: 'med-1', chaveAcesso: 'chave', ndps: 1, serie: '1', competencia: '2026-10-01', dataEmissao: new Date(), valorServicosCentavos: 10000, xmlStoragePath: 'xml', pdfStoragePath: 'pdf', emissaoComprovante: true })).rejects.toThrow();
  expect(b.query.mock.calls.at(-1)![0]).toBe('rollback');
});
it('mesmo um item obtido antes da suspensão não inicia emissão sem confirmação', async () => {
  const b = banco();
  b.query.mockImplementation(async (sql: string): Promise<any> => sql.includes('select ec.estado')
    ? { rows: [{ estado: 'enfileirada', ambiente: 'homologacao', aguardando_confirmacao_medico: true }] } : { rows: [] });
  expect(await new PostgresFilaRepositorio(b.pool, false, true).iniciarEmissaoComprovante('sol-1')).toBe('ocupada');
  expect(b.query.mock.calls.some(([sql]) => sql.includes("set estado = 'emitindo'"))).toBe(false);
});
