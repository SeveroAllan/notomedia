import { config } from '../src/config.js';
import { auditarComprovante, type DecisaoPedidoComprovante } from '../src/atendimento/comprovante.js';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { normalizarResultadoAgenda, type FonteAgenda, type EntradaFonteAgenda, type ResultadoFonteAgenda } from '../src/agenda/fonte-agenda.js';
import { sincronizarAgenda } from '../src/agenda/sincronizar-agenda.js';
import { PostgresConsultasSincronizadas } from '../src/io/postgres/postgres-consultas-sincronizadas.js';
import { PostgresAtendimentoRepositorio } from '../src/io/postgres/postgres-atendimento-repositorio.js';
import { HistoricoComunicacaoEmMemoria } from '../src/onboarding/historico-comunicacao-repositorio.js';
import { PostgresHistoricoComunicacao } from '../src/io/postgres/postgres-historico-comunicacao.js';
import { orquestrarComprovante } from '../src/fluxos/processar-comprovante.js';
import { BancoAgendaFalso } from './fakes/banco-agenda.js';
import { BancoHistoricoFalso } from './fakes/banco-historico.js';
import type { ResultadoExtracaoComprovante } from '../src/atendimento/comprovante.js';

const medico = '00000000-0000-4000-8000-000000000001', paciente = '00000000-0000-4000-8000-000000000002';
const entrada: EntradaFonteAgenda = { medicoId: medico, referenciaCofre: 'referencia-opaca-ficticia' };
function agenda(): Extract<ResultadoFonteAgenda, { tipo: 'consultas' }> {
  return { tipo: 'consultas', fonte: 'agenda-falsa', consultas: [{ pacienteId: paciente, telefonePaciente: '11999990000', idExterno: 'consulta-externa-ficticia',
    dataHora: '2026-10-18T12:00:00Z', status: 'realizada', valorConsultaCentavos: 35000 }] };
}
class FonteFalsa implements FonteAgenda {
  recebidas: EntradaFonteAgenda[] = [];
  constructor(public resultado: ResultadoFonteAgenda) {}
  async consultar(dados: EntradaFonteAgenda) { this.recebidas.push(structuredClone(dados)); return structuredClone(this.resultado); }
}
let rede: ReturnType<typeof vi.spyOn>;
beforeEach(() => { rede = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('REDE_PROIBIDA'); }); });
afterEach(() => { expect(rede).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
function cenario(resultado: ResultadoFonteAgenda = agenda()) {
  const banco = new BancoAgendaFalso(); const fonte = new FonteFalsa(resultado);
  banco.pacientes.set(JSON.stringify([medico, paciente]), { nome: 'Paciente Ficticio', cpf: '52998224725' });
  const repositorio = new PostgresConsultasSincronizadas(banco as unknown as pg.Pool);
  const leitor = new PostgresAtendimentoRepositorio(banco as unknown as pg.Pool, 'chave-ficticia');
  return { banco, fonte, repositorio, leitor };
}
const mensagem = { key: { id: 'mensagem-ficticia', remoteJid: '5511999990000@s.whatsapp.net', fromMe: false }, message: { imageMessage: {} } };
const lido: ResultadoExtracaoComprovante = { tipo: 'extraido', campos: { valorCentavos: 35000, dataPagamento: '2026-10-18', nomePagador: 'Paciente Ficticio', nomeFavorecido: 'Medica Ficticia',
  confianca: { valorCentavos: 0.90, dataPagamento: 0.90, nomePagador: 0.90, nomeFavorecido: 0.90 } } };

describe('fonte normalizada e sincronização determinística', () => {
  it('normalização é pura e valor ausente fica null, sem inferir valor', () => {
    const dados = agenda(); delete dados.consultas[0].valorConsultaCentavos; const antes = structuredClone(dados);
    expect(normalizarResultadoAgenda(dados)).toEqual({ ...dados, consultas: [{ ...dados.consultas[0], valorConsultaCentavos: null }] });
    expect(dados).toEqual(antes); expect(normalizarResultadoAgenda(dados)).toEqual(normalizarResultadoAgenda(dados));
  });
  it('fonte recebe só médico/referência; duas sincronizações não duplicam', async () => {
    const c = cenario();
    expect(await sincronizarAgenda(entrada, c.fonte, c.repositorio)).toEqual(agenda());
    await sincronizarAgenda(entrada, c.fonte, c.repositorio);
    expect(c.fonte.recebidas).toEqual([entrada, entrada]); expect(c.banco.consultas.size).toBe(1);
    expect([...c.banco.consultas.values()]).toEqual([{ medico_id: medico, fonte: 'agenda-falsa', paciente_id: paciente,
      id_externo: 'consulta-externa-ficticia', data_hora: '2026-10-18T12:00:00Z', status: 'realizada', valor_consulta_centavos: 35000 }]);
  });
  it.each(['cancelada', 'faltou', 'agendada'] as const)('status alterado para %s atualiza a mesma consulta', async status => {
    const c = cenario(); await sincronizarAgenda(entrada, c.fonte, c.repositorio);
    const dados = agenda(); dados.consultas[0].status = status; c.fonte.resultado = dados;
    await sincronizarAgenda(entrada, c.fonte, c.repositorio);
    expect(c.banco.consultas.size).toBe(1); expect([...c.banco.consultas.values()][0].status).toBe(status);
    expect((await c.leitor.lerEstado(medico, paciente)).ultimaConsulta).toBeNull();
  });
  it('a mesma chave externa não mistura médicos ou fontes', async () => {
    const c = cenario(); await sincronizarAgenda(entrada, c.fonte, c.repositorio);
    await sincronizarAgenda({ ...entrada, medicoId: '00000000-0000-4000-8000-000000000003' }, c.fonte, c.repositorio);
    const outra = agenda(); outra.fonte = 'outra-agenda-falsa'; c.fonte.resultado = outra;
    await sincronizarAgenda(entrada, c.fonte, c.repositorio); expect(c.banco.consultas.size).toBe(3);
  });
  it.each(['FONTE_INDISPONIVEL', 'ACESSO_EXPIRADO', 'SEM_AGENDA_CONECTADA'] as const)('erro tipado %s não grava consultas', async codigo => {
    const c = cenario({ tipo: 'erro', codigo });
    expect(await sincronizarAgenda(entrada, c.fonte, c.repositorio)).toEqual({ tipo: 'erro', codigo });
    expect(c.banco.chamadas).toEqual([]); expect(c.banco.consultas.size).toBe(0);
  });
  it('campos não contratados são rejeitados antes da escrita', async () => {
    const dados = { ...agenda(), extra: null }; expect(() => normalizarResultadoAgenda(dados)).toThrow();
    const c = cenario(dados); await expect(sincronizarAgenda(entrada, c.fonte, c.repositorio)).rejects.toThrow();
    expect(c.banco.chamadas).toEqual([]);
  });
});
for (const armazenamento of ['memoria', 'postgres'] as const) describe('ciclo com situação de agenda explícita: ' + armazenamento, () => {
  it.each(['SEM_AGENDA_CONECTADA', 'FONTE_INDISPONIVEL', 'ACESSO_EXPIRADO'] as const)('%s devolve ação própria auditada, sem extrair comprovante', async codigo => {
    const c = cenario({ tipo: 'erro', codigo }); const resultado = await sincronizarAgenda(entrada, c.fonte, c.repositorio);
    const bancoHistorico = new BancoHistoricoFalso();
    const historico = armazenamento === 'memoria' ? new HistoricoComunicacaoEmMemoria() : new PostgresHistoricoComunicacao(bancoHistorico as unknown as pg.Pool);
    const extrair = vi.fn(async () => lido); const logs: string[] = [];
    const decisao = await orquestrarComprovante({ medicoId: medico, pacienteId: paciente, mensagem }, {
      agenda: resultado, lerEstado: c.leitor.lerEstado.bind(c.leitor), historico, extrator: { extrair }, log: (_nivel, texto) => logs.push(texto)
    });
    const esperada: DecisaoPedidoComprovante = codigo === 'SEM_AGENDA_CONECTADA'
      ? { tipo: 'pedir_agenda', agendaInformada: null, motivo: codigo }
      : { tipo: 'perguntar_medico', motivo: codigo };
    expect(decisao).toEqual(esperada); expect(extrair).not.toHaveBeenCalled();
    expect((await historico.lerComprovantes(medico))[0]).toEqual(auditarComprovante(config.appPepper, await c.leitor.lerEstado(medico, paciente), null, esperada));
    expect(logs).toEqual(['enviaria ' + esperada.tipo]);
  });
});
it('ciclo usa a última realizada sob demanda sem persistir consulta ou inventar valor', async () => {
  const c = cenario(); const historico = new HistoricoComunicacaoEmMemoria(); const logs: string[] = [];
  const deps = { fonteAgenda: c.fonte, lerEstado: c.leitor.lerEstado.bind(c.leitor), historico,
    extrator: { extrair: async () => lido }, log: (_nivel: 'info' | 'erro', texto: string) => logs.push(texto) };
  expect((await orquestrarComprovante({ medicoId: medico, pacienteId: paciente, mensagem }, deps)).tipo).toBe('pedido_nota_pronto');
  const semValor = agenda(); delete semValor.consultas[0].valorConsultaCentavos;
  c.fonte.resultado = semValor;
  expect(c.banco.consultas.size).toBe(0);
  expect((await c.leitor.lerEstado(medico, paciente)).ultimaConsulta).toBeNull();
  const outroHistorico = new HistoricoComunicacaoEmMemoria();
  expect(await orquestrarComprovante({ medicoId: medico, pacienteId: paciente, mensagem }, { ...deps, historico: outroHistorico }))
    .toEqual({ tipo: 'perguntar_medico', motivo: 'CADASTRO_INCOMPLETO' });
});
it('agenda conectada sem consultas não é interpretada como desconexão', async () => {
  const c = cenario({ tipo: 'consultas', fonte: 'agenda-falsa', consultas: [] });
  const historico = new HistoricoComunicacaoEmMemoria();
  expect(c.banco.consultas.size).toBe(0);
  expect(await orquestrarComprovante({ medicoId: medico, pacienteId: paciente, mensagem }, { fonteAgenda: c.fonte,
    lerEstado: c.leitor.lerEstado.bind(c.leitor), historico, extrator: { extrair: async () => lido }, log: () => {} }))
    .toEqual({ tipo: 'perguntar_medico', motivo: 'VINCULO_TELEFONE_INDEFINIDO' });
});
it('migração e fixtures não contêm segredos nem dados pessoais na tabela normalizada', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {}); const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const c = cenario(); await sincronizarAgenda(entrada, c.fonte, c.repositorio);
  const verificar = (valor: unknown): void => {
    if (typeof valor === 'string') { expect(valor).not.toMatch(/(?:senha|password|token|cookie)\s*[\"']?\s*[:=]/i); return; }
    if (!valor || typeof valor !== 'object') return;
    for (const [campo, conteudo] of Object.entries(valor)) { expect(campo).not.toMatch(/senha|password|token|cookie/i); verificar(conteudo); }
  };
  verificar([entrada, c.fonte.recebidas, agenda(), [...c.banco.consultas.values()], c.banco.chamadas, info.mock.calls, erro.mock.calls, log.mock.calls]);
  const tabela = [...c.banco.consultas.values()][0]; expect(tabela).not.toHaveProperty('referenciaCofre'); expect(tabela).not.toHaveProperty('cpf'); expect(tabela).not.toHaveProperty('nome');
  const sql = readFileSync('scripts/migrations/20261018-consultas-sincronizadas.sql', 'utf8').toLowerCase();
  expect(sql).toMatch(/primary key \(medico_id, fonte, id_externo\)/);
  expect(sql).toMatch(/references public\.medicos\(id\) on delete cascade/);
  expect(sql).toContain('enable row level security'); expect(sql).not.toMatch(/create policy/);
  expect(sql).toContain('from public'); expect(sql).toContain('from anon'); expect(sql).toContain('from authenticated');
  expect(sql).not.toMatch(/\b(senha|password|token|cookie|cpf|nome)\b/);
});

it.each([
  [{ nome: 'tribemd', conectada: false }, 'SEM_AGENDA_CONECTADA'],
  [{ nome: 'outra', conectada: true }, 'AGENDA_NAO_SUPORTADA'],
  [{ nome: null, conectada: true }, 'AGENDA_NAO_SUPORTADA']
])('consulta de pendências recusa agenda %j sem SQL', async (agenda, motivo) => {
  const query = vi.fn(), faturada = vi.fn();
  expect(await new PostgresConsultasSincronizadas({ query } as any).listarConsultasSemNota(medico, agenda as any, new Date('2026-10-20T15:00Z'), faturada))
    .toEqual({ ok: false, motivo });
  expect(query).not.toHaveBeenCalled(); expect(faturada).not.toHaveBeenCalled();
});
it.each(['sem sincronizadas', 'sem pendências', 'erro'])('consulta de pendências trata %s', async caso => {
  const query = vi.fn(async () => ({ rows: caso === 'sem sincronizadas' ? [] : [{}] }));
  if (caso === 'erro') query.mockRejectedValueOnce(Error('banco indisponível'));
  if (caso === 'sem pendências') query.mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [] });
  expect(await new PostgresConsultasSincronizadas({ query } as any).listarConsultasSemNota(medico, { nome: 'tribemd', conectada: true }, new Date('2026-10-20T15:00Z'), vi.fn(), undefined, false, '2026-09-03'))
    .toEqual(caso === 'sem pendências' ? { ok: true, total: 0, consultas: [], dataInicio: '2026-09-03' } : { ok: false, motivo: caso === 'erro' ? 'AGENDA_INDISPONIVEL' : 'SEM_CONSULTAS_SINCRONIZADAS' });
});
it('pendências usam o mesmo verificador de faturamento, início informado, total e no máximo 20 sem identificadores sensíveis', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ id_externo: String(i), paciente: `Paciente ${i}`, data_hora: '2026-10-19T15:00Z', valor_consulta_centavos: 30000 }));
  const query = vi.fn(async (_sql: string, _p: unknown[]) => ({ rows })).mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows });
  const faturada = vi.fn(async (_fonte: string, id: string) => id === '0');
  const resultado = await new PostgresConsultasSincronizadas({ query } as any).listarConsultasSemNota(medico, { nome: 'tribemd', conectada: true }, new Date('2026-10-20T15:00Z'), faturada, id => `Paciente ${id}`, false, '2026-09-03');
  expect(resultado).toEqual({ ok: true, total: 24, dataInicio: '2026-09-03', consultas: rows.slice(1, 21).map(c => ({ paciente: c.paciente, dataHora: c.data_hora, valorCentavos: c.valor_consulta_centavos })) });
  expect(faturada).toHaveBeenCalledTimes(25); expect(faturada).toHaveBeenCalledWith('tribemd', '0');
  expect(query.mock.calls[1][1]).toEqual([medico, 'tribemd', '2026-10-20T15:00:00.000Z', '2026-09-03']);
  const sql = query.mock.calls[1][0];
  expect(sql).toContain("c.status='realizada'"); expect(sql).toContain("$4::date::timestamp at time zone 'America/Sao_Paulo'"); expect(sql).toContain('c.data_hora <= $3');
  expect(sql).toContain('p.medico_id=c.medico_id'); expect(sql).not.toMatch(/cpf/);
  expect(JSON.stringify(resultado)).not.toContain('11999990000');
});

it('sync mapeia o ID numérico do portal só na persistência, preservando critério transitório do comprovante', async () => {
  const fonte = new FonteFalsa({ tipo: 'consultas', fonte: 'tribemd', consultas: [{ ...agenda().consultas[0], pacienteId: '456' }] });
  const salvar = vi.fn(async () => {}), resolver = vi.fn(async () => paciente);
  const resultado = await sincronizarAgenda({ ...entrada, janelaDias: 90, agora: new Date('2026-10-20T15:00:00Z') }, fonte, { salvar }, resolver);
  expect(resultado).toMatchObject({ consultas: [{ pacienteId: '456' }] });
  expect(salvar).toHaveBeenCalledExactlyOnceWith(medico, 'tribemd', [expect.objectContaining({ pacienteId: paciente })]);
  expect(resolver).toHaveBeenCalledExactlyOnceWith(medico, expect.objectContaining({ pacienteId: '456' }));
  expect(fonte.recebidas[0]).toMatchObject({ janelaDias: 90, agora: new Date('2026-10-20T15:00:00Z') });
});
it.each([false, true])('telefone do portal resolve paciente local existente=%s sem gravar nome', async existe => {
  const query = vi.fn(async (sql: string, p: any[]) => {
    if (sql.startsWith('select id from pacientes')) { expect(p[1]).toContain('555193527271'); expect(p[1]).toContain('5551993527271'); return { rows: existe ? [{ id: paciente }] : [] }; }
    if (sql.includes('insert into pacientes')) {
      expect(p).toEqual([medico, '5551993527271', null, undefined, undefined, 'agenda_tribemd_sync', null, '']);
      return { rows: [{ id: paciente, medico_id: medico, telefone: p[1], nome: null }] };
    }
    throw Error('SQL não modelado');
  });
  const repo = new PostgresConsultasSincronizadas({ query } as unknown as pg.Pool);
  expect(await repo.resolverPaciente(medico, { ...agenda().consultas[0], pacienteId: '456', telefonePaciente: '555193527271', valorConsultaCentavos: 35000 })).toBe(paciente);
  expect(query.mock.calls.filter(([s]) => s.includes('insert into pacientes'))).toHaveLength(existe ? 0 : 1);
  expect(JSON.stringify(query.mock.calls)).not.toContain('Nome do portal');
});
it('mapeamento recusa telefone ausente ou múltiplos cadastros e nunca salva ID numérico', async () => {
  const query = vi.fn(async () => ({ rows: [{ id: paciente }, { id: 'outro' }] }));
  const repo = new PostgresConsultasSincronizadas({ query } as unknown as pg.Pool);
  await expect(repo.resolverPaciente(medico, { ...agenda().consultas[0], telefonePaciente: undefined, valorConsultaCentavos: 35000 })).rejects.toThrow('TELEFONE_AGENDA_INVALIDO');
  expect(query).not.toHaveBeenCalled();
  await expect(repo.resolverPaciente(medico, agenda().consultas[0] as any)).rejects.toThrow('VINCULO_PACIENTE_AMBIGUO');
});
it('pendências usam nome ao vivo por atendimento e mascaram telefone quando não há nome, sem gravar', async () => {
  const query = vi.fn(async (_sql: string, _p: unknown[]) => ({ rows: [{}] })).mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [
    { id_externo: 'a', telefone: '5551993527271', data_hora: '2026-10-19T15:00Z', valor_consulta_centavos: 30000 },
    { id_externo: 'b', telefone: '5551993528888', data_hora: '2026-10-18T15:00Z', valor_consulta_centavos: null }
  ] } as any);
  const vivo = vi.fn(async (id: string) => id === 'a' ? 'Nome Apenas Vivo' : null);
  const r = await new PostgresConsultasSincronizadas({ query } as any).listarConsultasSemNota(medico, { nome: 'tribemd', conectada: true }, new Date('2026-10-20T15:00Z'), vi.fn(async () => false), vivo, false, '2026-09-03');
  expect(r).toMatchObject({ ok: true, total: 2, consultas: [{ paciente: 'Nome Apenas Vivo' }, { paciente: 'Contato •••• 8888' }] });
  expect(JSON.stringify(r)).not.toContain('5551993528888');
  expect(vivo).toHaveBeenCalledTimes(2); expect(JSON.stringify(query.mock.calls)).not.toContain('Nome Apenas Vivo');
  expect(query.mock.calls.some(c => /insert|update/i.test(String(c[0])))).toBe(false);
});
it.each([undefined, '2026-10-21', '2026-02-30', '2025-01-01'])('pendências sem início válido não consultam o banco nem assumem 90 dias: %s', async inicio => {
  const query = vi.fn(), faturada = vi.fn();
  const r = await new PostgresConsultasSincronizadas({ query } as any).listarConsultasSemNota(medico, { nome: 'tribemd', conectada: true }, new Date('2026-10-20T15:00Z'), faturada, undefined, false, inicio);
  expect(r).toEqual({ ok: false, motivo: 'DATA_INICIO_NECESSARIA' }); expect(query).not.toHaveBeenCalled(); expect(faturada).not.toHaveBeenCalled();
});
it('sync não grava nome nem cobrado ao vivo, mesmo quando diferentes do valor da consulta', async () => {
  const query = vi.fn(async (_sql:string, _parametros?:unknown[]) => ({ rows: [] }));
  await new PostgresConsultasSincronizadas({ query } as any).salvar(medico,'tribemd', [{ pacienteId: 'paciente', idExterno: '12', dataHora: '2026-10-19T12:00Z', status: 'realizada', nomeAoVivo: 'Pessoa Efemera', valorConsultaCentavos: 30000, valorCobradoAoVivoCentavos: 25000 }]);
  const payload = JSON.parse(String(query.mock.calls[0]![1]?.[2]));
  expect(payload).toEqual([{ paciente_id:'paciente',id_externo:'12',data_hora:'2026-10-19T12:00Z',status:'realizada',valor_consulta_centavos:30000 }]);
  expect(JSON.stringify(query.mock.calls)).not.toMatch(/Pessoa Efemera|25000|valorCobrado/);
});
it('frescor só em RAM por médico: dez minutos, cobertura de janela, invalidação e isolamento', async () => {
  vi.useFakeTimers();
  try {
    const { CacheAgendaProcesso } = await import('../src/agenda/sincronizar-agenda.js');
    const cache = new CacheAgendaProcesso();
    const carregar = vi.fn(async () => ({ tipo: 'consultas' as const, fonte:'tribemd',consultas:[] }));
    await cache.consultar('a', 7, carregar); await cache.consultar('a', 3, carregar);
    expect(carregar).toHaveBeenCalledOnce();
    await cache.consultar('b', 3, carregar); expect(carregar).toHaveBeenCalledTimes(2);
    await cache.consultar('a', 10, carregar); expect(carregar).toHaveBeenCalledTimes(3);
    cache.invalidar('a'); await cache.consultar('a', 3, carregar); expect(carregar).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(600000);
    await cache.consultar('a', 3, carregar); expect(carregar).toHaveBeenCalledTimes(5);
    const novaInstancia = new CacheAgendaProcesso(); await novaInstancia.consultar('a',3,carregar); expect(carregar).toHaveBeenCalledTimes(6);
  } finally { vi.useRealTimers(); }
});
it('cache não guarda falha nem restaura uma leitura invalidada durante sua execução', async () => {
  const { CacheAgendaProcesso } = await import('../src/agenda/sincronizar-agenda.js'); const cache=new CacheAgendaProcesso();
  const erro=vi.fn(async()=>({tipo:'erro' as const,codigo:'FONTE_INDISPONIVEL' as const}));
  await cache.consultar('a',7,erro); await cache.consultar('a',7,erro); expect(erro).toHaveBeenCalledTimes(2);
  let concluir!: (r:any)=>void; const antiga=cache.consultar('a',7,()=>new Promise(r=>{concluir=r;}));
  await Promise.resolve(); cache.invalidar('a'); concluir({tipo:'consultas',fonte:'tribemd',consultas:[]}); await expect(antiga).rejects.toThrow('ACESSO_AGENDA_ALTERADO');
  const nova=vi.fn(async()=>({tipo:'consultas' as const,fonte:'tribemd',consultas:[]}));
  await cache.consultar('a',7,nova); expect(nova).toHaveBeenCalledOnce();
});
it('cache compartilha somente a mesma leitura concorrente por médico',async()=>{
 const {CacheAgendaProcesso}=await import('../src/agenda/sincronizar-agenda.js');const cache=new CacheAgendaProcesso();
 const carregar=vi.fn(async()=>({tipo:'consultas' as const,fonte:'tribemd',consultas:[]}));
 const resultados=await Promise.all(Array.from({length:12},()=>cache.consultar('a',7,carregar)));
 expect(carregar).toHaveBeenCalledOnce();expect(resultados).toHaveLength(12);
 cache.invalidar('a');
});
