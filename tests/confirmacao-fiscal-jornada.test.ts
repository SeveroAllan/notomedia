import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { readFileSync } from 'node:fs';
import { criarAppExpress } from '../src/server.js';
import { config } from '../src/config.js';
import { consultarStatusOnboarding } from '../src/onboarding/io/consultar-status-onboarding.js';

const borda = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock('../src/io/postgres/pool.js', () => ({ pool: borda }));
vi.mock('../src/cofre/router.js', async () => {
  const express = await import('express');
  return { criarCofreContas: () => ({ app: express.default(), statusAgenda: async () => ({ nome: null, conectada: false }), encerrar: async () => {} }) };
});

const parametros = { ambiente: 'homologacao', vigenciaInicio: '2026-01-01', municipioPrestacao: '4205407',
  opcaoSimplesNacional: 'me_epp', regimeApuracaoSn: 'regime_1', regimeEspecialTributacao: 0, tribISSQN: 1,
  tpRetISSQN: 1, cstPisCofins: '08', percentualTotTribSN: 6 };
const referencia = { versao: 2, hash: 'a'.repeat(64), pendencias: [] as string[], ibscbsPresente: false,
  servico: { ctribNac: '040101', ctribMun: null, cnbs: null }, parametrosSugeridos: parametros };

// Só a borda SQL é falsa: rota, confirmação e validador fiscal executam de verdade.
function bancoFiscal() {
  const estado = { referencia: structuredClone(referencia), politica: null as any, confirmado: false };
  const comandos: string[] = [];
  const query = async (sql: string, valores: any[] = []) => {
    const texto = sql.replace(/\s+/g, ' ').trim(); comandos.push(texto);
    if (['begin', 'commit', 'rollback'].includes(texto)) return { rows: [], rowCount: 0 };
    if (texto === 'select id from medicos where id = $1 limit 1') return { rows: [{ id: 'medico-1' }] };
    if (texto.startsWith('select cod_municipio_ibge')) return { rows: [{ cod_municipio_ibge: '4205407', serie_dps: '00007', xml_nota_referencia_url: 'xml-ficticio', dados_reforma_tributaria: estado.referencia }] };
    if (texto.startsWith('select id, ctrib_nac')) return { rows: [{ id: 'servico-1', ctrib_nac: '040101', ctrib_mun: null, cnbs: null, parametros_emissao: estado.politica }] };
    if (texto.startsWith('update medico_perfil_fiscal set confirmado_pelo_medico')) { estado.confirmado = true; return { rows: [], rowCount: 1 }; }
    if (texto.startsWith('update medico_servicos_fiscais set parametros_emissao')) { estado.politica = JSON.parse(valores[2]); return { rows: [], rowCount: 1 }; }
    if (texto.startsWith('insert into auditoria')) return { rows: [], rowCount: 1 };
    if (texto.includes('as cert_ativos')) return { rows: [{ medico_id: 'medico-1', medico_nome: 'Medica Ficticia',
      crm: '12345/SC', rqe: null, confirmado_pelo_medico: estado.confirmado, dados_reforma_tributaria: estado.referencia,
      parametros_emissao: estado.politica, extraido_automaticamente: true, cert_ativos: '1', whats_conectados: '1',
      revisao_profissional: { estado: 'concluido', dados: { aprovacaoPainel: { nome: 'Medica Ficticia', crm: '12345/SC', rqe: null, confirmadoEm: '2026-10-18T12:00:00Z' } } } }] };
    throw Error('SQL não previsto no teste fiscal: ' + texto);
  };
  return { estado, comandos, pool: { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool };
}
let banco: ReturnType<typeof bancoFiscal>;
const anterior = config.preparacaoFiscalAtiva;
beforeEach(() => {
  banco = bancoFiscal(); config.preparacaoFiscalAtiva = false;
  borda.query.mockImplementation(banco.pool.query.bind(banco.pool));
  borda.connect.mockImplementation(banco.pool.connect.bind(banco.pool));
});
afterEach(() => { config.preparacaoFiscalAtiva = anterior; vi.restoreAllMocks(); });
async function confirmar(body: Record<string, unknown>) {
  const app = criarAppExpress();
  const handler = (app as any).router.stack.find((c: any) => c.route?.path === '/api/onboarding/confirmar-fiscal').route.stack[0].handle;
  let status = 200, data: any;
  const res = { status(n: number) { status = n; return res; }, json(c: unknown) { data = c; return res; } };
  await handler({ body: { medicoId: 'medico-1', ...body } }, res);
  return { status, data };
}

describe('confirmação explícita sem ativar emissão automática', () => {
  it('confirma a referência atual pelas regras reais com a flag padrão desligada', async () => {
    expect(await confirmar({ usarReferencia: true, referenciaHash: referencia.hash })).toMatchObject({ status: 200, data: { ok: true } });
    expect(banco.estado.politica).toMatchObject({ parametros, referenciaHash: referencia.hash, fidelidadeReferencia: true });
    expect(banco.comandos.at(-1)).toBe('commit');
    expect((await consultarStatusOnboarding(banco.pool, 'medico-1')).passos.passo2FiscalConfirmado).toBe(true);
    expect(config.preparacaoFiscalAtiva).toBe(false);
  });
  it('permite editar sem pular o schema nem a correspondência da referência', async () => {
    const editados = { ...parametros, percentualTotTribSN: 7 };
    expect(await confirmar({ parametrosEmissao: editados, referenciaHash: referencia.hash })).toMatchObject({ status: 200, data: { ok: true } });
    expect(banco.estado.politica).toMatchObject({ parametros: editados, fidelidadeReferencia: false });
    expect((await consultarStatusOnboarding(banco.pool, 'medico-1')).passos.passo2FiscalConfirmado).toBe(true);
  });
  it('continua recusando hash desatualizado e não grava confirmação', async () => {
    expect(await confirmar({ usarReferencia: true, referenciaHash: 'b'.repeat(64) })).toMatchObject({ status: 400, data: { ok: false, codigo: 'REFERENCIA_ALTERADA' } });
    expect(banco.estado.confirmado).toBe(false); expect(banco.estado.politica).toBeNull();
    expect(banco.comandos.at(-1)).toBe('rollback');
  });
  it('continua recusando pendência fiscal da nota em vez de liberar pela flag', async () => {
    banco.estado.referencia.pendencias = ['tribFed: tratamento ainda não suportado.'];
    expect(await confirmar({ usarReferencia: true, referenciaHash: referencia.hash })).toMatchObject({ status: 400, data: { ok: false, codigo: 'REFERENCIA_FISCAL_PENDENTE' } });
    expect(banco.estado.confirmado).toBe(false);
  });
  it('continua recusando edição com regra fiscal inválida', async () => {
    expect(await confirmar({ parametrosEmissao: { ...parametros, percentualTotTribSN: -1 }, referenciaHash: referencia.hash })).toMatchObject({ status: 400, data: { ok: false } });
    expect(banco.estado.confirmado).toBe(false); expect(banco.estado.politica).toBeNull();
  });
});

describe('status da referência nova com flags padrão', () => {
  it.each([false, true])('aceita política válida revisada sem depender da flag = %s', async flag => {
    banco.estado.confirmado = true;
    banco.estado.politica = { parametros, referenciaHash: referencia.hash, confirmadoEm: '2026-10-18T12:00:00Z' };
    const status = await consultarStatusOnboarding(banco.pool, 'medico-1', flag);
    expect(status.passos.passo2FiscalConfirmado).toBe(true); expect(status.liberadoParaEmitir).toBe(true);
  });
  it.each(['sem_politica', 'sem_confirmacao', 'hash_trocado', 'pendencia', 'parametros_invalidos'])('bloqueia referência sem prova: %s', async caso => {
    banco.estado.confirmado = true;
    banco.estado.politica = { parametros: structuredClone(parametros), referenciaHash: referencia.hash, confirmadoEm: '2026-10-18T12:00:00Z' };
    if (caso === 'sem_politica') banco.estado.politica = null;
    if (caso === 'sem_confirmacao') delete banco.estado.politica.confirmadoEm;
    if (caso === 'hash_trocado') banco.estado.politica.referenciaHash = 'outro';
    if (caso === 'pendencia') banco.estado.referencia.pendencias = ['IBSCBS pendente'];
    if (caso === 'parametros_invalidos') banco.estado.politica.parametros.percentualTotTribSN = -1;
    expect((await consultarStatusOnboarding(banco.pool, 'medico-1')).passos.passo2FiscalConfirmado).toBe(false);
  });
});

it('migração adiciona só as quatro colunas com IF NOT EXISTS sem modificar SQL antigo', () => {
  const sql = readFileSync(new URL('../scripts/migrations/20261018-onboarding-colunas-fiscais.sql', import.meta.url), 'utf8');
  const comandos = sql.replace(/--[^\n]*/g, '').split(';').map(c => c.trim()).filter(Boolean);
  expect(comandos[0].toLowerCase()).toBe('begin'); expect(comandos.at(-1)?.toLowerCase()).toBe('commit');
  expect(comandos.slice(1, -1).map(c => c.replace(/\s+/g, ' ').toLowerCase())).toEqual([
    'alter table medico_perfil_fiscal add column if not exists proximo_numero_dps bigint',
    'alter table medico_perfil_fiscal add column if not exists cnae text',
    'alter table medico_servicos_fiscais add column if not exists aliquota_iss numeric',
    'alter table medico_servicos_fiscais add column if not exists ctrib_mun text',
  ]);
});

describe('série do aplicativo próprio', () => {
  it.each(['50000','69999','70000','79999','80000','99999'])('recusa série %s reservada para outro emissor', async serieDps => {
    const resposta = await confirmar({ parametrosEmissao:parametros, referenciaHash:referencia.hash, serieDps });
    expect(resposta.status).toBe(400);
    expect(banco.estado.confirmado).toBe(false);
    expect(banco.estado.politica).toBe(null);
    expect(banco.comandos.at(-1)).toBe('rollback');
  });
  it.each(['0','00001','49999'])('aceita série API %s', async serieDps => {
    expect(await confirmar({ parametrosEmissao:parametros, referenciaHash:referencia.hash, serieDps })).toMatchObject({status:200,data:{ok:true}});
  });
});
