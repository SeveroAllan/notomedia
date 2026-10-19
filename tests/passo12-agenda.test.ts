import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { selecionarConsultaComprovante } from '../src/agenda/fonte-agenda.js';
import { orquestrarComprovante } from '../src/fluxos/processar-comprovante.js';
import { HistoricoComunicacaoEmMemoria } from '../src/onboarding/historico-comunicacao-repositorio.js';
import { PostgresAtendimentoRepositorio } from '../src/io/postgres/postgres-atendimento-repositorio.js';

const consulta = { pacienteId: 'paciente-agenda', telefonePaciente: '+55 (11) 99999-0000', idExterno: 'c1', dataHora: '2026-10-18T10:00:00Z', status: 'realizada' as const, valorConsultaCentavos: 20000 };
describe('agenda transitória para comprovante', () => {
  it.each(['5511999990000', '11999990000', '1199990000'])('vincula pelo telefone %s, sem usar nome ou UUID local', telefone => {
    expect(selecionarConsultaComprovante([consulta], telefone)).toEqual({ tipo: 'consulta', consulta });
  });
  it('considera só realizadas, escolhe a última e permite excluir as já faturadas', () => {
    const anterior = { ...consulta, idExterno: 'c0', dataHora: '2026-10-17T10:00:00Z' };
    expect(selecionarConsultaComprovante([anterior, { ...consulta, status: 'cancelada' }], '11999990000')).toEqual({ tipo: 'consulta', consulta: anterior });
  });
  it.each([
    [],
    [{ ...consulta, telefonePaciente: '11988880000' }],
    [consulta, { ...consulta, pacienteId: 'outro', idExterno: 'c2' }],
    [consulta, { ...consulta, idExterno: 'c2' }],
    [{ ...consulta, dataHora: 'inválida' }]
  ].map(consultas => [consultas]))('não inventa vínculo ou desempate: %j', consultas => {
    expect(selecionarConsultaComprovante(consultas, '11999990000').tipo).toBe('perguntar_medico');
  });
  it('leitor Postgres lê apenas o cadastro, sem tabela de consultas', async () => {
    const query = vi.fn(async () => ({ rows: [{ nome: 'Ana Ficticia', cpf: '52998224725' }] }));
    expect((await new PostgresAtendimentoRepositorio({ query } as unknown as pg.Pool, 'chave-falsa').lerEstado('m', 'p')).ultimaConsulta).toBeNull();
    expect(query.mock.calls[0]).toBeDefined();
    expect(JSON.stringify(query.mock.calls)).not.toContain('noto_consultas_sincronizadas');
  });
  it.each([false, true])('extrai antes da agenda e usa telefone alternativo quando JID é LID=%s', async lid => {
    const ordem: string[] = [];
    const aoDecidir = vi.fn(async () => {});
    const historico = new HistoricoComunicacaoEmMemoria();
    const decisao = await orquestrarComprovante({ medicoId: 'm', pacienteId: 'uuid-local', mensagem: { key: { id: 'msg', remoteJid: lid ? '123456789@lid' : '5511999990000@s.whatsapp.net', remoteJidAlt: lid ? '5511999990000@s.whatsapp.net' : undefined, fromMe: false }, message: { imageMessage: {} } } }, {
      lerEstado: async () => ({ medicoId: 'm', paciente: { nome: 'Ana Ficticia', cpf: '52998224725' }, ultimaConsulta: null }),
      fonteAgenda: { consultar: async () => { ordem.push('agenda'); return { tipo: 'consultas', fonte: 'falsa', consultas: [consulta] }; } },
      extrator: { extrair: async () => { ordem.push('extrator'); return { tipo: 'extraido', campos: { valorCentavos: 20000, dataPagamento: '2026-10-19', nomePagador: 'Ana Ficticia', nomeFavorecido: 'Medica Ficticia', confianca: { valorCentavos: .9, dataPagamento: .9, nomePagador: .9, nomeFavorecido: .9 } } }; } },
      historico, aoDecidir, log: vi.fn()
    });
    expect(ordem).toEqual(['extrator', 'agenda']);
    expect(decisao.tipo).toBe('pedido_nota_pronto');
    expect(aoDecidir.mock.calls).toHaveLength(1);
  });
});

it('porta da agenda no servidor é explícita e não chama sincronizarAgenda', async () => {
  const { readFileSync } = await import('node:fs');
  const servidor = readFileSync('src/server.ts', 'utf8');
  expect(servidor).toContain('fonteAgenda:');
  expect(servidor).not.toContain('sincronizarAgenda(');
  expect(readFileSync('src/io/postgres/postgres-emissao-comprovante.ts', 'utf8')).not.toContain('noto_consultas_sincronizadas');
});

it('consulta já faturada sai da candidatura sem esconder telefone compartilhado', () => {
  const empatada = { ...consulta, idExterno: 'c2' };
  expect(selecionarConsultaComprovante([consulta, empatada], '11999990000', new Set(['c1']))).toEqual({ tipo: 'consulta', consulta: empatada });
  expect(selecionarConsultaComprovante([consulta, { ...empatada, pacienteId: 'outro' }], '11999990000', new Set(['c1'])).tipo).toBe('perguntar_medico');
});

it.each(['FONTE_INDISPONIVEL', 'ACESSO_EXPIRADO', 'SEM_AGENDA_CONECTADA'] as const)('erro sob demanda %s é auditado pela decisão existente', async codigo => {
  const h = new HistoricoComunicacaoEmMemoria();
  const decisao = await orquestrarComprovante({ medicoId: 'm', pacienteId: 'p', mensagem: { key: { id: 'msg', remoteJid: '5511999990000@s.whatsapp.net', fromMe: false }, message: { imageMessage: {} } } }, {
    lerEstado: async () => ({ medicoId: 'm', paciente: { nome: null, cpf: null }, ultimaConsulta: null }),
    fonteAgenda: { consultar: async () => ({ tipo: 'erro', codigo }) },
    extrator: { extrair: async () => ({ tipo: 'ilegivel' }) }, historico: h, log: vi.fn()
  });
  expect(decisao).toMatchObject({ tipo: codigo === 'SEM_AGENDA_CONECTADA' ? 'pedir_agenda' : 'perguntar_medico', motivo: codigo });
  expect((await h.lerComprovantes('m'))[0].decisao).toMatchObject(decisao);
});

it('com dataPagamento: sem consulta anterior pergunta, uma anterior vira candidata, duas ou mais perguntam qual', () => {
  const base = { pacienteId: 'p1', telefonePaciente: '11999990000', idExterno: 'c1', dataHora: '2026-10-10T14:00:00-03:00', status: 'realizada' as const, valorConsultaCentavos: 20000 };
  const antiga = { ...base, idExterno: 'c2', dataHora: '2026-10-05T14:00:00-03:00' };
  const posterior = { ...base, idExterno: 'c3', dataHora: '2026-10-20T14:00:00-03:00' };
  expect(selecionarConsultaComprovante([base], '11999990000', new Set(), '2026-10-19')).toEqual({ tipo: 'consulta', consulta: base });
  expect(selecionarConsultaComprovante([base, antiga], '11999990000', new Set(), '2026-10-19')).toEqual({
    tipo: 'perguntar_medico', motivo: 'MULTIPLAS_CONSULTAS_SEM_NOTA',
    consultas: [{ dataHora: base.dataHora }, { dataHora: antiga.dataHora }] });
  expect(selecionarConsultaComprovante([posterior], '11999990000', new Set(), '2026-10-19')).toEqual({
    tipo: 'perguntar_medico', motivo: 'CONSULTA_APOS_PAGAMENTO' });
  expect(selecionarConsultaComprovante([base, antiga], '11999990000', new Set(['c2']), '2026-10-19')).toEqual({ tipo: 'consulta', consulta: base });
  expect(selecionarConsultaComprovante([base, antiga], '11999990000', new Set(), undefined).tipo).toBe('consulta');
});
