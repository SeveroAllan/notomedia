import { prepararEmissao } from '../src/fiscal/preparacao/preparar-emissao.js';
import { SefinNacionalClient } from '../src/io/fiscal/sefin-nacional-client.js';
import { gerarXmlDps } from '../src/io/fiscal/gerar-xml-dps.js';
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
  const estado = { referencia: structuredClone(referencia), politica: null as any, confirmado: false, ambiente:'homologacao' };
  const comandos: string[] = [];
  const query = async (sql: string, valores: any[] = []) => {
    const texto = sql.replace(/\s+/g, ' ').trim(); comandos.push(texto);
    if (['begin', 'commit', 'rollback'].includes(texto)) return { rows: [], rowCount: 0 };
    if (texto === 'select id from medicos where id = $1 limit 1') return { rows: [{ id: 'medico-1' }] };
    if (texto.startsWith('select id from medicos where id=$1 and conta_id=$2')) return {rows:valores[1]==='conta-teste'?[{id:'medico-1'}]:[]};
    if (texto.startsWith('select cod_municipio_ibge')) return { rows: [{ cod_municipio_ibge: '4205407', serie_dps: '00007', xml_nota_referencia_url: 'xml-ficticio', dados_reforma_tributaria: estado.referencia }] };
    if (texto.startsWith('select id, ctrib_nac')) return { rows: [{ id: 'servico-1', ctrib_nac: '040101', ctrib_mun: null, cnbs: null, parametros_emissao: estado.politica }] };
    if (texto.startsWith('update medico_perfil_fiscal set confirmado_pelo_medico')) { estado.confirmado = true; estado.ambiente=valores[7]; return { rows: [], rowCount: 1 }; }
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
const ambienteAnterior=config.ambienteEmissaoWhatsApp;
beforeEach(() => {
  banco = bancoFiscal(); config.preparacaoFiscalAtiva = false;
  borda.query.mockImplementation(banco.pool.query.bind(banco.pool));
  borda.connect.mockImplementation(banco.pool.connect.bind(banco.pool));
});
afterEach(() => { config.preparacaoFiscalAtiva = anterior; config.ambienteEmissaoWhatsApp=ambienteAnterior; vi.restoreAllMocks(); });
async function confirmar(body: Record<string, unknown>) {
  const app = criarAppExpress();
  const handler = (app as any).router.stack.find((c: any) => c.route?.path === '/api/onboarding/confirmar-fiscal').route.stack[0].handle;
  let status = 200, data: any;
  // Unidade de regra fiscal: simula aqui apenas o vínculo JÁ validado;
  // tests/onboarding-rotas-authz.test.ts cobre a proteção HTTP real.
  const res = {
    locals: { medicoAutorizado: { medicoId: 'medico-1', usuarioId: 'usuario-1', medicoUsuarioId: 'usuario-1' } },
    status(n: number) { status = n; return res; }, json(c: unknown) { data = c; return res; }
  };
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
  it.each([false,true])('referência de produção preservada com configuração de piloto=%s',async piloto=>{
    banco.estado.referencia.parametrosSugeridos.ambiente='producao';
    const original=structuredClone(banco.estado.referencia);
    config.ambienteEmissaoWhatsApp=piloto
      ? {contaId:'conta-teste',medicoId:'medico-1',agendamentoId:'atendimento-teste',ambiente:'homologacao'} : undefined;
    expect(await confirmar({usarReferencia:true,referenciaHash:referencia.hash})).toMatchObject({status:200,data:{ok:true}});
    expect(banco.estado.referencia).toEqual(original);
    expect(banco.estado.politica.parametros.ambiente).toBe('producao');
    expect(banco.estado.ambiente).toBe(piloto?'homologacao':'producao');
    const item={id:'solicitacao-teste',medicoId:'medico-1',pacienteId:'tomador-teste',ctribNac:'040101',
      xdescServ:'Atendimento sintético',valorServicoCentavos:10000};
    const evidencias={perfil:{...banco.estado.politica.perfil,confirmado:banco.estado.confirmado,referenciaFiscal:original},
      servicos:[{id:'servico-1',ctribNac:'040101',cnbs:null,ctribMun:null,politica:banco.estado.politica}],
      competenciaInformada:null,datasConsultas:[]};
    const hoje=new Date().toLocaleDateString('sv-SE',{timeZone:'America/Sao_Paulo'});
    const pronta=prepararEmissao(item,evidencias,hoje,config.ambienteEmissaoWhatsApp?.ambiente);
    expect(pronta).toMatchObject({ok:true,parametros:{ambiente:piloto?'homologacao':'producao'}});
    if (!piloto || !pronta.ok) return;
    expect(prepararEmissao(item,evidencias,hoje)).toMatchObject({ok:false});
    const ambiente=banco.estado.ambiente==='homologacao'?2:1;
    const {xml}=gerarXmlDps({nDPS:'1',tomador:{CPF:'52998224725',xNome:'Tomador Sintético'},
      xDescServ:item.xdescServ,vServ:100,cTribNac:'040101',cNBS:'',cIndOp:'',cClassTrib:'',
      fiscal:{...pronta.parametros,competencia:pronta.competencia}},
      {cnpj:'12345678000195',codMunicipio:'4205407',ambiente,serie:'00007',im:'12345',pTotTribSN:6,
        regTrib:{opSimpNac:3,regApTribSN:1,regEspTrib:0}});
    expect(xml).toContain('<tpAmb>2</tpAmb>');
    const transporte=vi.fn(async(_url:string)=>({status:400,corpo:'{}'}));
    await new SefinNacionalClient(transporte).transmitirDps({
      ambiente,xmlAssinado:xml,pfxBuffer:Buffer.alloc(0),senhaCertificado:''
    });
    expect(transporte).toHaveBeenCalledOnce();
    expect(transporte.mock.calls[0]?.[0]).toBe('https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse');
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
