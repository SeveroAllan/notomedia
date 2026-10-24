import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { PostgresLotesEmissao } from '../src/io/postgres/postgres-lotes-emissao.js';
import { chaveConsulta } from '../src/atendimento/comprovante.js';
it('contar_consultas_periodo usa médico/período/realizada e exclui faturada por HMAC, sem dados pessoais', async () => {
  const query = vi.fn(async (sql: string, p?: unknown[]) => {
    if (sql.includes('from public.noto_consultas_sincronizadas')) {
      expect(sql).toContain("status='realizada'"); expect(sql).toContain("time zone 'America/Sao_Paulo'");
      expect(p).toEqual(['m', '2026-10-01', '2026-10-20T15:00Z', 'tribemd']);
      return { rows: [{ fonte: 'tribemd', id_externo: '1', valor_consulta_centavos: 30000 }, { fonte: 'tribemd', id_externo: '2', valor_consulta_centavos: null }, { fonte: 'tribemd', id_externo: '3', valor_consulta_centavos: 40000 }] };
    }
    expect(sql).toContain('noto_emissoes_comprovantes'); expect(sql).toContain('substituida_em is null');
    return { rows: p?.[1] === chaveConsulta('pepper', 'm', 'tribemd', '3') ? [{ estado: 'nota_gerada', recusa_definitiva: false, nota_fiscal_id: 'nf-1' }] : [] };
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
  const query = vi.fn(async (_sql:string, _parametros:unknown[] = []) => { if (ganhou) return { rows: [] }; ganhou = true; return { rows: [{ id: 'l' }] }; });
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
  const emitir = vi.fn(async () => ({ estado: 'emitida' as const, entrega:'nao_enviada',semContato:false }));
  await processarLoteRetroativo(fila,{ permitido: async () => true, faturada: async () => false,
    lerDetalhe: async () => ({ nome: 'Pessoa Ao Vivo', cpf: '52998224725', valorCobradoCentavos: cobradoExecucao }),
    assinatura: (m,f,id,v) => origem.assinatura(m,f,id,v), emitir, enviar: vi.fn(), log: vi.fn() });
  expect(contado.totalCentavos).toBe(25000);
  expect(emitir).toHaveBeenCalledTimes(cobradoExecucao === 25000 ? 1 : 0);
  expect(fila.concluirItem).toHaveBeenCalledWith('i', cobradoExecucao === 25000 ? 'emitida' : 'dados_divergentes');
  expect(JSON.stringify(fila.concluirItem.mock.calls)).not.toMatch(/52998224725|Pessoa Ao Vivo|25000|26000/);
});
it('ausência de cobrado ao vivo exclui; consulta fora da leitura ao vivo não entra no escopo', async () => {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('from public.noto_consultas_sincronizadas') ? [{ fonte:'tribemd',id_externo:'1',valor_consulta_centavos:30000 },{ fonte:'tribemd',id_externo:'2',valor_consulta_centavos:30000 }] : [] }));
  const repo = new PostgresLotesEmissao({ query } as any,'pepper');
  expect(await repo.contarConsultasPeriodo('m','2026-10-01','2026-10-20T15:00Z',new Map([['1',null]])))
    .toMatchObject({ totalConsultas: 0, totalCentavos: 0, semValor: 1, consultas: [{ idExterno:'1',assinatura:null }] });
});
it.each([true, false])('retoma lote órfão somente com trava de sessão exclusiva (disponível=%s)', async livre => {
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('select l.*')) {
      expect(sql).toContain("interval '5 minutes'");
      expect(sql).toContain("pf.ambiente='homologacao'");
      expect(sql).toContain('skip locked');
      return { rows: [{ id:'l',medico_id:'m',estado:'processando',ate:'2026-10-20T15:00Z' }] };
    }
    if (sql.includes('pg_try_advisory_lock')) return { rows:[{ reservada:livre }] };
    if (sql.includes('select i.id')) return { rows:[{ id:'i',estado:'emitida',entregue:true,sem_contato:false }] };
    return { rows:[] };
  });
  const repo = new PostgresLotesEmissao({ connect:async()=>({ query,release }) } as any,'pepper');
  const r = await repo.reservar();
  if (!livre) { expect(r).toBeNull(); expect(query.mock.calls.some(([sql])=>sql.startsWith('update'))).toBe(false); expect(release).toHaveBeenCalledOnce(); return; }
  expect(r?.itens[0]).toMatchObject({ estado:'emitida',entregue:true });
  const reset = query.mock.calls.find(([sql])=>sql.startsWith('update public.noto_lotes_itens'))![0];
  expect(reset).toContain("estado='processando'"); expect(reset).toContain("set estado='pronto'");
  expect(query.mock.calls.some(([sql])=>sql.includes("set estado='confirmado'"))).toBe(true);
  expect(release).not.toHaveBeenCalled();
  await repo.liberarReserva('l');
  expect(query.mock.calls.some(([sql])=>sql.includes('pg_advisory_unlock'))).toBe(true);
  expect(release).toHaveBeenCalledOnce();
});
it('chamadas concorrentes reservam um único worker e só retomam após a sessão anterior liberar', async () => {
  let travada = false, estado = 'processando';
  const pool = { connect: async () => {
    let dona = false;
    return { release:vi.fn(), query:async (sql:string) => {
      if (sql.includes('select l.*')) return { rows:[{id:'l',medico_id:'m',estado,ate:'2026-10-20T15:00Z'}] };
      if (sql.includes('pg_try_advisory_lock')) { dona = !travada; if(dona) travada=true; return {rows:[{reservada:dona}]}; }
      if (sql.includes('pg_advisory_unlock')) { if(dona) travada=false; return {rows:[]}; }
      if (sql.includes("set estado='processando'")) estado='processando';
      return { rows:[] };
    } };
  } };
  const repos = Array.from({length:12},()=>new PostgresLotesEmissao(pool as any,'pepper'));
  const resultados = await Promise.all(repos.map(r=>r.reservar()));
  expect(resultados.filter(Boolean)).toHaveLength(1);
  expect(await repos[1].reservar()).toBeNull();
  await repos[resultados.findIndex(Boolean)].liberarReserva('l');
  expect(await repos[1].reservar()).not.toBeNull();
  await repos[1].liberarReserva('l');
});
it('erro durante recuperação faz rollback e solta a trava sem devolver sessão travada ao pool', async () => {
  const release=vi.fn();
  const query=vi.fn(async(sql:string)=>{
    if(sql.includes('select l.*')) return {rows:[{id:'l',estado:'processando'}]};
    if(sql.includes('pg_try_advisory_lock')) return {rows:[{reservada:true}]};
    if(sql.startsWith('update')) throw Error('banco indisponível');
    return {rows:[]};
  });
  const repo=new PostgresLotesEmissao({connect:async()=>({query,release})} as any,'pepper');
  await expect(repo.reservar()).rejects.toThrow('banco indisponível');
  expect(query.mock.calls.map(([s])=>s)).toContain('rollback');
  expect(query.mock.calls.some(([s])=>s.includes('pg_advisory_unlock'))).toBe(true);
  expect(release).toHaveBeenCalledWith(true);
});
it('sem lote confirmado ou órfão antigo elegível não altera itens nem segura conexão', async () => {
  const query=vi.fn(async()=>({rows:[]})),release=vi.fn();
  const repo=new PostgresLotesEmissao({connect:async()=>({query,release})} as any,'pepper');
  expect(await repo.reservar()).toBeNull();
  expect(query.mock.calls).toHaveLength(3);
  expect(release).toHaveBeenCalledOnce();
});
it('fonte do lote: padrão tribemd; amplimed só quando pedida, sempre como parâmetro (nunca no texto do SQL)', async () => {
  const query = vi.fn(async () => ({ rows: [] }));
  const repo = new PostgresLotesEmissao({ query } as any, 'pepper');
  await repo.contarConsultasPeriodo('m', '2026-10-01', '2026-10-20T15:00Z', new Map());
  await repo.contarConsultasPeriodo('m', '2026-10-01', '2026-10-20T15:00Z', new Map(), 'amplimed');
  expect((query.mock.calls[0] as any)[1][3]).toBe('tribemd'); expect((query.mock.calls[1] as any)[1][3]).toBe('amplimed');
  expect((query.mock.calls[0] as any)[0]).not.toMatch(/'tribemd'|'amplimed'/);
});

it('antirre-emissão: erro sem recusa definitiva volta BLOQUEADO, nunca pronto (regressão das chaves 19/21/22)', async () => {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('from public.noto_consultas_sincronizadas'))
      return { rows: ['19','21','22'].map(id => ({ fonte: 'tribemd', id_externo: id, valor_consulta_centavos: 30000 })) };
    expect(sql).toContain('substituida_em is null');
    return { rows: [{ estado: 'erro', recusa_definitiva: false, nota_fiscal_id: null }] };
  });
  const c = await new PostgresLotesEmissao({ query } as any, 'pepper').contarConsultasPeriodo('m', '2026-10-16', '2026-10-23T15:00Z', new Map([['19',30000],['21',18000],['22',25000]]));
  expect(c).toMatchObject({ totalConsultas: 0, totalCentavos: 0, bloqueadas: 3 }); expect(c.consultas).toEqual([]);
});
it('recusa definitiva comprovada reabre; tentativa ativa não resolvida bloqueia; nota_gerada fica fora', async () => {
  const chave = (id: string) => chaveConsulta('pepper', 'm', 'tribemd', id);
  const query = vi.fn(async (sql: string, p?: unknown[]) => {
    if (sql.includes('from public.noto_consultas_sincronizadas'))
      return { rows: ['1','2','3'].map(id => ({ fonte: 'tribemd', id_externo: id, valor_consulta_centavos: 30000 })) };
    if (p?.[1] === chave('1')) return { rows: [{ estado: 'erro', recusa_definitiva: true, nota_fiscal_id: null }] };
    if (p?.[1] === chave('2')) return { rows: [{ estado: 'erro', recusa_definitiva: true, nota_fiscal_id: null }, { estado: 'erro', recusa_definitiva: false, nota_fiscal_id: null }] };
    return { rows: [{ estado: 'nota_gerada', recusa_definitiva: false, nota_fiscal_id: null }] };
  });
  const c = await new PostgresLotesEmissao({ query } as any, 'pepper').contarConsultasPeriodo('m', '2026-10-16', '2026-10-23T15:00Z', new Map([['1',30000],['2',30000],['3',30000]]));
  expect(c.consultas.map(x => x.idExterno)).toEqual(['1']); expect(c.bloqueadas).toBe(1); expect(c.totalConsultas).toBe(1);
});
it('abandonarPendentes recusa só lotes pendentes de OUTRA chave, sem tocar em concluídos', async () => {
  const query = vi.fn(async (_sql:string, _parametros:unknown[] = []) => ({ rows: [] }));
  await new PostgresLotesEmissao({ query } as any, 'pepper').abandonarPendentes('m', 'chave-nova');
  const [sql, p] = query.mock.calls[0]!;
  expect(sql).toContain("set estado='recusado'"); expect(sql).toContain('chave_evento<>$2');
  expect(sql).toContain("estado in ('aguardando_data_inicio','aguardando_confirmacao_lote')"); expect(p).toEqual(['m', 'chave-nova']);
});
it('reservar rebaixa para bloqueada o item cuja chave tem tentativa ativa não concluída de outro item', async () => {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    if (sql.includes('join medico_perfil_fiscal')) return { rows: [{ id: 'l', medico_id: 'm', conversa: 'c', desde: '2026-10-16', ate: '2026-10-23T15:00Z', total_consultas: 1, total_centavos: 30000, sem_valor: 0, estado: 'confirmado', mensagem_confirmacao_id: null, pergunta_em: null }] };
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ reservada: true }] };
    if (sql.includes('from public.noto_lotes_itens')) return { rows: [{ id: 'i', fonte: 'tribemd', id_externo: '19', consulta_chave: 'k', assinatura: 'a', estado: 'bloqueada', entregue: false, sem_contato: false }] };
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  const repo = new PostgresLotesEmissao({ connect: async () => client } as any, 'pepper');
  const r = await repo.reservar();
  const itensSql = calls.find(x => x.includes('from public.noto_lotes_itens'))!;
  expect(itensSql).toContain("b.estado<>'nota_gerada'"); expect(itensSql).toContain('b.recusa_definitiva'); expect(itensSql).toContain('substituida_em is null');
  expect(r?.itens[0]).toMatchObject({ estado: 'bloqueada', idExterno: '19' });
  await repo.liberarReserva('l');
});
it('listagem concilia consulta pela mesma trava fiscal da contagem, sem liberar tentativas incertas',async()=>{
 const query=vi.fn(async(_sql:string,p:unknown[])=>({rows:p[1]===chaveConsulta('p','m','amplimed','autorizada')?[{estado:'nota_gerada',nota_fiscal_id:'n'}]:p[1]===chaveConsulta('p','m','amplimed','incerta')?[{estado:'erro',recusa_definitiva:false}]:[]}));
 const r=new PostgresLotesEmissao({query} as any,'p');
 expect(await r.situacaoConsulta('m','amplimed','autorizada')).toBe('ja_faturada');
 expect(await r.situacaoConsulta('m','amplimed','incerta')).toBe('bloqueada');
 expect(await r.situacaoConsulta('m','amplimed','nova')).toBe('pendente');
 expect(query.mock.calls.every(([s])=>s.includes('substituida_em is null'))).toBe(true);
});
