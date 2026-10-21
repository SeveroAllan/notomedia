import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { PostgresLotesEmissao } from '../src/io/postgres/postgres-lotes-emissao.js';
import { chaveConsulta } from '../src/atendimento/comprovante.js';
it('contar_consultas_periodo usa médico/período/realizada e exclui faturada por HMAC, sem dados pessoais', async () => {
  const query = vi.fn(async (sql: string, p?: unknown[]) => {
    if (sql.includes('from public.noto_consultas_sincronizadas')) {
      expect(sql).toContain("status='realizada'"); expect(sql).toContain("time zone 'America/Sao_Paulo'");
      expect(p).toEqual(['m', '2026-10-01', '2026-10-20T15:00Z']);
      return { rows: [{ fonte: 'tribemd', id_externo: '1', valor_consulta_centavos: 30000 }, { fonte: 'tribemd', id_externo: '2', valor_consulta_centavos: null }, { fonte: 'tribemd', id_externo: '3', valor_consulta_centavos: 40000 }] };
    }
    expect(sql).toContain("estado='nota_gerada'");
    return { rows: p?.[1] === chaveConsulta('pepper', 'm', 'tribemd', '3') ? [{}] : [] };
  });
  const c = await new PostgresLotesEmissao({ query } as any, 'pepper').contarConsultasPeriodo('m', '2026-10-01', '2026-10-20T15:00Z', new Map([['1',30000],['2',null],['3',40000]]));
  expect(c).toMatchObject({ totalConsultas: 1, totalCentavos: 30000, semValor: 1 });
  expect(c.consultas.map(c => c.idExterno)).toEqual(['1','2']); expect(c.consultas[0].assinatura).toMatch(/^[a-f0-9]{64}$/);
  expect(c.consultas[1].assinatura).toBeNull(); expect(JSON.stringify(c.consultas)).not.toContain('30000');
  expect(query.mock.calls.every(([sql]) => !/nome|cpf|pacientes/i.test(sql))).toBe(true);
});
it('snapshot grava somente ids, HMAC e totais em transação, nunca valor individual', async () => {
  const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('update public.noto_lotes_emissao') ? [{ id: 'l', medico_id: 'm', conversa: 'c', desde: '2026-10-01', ate: '2026-10-20T15:00Z', total_consultas: 1, total_centavos: 30000, sem_valor: 0, estado: 'aguardando_confirmacao_lote' }] : [] }));
  const release = vi.fn(); const repo = new PostgresLotesEmissao({ connect: async () => ({ query, release }) } as any, 'pepper');
  const dados = { consultas: [{ fonte: 'tribemd', idExterno: '12', chave: 'chave', assinatura: 'hmac-valor' }], totalConsultas: 1, totalCentavos: 30000, semValor: 0 };
  await repo.preparar('l', '2026-10-01', dados);
  const insert = query.mock.calls.find(([sql]) => sql.startsWith('insert into public.noto_lotes_itens'))!;
  expect(insert).toBeDefined(); expect(insert[0]).not.toMatch(/nome|cpf|valor_cobrado|valor_consulta/);
  expect(query.mock.calls[0][0]).toBe('begin'); expect(query.mock.calls.at(-1)?.[0]).toBe('commit'); expect(release).toHaveBeenCalledOnce();
});
it('confirmar usa CAS, vínculo da pergunta e TTL; baixa confiança não chega ao SQL', async () => {
  let ganhou = false;
  const query = vi.fn(async () => { if (ganhou) return { rows: [] }; ganhou = true; return { rows: [{ id: 'l' }] }; });
  const repo = new PostgresLotesEmissao({ query } as any, 'pepper');
  expect(await repo.confirmar('l', 's', 'p', { intencao: 'sim', confianca: .8 }, new Date())).toBe(false); expect(query).not.toHaveBeenCalled();
  const r = await Promise.all(Array.from({ length: 10 }, () => repo.confirmar('l', 's', 'p', { intencao: 'sim', confianca: .99 }, new Date('2026-10-20T15:00Z'))));
  expect(r.filter(Boolean)).toHaveLength(1);
  const sql = String(query.mock.calls[0][0]); expect(sql).toContain("estado='aguardando_confirmacao_lote'"); expect(sql).toContain('mensagem_confirmacao_id=$3'); expect(sql).toContain("interval '48 hours'");
});
it('migration preparada tem RLS, unicidade e nenhuma coluna pessoal ou valor individual', () => {
  const sql = readFileSync('scripts/migrations/20261024-lotes-retroativos-homologacao.sql', 'utf8');
  expect(sql).toContain('references public.medicos(id) on delete cascade');
  expect(sql.match(/enable row level security/g)).toHaveLength(2); expect(sql).toContain('from anon, authenticated');
  expect(sql).toContain('unique (lote_id, fonte, id_externo)'); expect(sql).toContain('(medico_id, consulta_chave)');
  expect(sql).not.toMatch(/nome|cpf|valor_cobrado|valor_consulta|create policy/i);
});
it('8b: congela valor cobrado ao vivo, mesmo quando valor da consulta no banco é diferente', async () => {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('from public.noto_consultas_sincronizadas') ? [{ fonte: 'tribemd', id_externo: '1', valor_consulta_centavos: 30000 }] : [] }));
  const repo = new PostgresLotesEmissao({ query } as any,'pepper');
  const r = await repo.contarConsultasPeriodo('m','2026-10-01','2026-10-20T15:00Z',new Map([['1',25000]]));
  expect(r.totalCentavos).toBe(25000); expect(r.totalConsultas).toBe(1);
  expect(r.consultas[0].assinatura).toBe(repo.assinatura('m','tribemd','1',25000));
  expect(r.consultas[0].assinatura).not.toBe(repo.assinatura('m','tribemd','1',30000));
  expect(JSON.stringify(r.consultas)).not.toMatch(/25000|30000|valorCobrado/);
});
it('8b: sem leitura ao vivo não faz fallback para preço persistido', async () => {
  const query = vi.fn(); const repo = new PostgresLotesEmissao({ query } as any,'pepper');
  await expect((repo as any).contarConsultasPeriodo('m','2026-10-01','2026-10-20T15:00Z')).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});
it.each([25000,26000])('contagem congela cobrado 25000 e execução só aceita se continuar igual (ao vivo=%s)', async cobradoExecucao => {
  const { processarLoteRetroativo } = await import('../src/worker/processar-lote-retroativo.js');
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('from public.noto_consultas_sincronizadas') ? [{ fonte: 'tribemd', id_externo: '1', valor_consulta_centavos: 30000 }] : [] }));
  const origem = new PostgresLotesEmissao({ query } as any,'pepper');
  const contado = await origem.contarConsultasPeriodo('m','2026-10-01','2026-10-20T15:00Z',new Map([['1',25000]]));
  const fila = { reservar: vi.fn(async () => ({ id: 'l', medicoId: 'm', conversa: 'c', totalConsultas: contado.totalConsultas, itens: contado.consultas.map(c => ({ ...c, id: 'i' })) })),
    reservarItem: vi.fn(async () => true), concluirItem: vi.fn(async (_id: string, _estado: string) => {}), finalizar: vi.fn(async () => {}) };
  const simular = vi.fn(async () => ({ ok: true }));
  await processarLoteRetroativo(fila,{ permitido: async () => true, faturada: async () => false,
    lerDetalhe: async () => ({ nome: 'Pessoa Ao Vivo', cpf: '52998224725', valorCobradoCentavos: cobradoExecucao }),
    assinatura: (m,f,id,v) => origem.assinatura(m,f,id,v), simular, enviar: vi.fn(), log: vi.fn() });
  expect(contado.totalCentavos).toBe(25000);
  expect(simular).toHaveBeenCalledTimes(cobradoExecucao === 25000 ? 1 : 0);
  expect(fila.concluirItem).toHaveBeenCalledWith('i', cobradoExecucao === 25000 ? 'simulada' : 'dados_divergentes');
  expect(JSON.stringify(fila.concluirItem.mock.calls)).not.toMatch(/52998224725|Pessoa Ao Vivo|25000|26000/);
});
it('ausência de cobrado ao vivo exclui; consulta fora da leitura ao vivo não entra no escopo', async () => {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('from public.noto_consultas_sincronizadas') ? [{ fonte:'tribemd',id_externo:'1',valor_consulta_centavos:30000 },{ fonte:'tribemd',id_externo:'2',valor_consulta_centavos:30000 }] : [] }));
  const repo = new PostgresLotesEmissao({ query } as any,'pepper');
  expect(await repo.contarConsultasPeriodo('m','2026-10-01','2026-10-20T15:00Z',new Map([['1',null]])))
    .toMatchObject({ totalConsultas: 0, totalCentavos: 0, semValor: 1, consultas: [{ idExterno:'1',assinatura:null }] });
});
