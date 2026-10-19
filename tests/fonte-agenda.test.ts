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
