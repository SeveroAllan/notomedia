import { config } from '../src/config.js';
import { auditarComprovante } from '../src/atendimento/comprovante.js';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { BancoHistoricoFalso } from './fakes/banco-historico.js';
import { PostgresHistoricoComunicacao } from '../src/io/postgres/postgres-historico-comunicacao.js';
import { PostgresAtendimentoRepositorio } from '../src/io/postgres/postgres-atendimento-repositorio.js';
import type { EstadoPedidoComprovante, ResultadoExtracaoComprovante } from '../src/atendimento/comprovante.js';

let rede: ReturnType<typeof vi.spyOn>;
beforeEach(() => { rede = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('REDE_PROIBIDA'); }); });
afterEach(() => { expect(rede).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
const medico = '00000000-0000-4000-8000-000000000001';
const estado: EstadoPedidoComprovante = { medicoId: medico, paciente: { nome: 'Paciente Ficticio', cpf: '52998224725' }, ultimaConsulta: { valorConsultaCentavos: 35000 } };
const lido: ResultadoExtracaoComprovante = { tipo: 'extraido', campos: { valorCentavos: 35000, dataPagamento: '2026-10-18', nomePagador: 'Paciente Ficticio', nomeFavorecido: 'Medica Ficticia',
  confianca: { valorCentavos: 0.90, dataPagamento: 0.90, nomePagador: 0.90, nomeFavorecido: 0.90 } } };

it('comprovantes, reservas e balões usam tabelas próprias e nunca public.auditoria', async () => {
  const banco = new BancoHistoricoFalso(); const h = new PostgresHistoricoComunicacao(banco as unknown as pg.Pool);
  const decisao = await h.registrarComprovante(estado, lido);
  expect(banco.comprovantes).toEqual([{ medico_id: medico, ...auditarComprovante(config.appPepper, estado, lido, decisao), motivo: decisao.motivo, confianca: lido.campos.confianca }]);
  const acao = { tipo: 'boas_vindas' as const, ultimaNota: null };
  await h.reservar(medico, 'real', 'envio'); await h.reservarEnvio(medico, 'envio', acao); await h.confirmarBalao(medico, 'envio', 0);
  expect(banco.reservas.get(JSON.stringify([medico, 'real']))).toEqual({ medico_id: medico, modo: 'real', chave_processamento: 'envio' });
  expect([...banco.envios.values()]).toEqual([{ medico_id: medico, modo: 'real', chave_processamento: 'envio', tipo: 'boas_vindas', baloes_enviados: [0] }]);
  expect((await h.ler(medico, 'real')).envios).toEqual([{ chaveProcessamento: 'envio', tipo: 'boas_vindas', baloesEnviados: [0] }]);
  expect(banco.consultas.some(sql => /\bpublic\.auditoria\b/.test(sql))).toBe(false);
});
it('erro ao gravar confirmação mantém o balão sem confirmação e a ação sem enviado', async () => {
  const banco = new BancoHistoricoFalso(); const h = new PostgresHistoricoComunicacao(banco as unknown as pg.Pool);
  await h.reservar(medico, 'real', 'envio'); await h.reservarEnvio(medico, 'envio', { tipo: 'boas_vindas', ultimaNota: null });
  banco.falhar = /^insert into public.noto_comunicacao_envios/;
  await expect(h.confirmarBalao(medico, 'envio', 0)).rejects.toThrow('BANCO_FALSO_FALHOU');
  banco.falhar = null; const salvo = await h.ler(medico, 'real');
  expect(salvo.envios[0].baloesEnviados).toEqual([]); expect(salvo.registros).toEqual([]); expect(salvo.boasVindasComunicadas).toBe(false);
});
it('migração nova cria só as tabelas faltantes com RLS, revokes e cascata por médico', () => {
  const sql = readFileSync('scripts/migrations/20261018-comprovantes-reservas-envios.sql', 'utf8').toLowerCase();
  const tabelas = ['noto_auditoria_comprovantes', 'noto_comunicacao_reservas', 'noto_comunicacao_envios'];
  expect([...sql.matchAll(/create table public\.(\w+)/g)].map(m => m[1])).toEqual(tabelas);
  for (const tabela of tabelas) {
    const definicao = sql.slice(sql.indexOf('create table public.' + tabela)).split(';')[0];
    expect(definicao).toMatch(/medico_id uuid not null references public\.medicos\(id\) on delete cascade/);
    expect(sql).toContain(`alter table public.${tabela} enable row level security`);
    expect(sql).toContain(`revoke all on table public.${tabela} from public`);
    expect(sql).toContain(`revoke all on table public.${tabela} from anon`);
    expect(sql).toContain(`revoke all on table public.${tabela} from authenticated`);
  }
  expect(sql).not.toMatch(/create policy/);
  expect(sql).toContain('motivo text generated always as'); expect(sql).toContain('confianca jsonb generated always as');
  expect(sql).toContain('references public.noto_comunicacao_tentativas');
  expect(sql).not.toMatch(/\bpublic\.auditoria\b/);
});
it('leitor de cadastro não lê tabela sincronizada nem inventa consulta', async () => {
  const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [] }));
  const h = new PostgresAtendimentoRepositorio({ query } as unknown as pg.Pool, 'chave-ficticia');
  expect(await h.lerEstado(medico, 'paciente-ficticio')).toEqual({ medicoId: medico, paciente: { nome: null, cpf: null }, ultimaConsulta: null });
  expect(query.mock.calls[0][0]).toMatch(/from pacientes p/);
  expect(query.mock.calls[0][0]).not.toMatch(/noto_consultas_sincronizadas/);
  expect(query.mock.calls[0][0]).not.toMatch(/from agendamentos/);
  expect(query.mock.calls[0][1]).toEqual([medico, 'paciente-ficticio', 'chave-ficticia']);
});
