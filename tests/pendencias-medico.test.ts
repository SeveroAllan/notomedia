import { expect, it, vi } from 'vitest';
import { PendenciasMedico, formatarPendencias, type ContextoPendencias, type RepositorioContextoPendencias } from '../src/onboarding/pendencias-medico.js';
const agora = new Date('2026-10-21T01:00Z');
const resultado = { ok: true, total: 23, consultas: Array.from({ length: 20 }, (_, i) => ({ paciente: `Pessoa Ficticia ${String.fromCharCode(65 + i)}`, dataHora: '2026-10-19T14:00Z', valorCentavos: 30000 })) };
it('lista determinística mantém nome + data, informa restantes e mascara memória', () => {
  const r = formatarPendencias(resultado, '2026-09-03');
  expect(r.fala.length).toBeLessThanOrEqual(3); expect(r.fala.every(t => t.length <= 500)).toBe(true);
  expect(r.fala.join('\n')).toContain('desde 03/09/2026'); expect(r.fala.join('\n')).toContain('Pessoa Ficticia A — 19/10/2026');
  expect(r.fala.join('\n')).toMatch(/e mais \d+ consultas/);
  for (const balao of r.fala) for (const linha of balao.split('\n')) if (linha.includes('Pessoa Ficticia')) expect(linha).toContain('19/10/2026');
  expect(r.falaMemoria.join('\n')).not.toContain('Pessoa Ficticia'); expect(r.falaMemoria.join('\n')).toContain('[PACIENTE]');
});
it('aceita dataHora como instância Date retornada pelo driver pg (timestamptz)', () => {
  const r = formatarPendencias({ ok: true, total: 1, consultas: [{ paciente: 'Pessoa Ficticia A', dataHora: new Date('2026-10-19T14:00Z'), valorCentavos: 30000 }] }, '2026-09-03');
  expect(r.fala.join('\n')).toContain('Pessoa Ficticia A — 19/10/2026');
});
it('zero exige total zero confirmado; lista contraditória ou incompleta não afirma ausência', () => {
  expect(formatarPendencias({ ok: true, total: 0, consultas: [] }, '2026-09-03').fala.join(' ')).toContain('Não há nenhuma pendência desde 03/09/2026');
  expect(() => formatarPendencias({ ok: true, total: 23, consultas: [] }, '2026-09-03')).toThrow();
  expect(() => formatarPendencias({ ok: false, motivo: 'SINCRONIZACAO_INCOMPLETA' }, '2026-09-03')).toThrow();
});
function cenario() {
  const estado: ContextoPendencias = { dataInicio: null, aguardandoData: false };
  let sync = false;
  const repo: RepositorioContextoPendencias = { ler: vi.fn(async () => ({ ...estado })), perguntarData: vi.fn(async () => { const primeira = !estado.aguardandoData; estado.aguardandoData = true; return primeira; }),
    definirInicio: vi.fn(async (_m, data) => { estado.dataInicio = data; estado.aguardandoData = false; }),
    reservarSync: vi.fn(async () => { if (sync) return false; sync = true; estado.syncAtiva = true; return true; }), concluirSync: vi.fn(async () => { estado.syncAtiva = false; }), registrarAviso: vi.fn(async (_m, texto) => { estado.ultimoAviso = texto; }) };
  const enviar = vi.fn(async (_m: string, _c: string, _k: string, _f: string[], _memoria?: string[]) => {});
  const deps = { permitido: vi.fn(async () => true), classificar: vi.fn(async () => ({ verificar: true, desde: null as string | null, moldura: 'Conferi esse período.' })),
    listar: vi.fn(async () => ({ ...resultado, total: 1, consultas: resultado.consultas.slice(0, 1) } as any)), enviar,
    log: vi.fn(), demoraMs: 1000 };
  return { estado, repo, deps, fluxo: new PendenciasMedico(repo, deps) };
}
it('intenção de verificar sem ação do conversador exige data uma vez e depois ferramenta, nunca memória como resultado', async () => {
  const c = cenario();
  const e = { medicoId: 'm', conversa: 'c', chave: '1', texto: 'ver penentes', mensagens: ['quer verificar pendências?'], agora };
  expect(await c.fluxo.responder(e)).toBe(true); expect(c.deps.listar).not.toHaveBeenCalled();
  await c.fluxo.responder({ ...e, chave: '2' }); expect(c.repo.perguntarData).toHaveBeenCalledTimes(2);
  const perguntas = c.deps.enviar.mock.calls.flatMap(c => c[3]).filter(t => t.includes('?')); expect(perguntas).toHaveLength(1);
  c.deps.classificar.mockResolvedValue({ verificar: true, desde: '2026-09-03', moldura: 'Conferi esse período.' });
  await c.fluxo.responder({ ...e, chave: '3', texto: 'desdi 3 de setenbro' });
  expect(c.deps.listar).toHaveBeenCalledWith('m', '2026-09-03', agora);
  expect(c.deps.enviar.mock.calls.at(-1)?.[3].join(' ')).toContain('Pessoa Ficticia A — 19/10/2026');
  expect(c.deps.enviar.mock.calls.flatMap(c => c[3]).join(' ')).not.toContain('deixa eu ver um minutinho');
});
it('resposta rápida não envia aviso; lista sempre refaz leitura mesmo com início já conhecido', async () => {
  const c = cenario(); c.estado.dataInicio = '2026-09-03';
  await c.fluxo.responder({ medicoId: 'm', conversa: 'c', chave: '1', texto: 'ver pendentes', mensagens: [], agora });
  await c.fluxo.responder({ medicoId: 'm', conversa: 'c', chave: '2', texto: 'ver de novo', mensagens: [], agora });
  expect(c.deps.listar).toHaveBeenCalledTimes(2); expect(c.deps.enviar).toHaveBeenCalledTimes(2);
});
it('sync incompleta dispara leitura real em fundo e empurra resultado sem nova mensagem', async () => {
  const c = cenario(); c.estado.dataInicio = '2026-09-03';
  let liberar!: (r: unknown) => void;
  const fundo = new Promise<any>(r => { liberar = r; });
  c.deps.listar.mockResolvedValueOnce({ ok: false, motivo: 'SINCRONIZACAO_INCOMPLETA' }).mockImplementationOnce(() => fundo);
  await c.fluxo.responder({ medicoId: 'm', conversa: 'c', chave: '1', texto: 'ver pendentes', mensagens: [], agora });
  expect(c.deps.listar).toHaveBeenCalledTimes(2);
  expect(c.deps.enviar.mock.calls[0][3].join(' ')).toContain('Ainda estou lendo sua agenda');
  liberar({ ...resultado, total: 1, consultas: resultado.consultas.slice(0, 1) }); await c.fluxo.aguardar();
  expect(c.deps.enviar.mock.calls.at(-1)?.[3].join(' ')).toContain('Pessoa Ficticia A — 19/10/2026');
  expect(c.repo.concluirSync).toHaveBeenCalledWith('m', '1', true);
});
it('gate bloqueia sem leitura/IA/envio e falha técnica não revela código', async () => {
  const c = cenario(); c.deps.permitido.mockResolvedValue(false);
  expect(await c.fluxo.responder({ medicoId: 'm', conversa: 'c', chave: '1', texto: 'ver', mensagens: [], agora })).toBe(false);
  expect(c.deps.classificar).not.toHaveBeenCalled(); expect(c.deps.listar).not.toHaveBeenCalled(); expect(c.deps.enviar).not.toHaveBeenCalled();
});

it('consulta lenta envia aviso só durante leitura real e alterna a formulação nos turnos', async () => {
  vi.useFakeTimers();
  try {
    const c = cenario(); c.estado.dataInicio = '2026-09-03';
    for (const chave of ['1', '2']) {
      let liberar!: (r: any) => void;
      c.deps.listar.mockImplementationOnce(() => new Promise(r => { liberar = r; }));
      const p = c.fluxo.responder({ medicoId: 'm', conversa: 'c', chave, texto: 'ver pendentes', mensagens: [], agora });
      await vi.advanceTimersByTimeAsync(1001);
      const avisos = c.deps.enviar.mock.calls.filter(c => c[2].endsWith(':espera'));
      expect(avisos).toHaveLength(Number(chave));
      liberar({ ...resultado, total: 1, consultas: resultado.consultas.slice(0,1) }); await p;
    }
    const avisos = c.deps.enviar.mock.calls.filter(c => c[2].endsWith(':espera')).map(c => c[3].join(' '));
    expect(avisos[0]).not.toBe(avisos[1]); expect(c.deps.listar).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
it('erro da sync em fundo explica instabilidade sem zero nem código técnico', async () => {
  const c = cenario(); c.estado.dataInicio = '2026-09-03';
  c.deps.listar.mockResolvedValueOnce({ ok: false, motivo: 'SEM_CONSULTAS_SINCRONIZADAS' }).mockRejectedValueOnce(Error('BANCO_SENHA_SUPER_PRIVADA'));
  await c.fluxo.responder({ medicoId: 'm', conversa: 'c', chave: '1', texto: 'ver pendentes', mensagens: [], agora }); await c.fluxo.aguardar();
  const fala = c.deps.enviar.mock.calls.flatMap(c => c[3]).join(' ');
  expect(fala).toContain('instabilidade'); expect(fala).not.toMatch(/BANCO|SENHA|nenhuma pendência|não há/i);
  expect(c.repo.concluirSync).toHaveBeenCalledWith('m', '1', false);
});
it('pós-conexão sem início aguarda sync verdadeira e só então pergunta a data', async () => {
  const c = cenario(); let liberar!: (r: { ok: boolean }) => void;
  const sincronizar = vi.fn(() => new Promise<{ ok: boolean }>(r => { liberar = r; }));
  const fluxo = new PendenciasMedico(c.repo, { ...c.deps, sincronizar });
  await fluxo.aposSyncIncompleta('m','c','evento',agora);
  expect(c.repo.perguntarData).not.toHaveBeenCalled(); expect(sincronizar).toHaveBeenCalledOnce();
  liberar({ ok: true }); await fluxo.aguardar();
  expect(c.repo.perguntarData).toHaveBeenCalledOnce(); expect(c.deps.enviar.mock.calls.at(-1)?.[3].join(' ')).toContain('Desde que dia');
  expect(c.deps.listar).not.toHaveBeenCalled();
});
it('classificador independente usa contexto e relógio, sem depender de acao; JSON indevido não destrava', async () => {
  const { classificarPendencias } = await import('../src/onboarding/pendencias-medico.js');
  const completar = vi.fn(async () => '{"verificar":true,"desde":"2026-10-19","moldura":"Veja o que encontrei."}');
  const entrada = { texto: 've as penentes desdi onten', mensagens: ['Quer verificar suas pendências?'], agora, aguardandoData: false };
  expect(await classificarPendencias('key','model',completar,entrada)).toMatchObject({ verificar: true, desde: '2026-10-19' });
  expect(completar.mock.calls[0][2][1].content).toContain('2026-10-20'); expect(completar.mock.calls[0][2][1].content).toContain('Quer verificar');
  completar.mockResolvedValue('{"verificar":true,"desde":"2026-10-19","acao":"emitir"}');
  expect((await classificarPendencias('key','model',completar,entrada)).verificar).toBe(false);
});
it('controle persistido guarda só período/estado, com reserva atômica e migration manual protegida', async () => {
  const { PostgresContextoPendencias } = await import('../src/io/postgres/postgres-contexto-pendencias.js');
  const { readFileSync } = await import('node:fs');
  let perguntou = false;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('aguardando_data) values')) { const rows = perguntou ? [] : [{ medico_id: 'm' }]; perguntou = true; return { rows }; }
    return { rows: [{ medico_id: 'm' }] };
  });
  const repo = new PostgresContextoPendencias({ query } as any);
  expect(await repo.perguntarData('m')).toBe(true); expect(await repo.perguntarData('m')).toBe(false);
  expect(query.mock.calls[0][0]).toContain('where not noto_contexto_pendencias.aguardando_data');
  await repo.definirInicio('m', '2026-09-03');
  expect(query.mock.calls.at(-1)?.[0]).toContain("sync_estado='executando' then noto_contexto_pendencias.atualizado_em");
  await repo.reservarSync('m', 'pedido');
  expect(query.mock.calls.at(-1)?.[0]).toContain("sync_estado is distinct from 'executando'");
  const sql = readFileSync('scripts/migrations/20261025-contexto-pendencias.sql', 'utf8');
  expect(sql).toContain('enable row level security'); expect(sql).toContain('from anon, authenticated'); expect(sql).toContain('references public.medicos(id) on delete cascade');
  expect(sql).not.toMatch(/nome|cpf|valor_cobrado|valor_consulta|create policy/i);
});
