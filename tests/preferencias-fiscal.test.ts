import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { salvarPreferenciasMedico } from '../src/conta/salvar-preferencias-medico.js';
import { confirmarParametrosFiscais } from '../src/onboarding/fluxos/confirmar-parametros-fiscais.js';
import { parametrosEmissaoSchema, type ParametrosEmissao, type PoliticaEmissao } from '../src/fiscal/preparacao/parametros-emissao.js';
import { gerarGrupoIbscbs } from '../src/fiscal/preparacao/ibscbs.js';
import { tributosNaoOptante } from '../src/fiscal/preparacao/tributos-nao-optante.js';
import { prepararEmissao, type EvidenciasEmissao } from '../src/fiscal/preparacao/preparar-emissao.js';
import { mapearParametrosFiscaisDoXml } from '../src/onboarding/regras/mapear-parametros-fiscais-do-xml.js';
import { mapearServicoFiscalDoXml } from '../src/onboarding/regras/mapear-servico-fiscal-do-xml.js';
import { gerarXmlDps } from '../src/io/fiscal/gerar-xml-dps.js';

const parametros: ParametrosEmissao = { ambiente: 'homologacao', vigenciaInicio: '2026-01-01', municipioPrestacao: '4205407',
  opcaoSimplesNacional: 'me_epp', regimeApuracaoSn: 'regime_1', regimeEspecialTributacao: 0, tribISSQN: 1, tpRetISSQN: 1,
  cstPisCofins: '08', percentualTotTribSN: 6 };
const ibscbs = { finNFSe: '0', indFinal: '0', cIndOp: '100301', indDest: '0', CST: '200', cClassTrib: '200001' } as const;
const perfil = { ambiente: 'homologacao', opcao: 'me_epp', regime: 'regime_1', especial: 0, municipio: '4205407', serie: '00001', referencia: 'referencia-ficticia' };
const politica: PoliticaEmissao = { parametros, confirmadoEm: '2026-10-17T12:00:00Z', origem: 'revisao_onboarding',
  ctribNac: '040101', cnbs: null, ctribMun: null, perfil };
const item = { id: 'solicitacao-1', medicoId: 'medico-1', pacienteId: 'paciente-1', xdescServ: 'Consulta médica', valorServicoCentavos: 35000, ctribNac: '040101' };

function evidencias(): EvidenciasEmissao {
  return { perfil: { ...perfil, confirmado: true }, competenciaInformada: '2020-01-01', datasConsultas: ['2026-10-13'],
    servicos: [{ id: 'servico-1', ctribNac: '040101', cnbs: null, ctribMun: null, politica: structuredClone(politica) }] };
}

function bancoFiscal() {
  const comandos: Array<{ sql: string; valores: unknown[] }> = [];
  let encontrado = true;
  let referencia: unknown = { versao: 1 };
  let liberado = false;
  const client = {
    async query(sql: string, valores: unknown[] = []) {
      comandos.push({ sql: sql.replace(/\s+/g, ' ').trim(), valores });
      if (sql.includes('select cod_municipio_ibge')) return { rows: [{ cod_municipio_ibge: '4205407', serie_dps: '00001', xml_nota_referencia_url: 'referencia-ficticia', dados_reforma_tributaria: referencia }], rowCount: 1 };
      if (sql.includes('select id, ctrib_nac')) return { rows: [{ id: 'servico-1', ctrib_nac: '040101', cnbs: null, ctrib_mun: null, parametros_emissao: null }], rowCount: 1 };
      if (sql.includes('returning id, solicitar_cpf')) return { rows: encontrado ? [{ id: 'medico-1', solicitar_cpf_direto_paciente: valores[0] }] : [], rowCount: encontrado ? 1 : 0 };
      if (/^(begin|commit|rollback)$/.test(sql) || /^\s*(update (medico_perfil_fiscal|medico_servicos_fiscais|medicos)|insert into auditoria)\b/.test(sql)) return { rows: [], rowCount: encontrado ? 1 : 0 };
      throw new Error('SQL inesperado no fake fiscal: ' + sql);
    },
    release() { liberado = true; }
  };
  return { pool: { query: client.query, connect: async () => client } as unknown as pg.Pool, comandos,
    ausente() { encontrado = false; }, referencia(valor: unknown) { referencia = valor; }, liberado: () => liberado };
}

describe('preferências persistidas na borda SQL', () => {
  it.each([true, false])('grava preferência CPF = %s para o médico indicado', async solicitarCpfDiretoPaciente => {
    const banco = bancoFiscal();
    expect(await salvarPreferenciasMedico(banco.pool, { medicoId: 'medico-1', solicitarCpfDiretoPaciente })).toEqual({ medicoId: 'medico-1', solicitarCpfDiretoPaciente });
    expect(banco.comandos).toEqual([{ sql: 'update medicos set solicitar_cpf_direto_paciente = $1, atualizado_em = now() where id = $2 returning id, solicitar_cpf_direto_paciente', valores: [solicitarCpfDiretoPaciente, 'medico-1'] }]);
  });
  it('não consulta sem médico e rejeita médico ausente no banco', async () => {
    const banco = bancoFiscal();
    await expect(salvarPreferenciasMedico(banco.pool, { medicoId: '', solicitarCpfDiretoPaciente: true })).rejects.toThrow('Médico não informado.');
    expect(banco.comandos).toEqual([]);
    banco.ausente();
    await expect(salvarPreferenciasMedico(banco.pool, { medicoId: 'medico-1', solicitarCpfDiretoPaciente: false })).rejects.toThrow('Médico medico-1 não encontrado.');
  });
});

describe('parâmetros fiscais e IBS/CBS reais', () => {
  it('aceita ME/EPP completo sem defaults implícitos', () => {
    expect(parametrosEmissaoSchema.parse(parametros)).toEqual(parametros);
  });
  it.each(['regimeApuracaoSn', 'cstPisCofins', 'percentualTotTribSN'])('exige %s para ME/EPP', campo => {
    expect(parametrosEmissaoSchema.safeParse({ ...parametros, [campo]: undefined }).success).toBe(false);
  });
  it('rejeita alíquota ISS no Simples comum; aceita fora do Simples e retenção declarada', () => {
    expect(parametrosEmissaoSchema.safeParse({ ...parametros, aliquotaIss: 2 }).success).toBe(false);
    expect(parametrosEmissaoSchema.parse({ ...parametros, regimeApuracaoSn: 'regime_2', aliquotaIss: 2 }).aliquotaIss).toBe(2);
    expect(parametrosEmissaoSchema.safeParse({ ...parametros, tpRetISSQN: 2 }).success).toBe(false);
    expect(parametrosEmissaoSchema.parse({ ...parametros, tpRetISSQN: 2, aliquotaIss: 2 }).tpRetISSQN).toBe(2);
    expect(parametrosEmissaoSchema.safeParse({ ...parametros, tpRetISSQN: 2, aliquotaIss: 2, regimeEspecialTributacao: 6 }).success).toBe(false);
  });
  it.each([-1, 10, NaN, Infinity])('rejeita alíquota ISS %s', aliquotaIss => {
    expect(parametrosEmissaoSchema.safeParse({ ...parametros, regimeApuracaoSn: 'regime_2', aliquotaIss }).success).toBe(false);
  });
  it('valida vigência, município e rejeita campos fiscais desconhecidos', () => {
    expect(parametrosEmissaoSchema.safeParse({ ...parametros, vigenciaInicio: '2026-02-30' }).success).toBe(false);
    expect(parametrosEmissaoSchema.safeParse({ ...parametros, vigenciaFim: '2025-12-31' }).success).toBe(false);
    expect(parametrosEmissaoSchema.safeParse({ ...parametros, municipioPrestacao: '420' }).success).toBe(false);
    expect(parametrosEmissaoSchema.safeParse({ ...parametros, aliquotaCbs: 99 }).success).toBe(false);
  });
  it('serializa exatamente o grupo IBS/CBS confirmado', () => {
    expect(gerarGrupoIbscbs(ibscbs)).toBe('<IBSCBS><indFinal>0</indFinal><cIndOp>100301</cIndOp><indDest>0</indDest><valores><trib><CST>200</CST><cClassTrib>200001</cClassTrib></trib></valores></IBSCBS>');
    expect(() => gerarGrupoIbscbs({ ...ibscbs, indDest: '1' } as any)).toThrow();
  });
  it('XML aplica IBS/CBS e consumidor final para CPF, sem alterar o objeto de parâmetros', () => {
    const resultado = gerarXmlDps({ nDPS: '42', tomador: { CPF: '52998224725', xNome: 'Ana Oliveira' }, xDescServ: 'Consulta', vServ: 350,
      cTribNac: '040101', cNBS: '122051000', cIndOp: '100301', cClassTrib: '200001', fiscal: { ...parametros, ibscbs, competencia: '2026-10-17' } },
    { cnpj: '12345678000195', im: '', codMunicipio: '4205407', ambiente: 2, pTotTribSN: 6, regTrib: { opSimpNac: 3, regApTribSN: 1, regEspTrib: 0 } }, new Date('2026-10-17T12:00:00Z'));
    expect(resultado.xml).toContain(gerarGrupoIbscbs({ ...ibscbs, indFinal: '1' }));
    expect(ibscbs.indFinal).toBe('0');
  });
  it('não optante calcula PIS/COFINS sobre a nova consulta e força não retenção para CPF', () => {
    const naoOptante: ParametrosEmissao = { ambiente: 'homologacao', vigenciaInicio: '2026-01-01', municipioPrestacao: '4205407', opcaoSimplesNacional: 'nao_optante', regimeEspecialTributacao: 0,
      tribISSQN: 1, tpRetISSQN: 2, aliquotaIss: 2, cstPisCofins: '01', totalTributos: { tipo: 'percentual', federal: 10, estadual: 0, municipal: 2 },
      pisCofinsCalculo: { base: 'valor_servico', aliquotaPis: 0.65, aliquotaCofins: 3, tipoRetencao: 0 } };
    expect(tributosNaoOptante(naoOptante, 350.25, true)).toEqual({ tribMun: { tribISSQN: 1, tpRetISSQN: 1, pAliq: '2.00' },
      tribFed: { piscofins: { CST: '01', vBCPisCofins: '350.25', pAliqPis: '0.65', pAliqCofins: '3.00', vPis: '2.28', vCofins: '10.51', tpRetPisCofins: 0 } },
      totTrib: { pTotTrib: { pTotTribFed: '10.00', pTotTribEst: '0.00', pTotTribMun: '2.00' } } });
    expect(() => tributosNaoOptante(naoOptante, 0)).toThrow('Regime ou valor inválido');
  });
});

describe('preparação determinística antes de transmitir', () => {
  it('usa competência do dia de emissão, preservando consultas antigas só na descrição', () => {
    expect(prepararEmissao(item, evidencias(), '2026-10-17')).toMatchObject({ ok: true, competencia: '2026-10-17', parametros,
      origem: { competencia: 'data_emissao', classificacao: 'servico_revisado' } });
  });
  it.each([0, -1, 0.5, Infinity])('bloqueia valor em centavos %s', valorServicoCentavos => {
    expect(prepararEmissao({ ...item, valorServicoCentavos }, evidencias(), '2026-10-17')).toMatchObject({ ok: false, pendencias: expect.arrayContaining([{ campo: 'valor', codigo: 'VALOR_INVALIDO', mensagem: 'Informar o valor positivo do serviço em centavos.' }]) });
  });
  it('bloqueia perfil não confirmado, serviço ambíguo e perfil alterado', () => {
    const dados = evidencias(); dados.perfil.confirmado = false; dados.perfil.serie = '00002';
    const resultado = prepararEmissao(item, dados, '2026-10-17');
    expect(resultado).toMatchObject({ ok: false, pendencias: expect.arrayContaining([expect.objectContaining({ codigo: 'PERFIL_NAO_CONFIRMADO' }), expect.objectContaining({ campo: 'perfil.serie', codigo: 'PERFIL_ALTERADO' })]) });
    dados.servicos.push(dados.servicos[0]);
    expect(prepararEmissao(item, dados, '2026-10-17')).toMatchObject({ ok: false, pendencias: expect.arrayContaining([expect.objectContaining({ codigo: 'SERVICO_AMBIGUO' })]) });
  });
  it('não permite omitir ou trocar IBS/CBS da referência confirmada', () => {
    const dados = evidencias(); dados.perfil.referenciaFiscal = { versao: 2, hash: 'hash-ficticio', ibscbsPresente: true, parametrosSugeridos: { ibscbs } };
    dados.servicos[0].politica!.referenciaHash = 'hash-ficticio';
    expect(prepararEmissao(item, dados, '2026-10-17')).toMatchObject({ ok: false, pendencias: expect.arrayContaining([expect.objectContaining({ codigo: 'REFERENCIA_PENDENTE' })]) });
    dados.servicos[0].politica!.parametros.ibscbs = ibscbs;
    expect(prepararEmissao(item, dados, '2026-10-17').ok).toBe(true);
    dados.servicos[0].politica!.parametros.ibscbs = { ...ibscbs, CST: '000' };
    expect(prepararEmissao(item, dados, '2026-10-17').ok).toBe(false);
  });
});

describe('confirmação fiscal na fronteira SQL', () => {
  it('confirma a política e grava auditoria na mesma transação', async () => {
    const banco = bancoFiscal();
    await confirmarParametrosFiscais(banco.pool, { medicoId: 'medico-1', parametrosEmissao: parametros });
    expect(banco.comandos[0].sql).toBe('begin'); expect(banco.comandos.at(-1)!.sql).toBe('commit'); expect(banco.liberado()).toBe(true);
    expect(banco.comandos[1]).toEqual({ sql: 'select cod_municipio_ibge, serie_dps, xml_nota_referencia_url, dados_reforma_tributaria from medico_perfil_fiscal where medico_id = $1 for update', valores: ['medico-1'] });
    expect(banco.comandos[2]).toEqual({ sql: 'select id, ctrib_nac, cnbs, ctrib_mun, parametros_emissao from medico_servicos_fiscais where medico_id = $1 and padrao and ativo for update', valores: ['medico-1'] });
    expect(banco.comandos[3]).toEqual({ sql: 'update medico_perfil_fiscal set confirmado_pelo_medico = true, ambiente = $8, serie_dps = $2, proximo_numero_dps = coalesce($3, proximo_numero_dps), opcao_simples_nacional = $4, regime_apuracao_sn = $5, regime_especial_tributacao = $6, percentual_tot_trib_sn = coalesce($7, percentual_tot_trib_sn), atualizado_em = now() where medico_id = $1',
      valores: ['medico-1', '00001', undefined, 'me_epp', 'regime_1', 0, 6, 'homologacao'] });
    const gravado = banco.comandos.find(c => c.sql.startsWith('update medico_servicos_fiscais set parametros_emissao'))!;
    const dados = JSON.parse(String(gravado.valores[2]));
    expect(gravado.sql).toBe('update medico_servicos_fiscais set parametros_emissao = $3 where id = $1 and medico_id = $2');
    expect(gravado.valores).toEqual(['servico-1', 'medico-1', JSON.stringify(dados)]);
    expect(dados).toMatchObject({ parametros, origem: 'revisao_onboarding', perfil, ctribNac: '040101', cnbs: null, ctribMun: null });
    expect(Number.isFinite(Date.parse(dados.confirmadoEm))).toBe(true);
    expect(banco.comandos.find(c => c.sql.startsWith('insert into auditoria'))!.valores).toEqual(['servico-1', null, JSON.stringify(dados)]);
  });
  it('referência trocada interrompe confirmação e solicita rollback', async () => {
    const banco = bancoFiscal(); banco.referencia({ versao: 2, hash: 'novo-hash' });
    await expect(confirmarParametrosFiscais(banco.pool, { medicoId: 'medico-1', usarReferencia: true, referenciaHash: 'antigo-hash' })).rejects.toMatchObject({ codigo: 'REFERENCIA_ALTERADA' });
    expect(banco.comandos.at(-1)!.sql).toBe('rollback'); expect(banco.liberado()).toBe(true);
    expect(banco.comandos.some(c => c.sql.startsWith('update'))).toBe(false);
  });
  it('caminho legado persiste alíquota negativa sem validação (achado)', async () => {
    const banco = bancoFiscal();
    await confirmarParametrosFiscais(banco.pool, { medicoId: 'medico-1', aliquotaIss: -2 });
    expect(banco.comandos.find(c => c.sql.startsWith('update medico_servicos_fiscais'))!.valores).toEqual(['medico-1', -2]);
  });
});

describe('dados fiscais extraídos de referência fictícia', () => {
  const xml = { NFSe: { infNFSe: { emit: { CNPJ: '12.345.678/0001-95', xNome: 'Clínica Fictícia', IM: '12345' }, DPS: { infDPS: {
    tpAmb: '2', serie: '00007', nDPS: '42', cLocEmi: '4205407', prest: { regTrib: { opSimpNac: '3', regApTribSN: '1', regEspTrib: '0' } },
    serv: { locPrest: { cLocPrestacao: '4205407' }, cServ: { cTribNac: '40101', cTribMun: '1', cNBS: '122051000', xDescServ: 'Consulta médica' } },
    valores: { vServPrest: { vServ: '350.25' }, trib: { tribMun: { tribISSQN: '1', tpRetISSQN: '1', pAliq: '2.00' }, tribFed: { piscofins: { CST: '08' } }, totTrib: { pTotTribSN: '6.00' } } },
    IBSCBS: { finNFSe: '0', indFinal: '1', cIndOp: '100301', indDest: '0', valores: { trib: { gIBSCBS: { CST: '200', cClassTrib: '200001' } } } }
  } } } } };
  it('extrai identidade, município, regime, sequência e IBS/CBS da referência', () => {
    expect(mapearParametrosFiscaisDoXml(xml)).toMatchObject({ cnpj: '12345678000195', razaoSocial: 'Clínica Fictícia', inscricaoMunicipal: '12345', codMunicipioIbge: '4205407', uf: 'SC', serieDps: '00007',
      opcaoSimplesNacional: 'me_epp', regimeApuracaoSn: 'regime_1', regimeEspecialTributacao: 0, ambiente: 'homologacao', proximoNumeroSequencialSugerido: 43,
      cclassTribPadrao: '200001', cindOpPadrao: '100301' });
    expect(mapearServicoFiscalDoXml(xml)).toMatchObject({ ctribNac: '040101', ctribMun: '001', cnbs: '122051000', aliquotaIss: 2, valorPadraoCentavos: 35025 });
  });
  it('rejeita referência sem documento do prestador ou opção Simples', () => {
    expect(() => mapearParametrosFiscaisDoXml({})).toThrow('XML não contém CNPJ/CPF');
    const dados = structuredClone(xml); delete (dados.NFSe.infNFSe.DPS.infDPS.prest.regTrib as any).opSimpNac;
    expect(() => mapearParametrosFiscaisDoXml(dados)).toThrow('O XML não contém a opção do Simples Nacional');
  });
});
