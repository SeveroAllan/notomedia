import { describe, expect, it } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import { validarPayloadEmissao } from '../src/api/nfse/validar-payload-emissao.js';
import { processarSolicitacaoEmissaoApi } from '../src/api/nfse/processar-solicitacao-emissao-api.js';
import type { EmissaoApiRepositorio, CriarSolicitacaoEmissaoParams, SolicitacaoRefRegistro } from '../src/api/nfse/emissao-api-repositorio.js';
import { montarDps, type ConfigPrestador, type EmissaoInput } from '../src/io/fiscal/montar-dps.js';
import { gerarXmlDps } from '../src/io/fiscal/gerar-xml-dps.js';

const pedido = {
  ref: 'consulta-2026-10-13-001', medicoId: 'medico-ficticio', valor: 350.25,
  paciente: { nome: ' Ana Oliveira ', cpf: '529.982.247-25', email: ' ana@example.invalid ', telefone: '5511999990000' },
  datasConsultas: '13/10/2026'
};

function repositorioEmMemoria() {
  const solicitacoes = new Map<string, SolicitacaoRefRegistro>();
  const fila: CriarSolicitacaoEmissaoParams[] = [];
  const pacientes: Array<{ medicoId: string; cpfLimpo: string; nome: string }> = [];
  let completo = true;
  const repositorio: EmissaoApiRepositorio = {
    async buscarPorReferencia(medicoId, ref) { return solicitacoes.get(`${medicoId}:${ref}`) ?? null; },
    async buscarPerfilFiscalMedico(medicoId) {
      return { medicoId, configuracaoCompleta: completo, nomeCompleto: 'Clara Almeida', especialidade: 'Psiquiatria',
        crm: '12345/SC', rqe: '6789', ctribNacPadrao: '040101', cnbs: '123456789', cclassTrib: '200030', cindOp: '100301' };
    },
    async buscarOuCriarPaciente(medicoId, paciente) { pacientes.push({ medicoId, ...paciente }); return { id: 'paciente-ficticio' }; },
    async enfileirarSolicitacao(params) {
      fila.push(params);
      const id = `solicitacao-${fila.length}`;
      solicitacoes.set(`${params.medicoId}:${params.ref}`, { id, medicoId: params.medicoId, referenciaExterna: params.ref,
        status: 'pendente', fila: 'pronta', criadoEm: new Date('2026-10-17T12:00:00Z') });
      return { id };
    }
  };
  return { repositorio, fila, pacientes, solicitacoes, incompleto() { completo = false; } };
}

const agora = () => new Date('2026-10-17T12:00:00Z');

describe('entrada da emissão — comportamento atual', () => {
  it('normaliza paciente e converte reais para centavos', () => {
    expect(validarPayloadEmissao({ ...pedido, ref: ' referencia ' })).toEqual({ ok: true, dados: {
      ref: 'referencia', medicoId: 'medico-ficticio', valorCentavos: 35025,
      paciente: { cpfLimpo: '52998224725', nome: 'Ana Oliveira', email: 'ana@example.invalid', telefone: '5511999990000' },
      discriminacao: null, datasConsultas: '13/10/2026'
    } });
  });

  it.each([0, -10, '350', NaN, null, undefined])('rejeita valor inválido %s', valor => {
    expect(validarPayloadEmissao({ ...pedido, valor })).toMatchObject({ ok: false, erro: { campo: 'valor', codigo: 'requisicao_invalida' } });
  });

  it.each(['111.111.111-11', '529.982.247-26', ''])('rejeita CPF %s', cpf => {
    expect(validarPayloadEmissao({ ...pedido, paciente: { ...pedido.paciente, cpf } })).toMatchObject({ ok: false, erro: { campo: 'paciente.cpf' } });
  });

  it('arredonda casas extras, inclusive valor positivo que vira zero centavos (achado)', () => {
    expect(validarPayloadEmissao({ ...pedido, valor: 350.256 })).toMatchObject({ ok: true, dados: { valorCentavos: 35026 } });
    expect(validarPayloadEmissao({ ...pedido, valor: 0.001 })).toMatchObject({ ok: true, dados: { valorCentavos: 0 } });
  });

  it('aceita Infinity na validação atual (achado; não é aprovação fiscal)', () => {
    expect(validarPayloadEmissao({ ...pedido, valor: Infinity })).toMatchObject({ ok: true, dados: { valorCentavos: Infinity } });
  });
});

describe('orquestração real da emissão com persistência fake', () => {
  it('enfileira valor, paciente, datas e descrição profissional', async () => {
    const banco = repositorioEmMemoria();
    expect(await processarSolicitacaoEmissaoApi(pedido, { repositorio: banco.repositorio, agora })).toEqual({ ok: true, statusHttp: 201,
      resposta: { status: 'processando_autorizacao', ref: pedido.ref, solicitacaoId: 'solicitacao-1', mensagem: 'Solicitação aceita para processamento' } });
    expect(banco.pacientes).toEqual([{ medicoId: pedido.medicoId, cpfLimpo: '52998224725', nome: 'Ana Oliveira', email: 'ana@example.invalid', telefone: '5511999990000' }]);
    expect(banco.fila).toEqual([{ ref: pedido.ref, medicoId: pedido.medicoId, pacienteId: 'paciente-ficticio', valorServicoCentavos: 35025,
      xdescServ: 'REFERENTE A CONSULTAS PSIQUIATRIA COM DR.(A) CLARA ALMEIDA VINCULADO CRM 12345/SC / RQE 6789 NAS DATAS 13/10/2026',
      ctribNac: '040101', cnbs: '123456789', cclassTrib: '200030', cindOp: '100301', datasConsultaTexto: '13/10/2026' }]);
  });

  it('preserva observação de pagador fornecida manualmente e o CPF do paciente', async () => {
    const banco = repositorioEmMemoria();
    const discriminacao = 'Consulta de Ana Oliveira. Pagamento realizado por Paulo Oliveira.';
    await processarSolicitacaoEmissaoApi({ ...pedido, discriminacao }, { repositorio: banco.repositorio });
    expect(banco.fila[0].xdescServ).toBe(discriminacao);
    expect(banco.pacientes[0].cpfLimpo).toBe('52998224725');
  });

  it('ignora campo pagador e não cria observação automaticamente (lacuna)', async () => {
    const banco = repositorioEmMemoria();
    await processarSolicitacaoEmissaoApi({ ...pedido, pagador: { nome: 'Paulo Oliveira', cpf: '11144477735' } }, { repositorio: banco.repositorio, agora });
    expect(banco.fila[0].xdescServ).toBe('REFERENTE A CONSULTAS PSIQUIATRIA COM DR.(A) CLARA ALMEIDA VINCULADO CRM 12345/SC / RQE 6789 NAS DATAS 13/10/2026');
    expect(banco.pacientes[0].cpfLimpo).toBe('52998224725');
  });

  it('não enfileira perfil fiscal incompleto', async () => {
    const banco = repositorioEmMemoria(); banco.incompleto();
    expect(await processarSolicitacaoEmissaoApi(pedido, { repositorio: banco.repositorio })).toMatchObject({ ok: false, statusHttp: 422, erro: { codigo: 'perfil_fiscal_incompleto' } });
    expect(banco.fila).toEqual([]); expect(banco.pacientes).toEqual([]);
  });

  it('repetição sequencial da referência mantém uma solicitação por médico', async () => {
    const banco = repositorioEmMemoria();
    await processarSolicitacaoEmissaoApi(pedido, { repositorio: banco.repositorio });
    expect(await processarSolicitacaoEmissaoApi(pedido, { repositorio: banco.repositorio })).toMatchObject({ ok: true, statusHttp: 200, resposta: { solicitacaoId: 'solicitacao-1' } });
    expect(banco.fila).toHaveLength(1);
    await processarSolicitacaoEmissaoApi({ ...pedido, medicoId: 'outro-medico' }, { repositorio: banco.repositorio });
    expect(banco.fila).toHaveLength(2);
  });

  it('retorna autorização existente sem emitir novamente', async () => {
    const banco = repositorioEmMemoria();
    banco.solicitacoes.set(`${pedido.medicoId}:${pedido.ref}`, { id: 'anterior', medicoId: pedido.medicoId, referenciaExterna: pedido.ref,
      status: 'concluido', fila: null, criadoEm: agora(), notaFiscal: { chaveAcesso: 'chave-ficticia', ndps: 42, serie: '00001', dataEmissao: agora(), xmlStoragePath: 'xml-ficticio', pdfStoragePath: 'pdf-ficticio' } });
    expect(await processarSolicitacaoEmissaoApi(pedido, { repositorio: banco.repositorio })).toEqual({ ok: true, statusHttp: 200,
      resposta: { status: 'autorizado', ref: pedido.ref, solicitacaoId: 'anterior', chaveAcesso: 'chave-ficticia', ndps: 42, serie: '00001', dataEmissao: '2026-10-17T12:00:00.000Z', xmlStoragePath: 'xml-ficticio', pdfStoragePath: 'pdf-ficticio' } });
    expect(banco.fila).toEqual([]);
  });

  it.each(['erro', 'excecao'])('bloqueia nova tentativa da referência com status %s', async status => {
    const banco = repositorioEmMemoria();
    banco.solicitacoes.set(`${pedido.medicoId}:${pedido.ref}`, { id: 'anterior', medicoId: pedido.medicoId, referenciaExterna: pedido.ref, status, fila: null, criadoEm: agora(), erro: 'Rejeição fiscal fictícia' });
    expect(await processarSolicitacaoEmissaoApi(pedido, { repositorio: banco.repositorio })).toMatchObject({ ok: false, statusHttp: 422, erro: { codigo: 'solicitacao_anterior_falhou', mensagem: 'Rejeição fiscal fictícia' } });
    expect(banco.fila).toEqual([]);
  });
});

describe('DPS real sem prefeitura', () => {
  const prestador: ConfigPrestador = { cnpj: '12345678000195', im: '12345', codMunicipio: '4205407', ambiente: 2,
    regTrib: { opSimpNac: 3, regApTribSN: 1, regEspTrib: 0 }, pTotTribSN: 6 };
  const entrada: EmissaoInput = { nDPS: '42', tomador: { CPF: '52998224725', xNome: 'Ana Oliveira', email: 'ana@example.invalid' },
    vServ: 350.25, xDescServ: 'Consulta. Pagamento por Paulo & Maria.', cTribNac: '040101', cNBS: '', cIndOp: '', cClassTrib: '' };

  it('monta tomador CPF, valor, prestador, descrição e data em São Paulo', () => {
    const dps = montarDps(entrada, prestador, agora());
    expect(dps.infDps).toMatchObject({ tpAmb: 2, dhEmi: '2026-10-17T09:00:00-03:00', dCompet: '2026-10-17', nDPS: '42',
      prest: { CNPJ: '12345678000195', IM: '12345' }, toma: { CPF: '52998224725', xNome: 'Ana Oliveira' },
      serv: { cServ: { cTribNac: '040101', xDescServ: entrada.xDescServ } }, valores: { vServPrest: { vServ: 350.25 } } });
  });

  it('serializa XML, escapa observação e gera identificador estável', () => {
    const { xml, dpsId } = gerarXmlDps(entrada, prestador, agora());
    expect(dpsId).toBe('DPS420540721234567800019500001000000000000042');
    expect(xml).toContain('<vServ>350.25</vServ>');
    expect(xml).toContain('<xDescServ>Consulta. Pagamento por Paulo &amp; Maria.</xDescServ>');
    const parsed = new XMLParser({ parseTagValue: false }).parse(xml).DPS.infDPS;
    expect(parsed.toma).toEqual({ CPF: '52998224725', xNome: 'Ana Oliveira', email: 'ana@example.invalid' });
    expect(parsed.valores.trib).toEqual({ tribMun: { tribISSQN: '1', tpRetISSQN: '1' }, tribFed: { piscofins: { CST: '08' } }, totTrib: { pTotTribSN: '6.00' } });
  });

  // XSD v1.01: produção restrita 20261020 antecipa cNBS; produção 20260209 mantém a ordem anterior.
  // Fontes oficiais e hashes dos pacotes estão em docs/evidencias/dps-schema-cserv.md.
  it.each([
    [2, true, true, ['cTribNac', 'cTribMun', 'cNBS', 'xDescServ']],
    [2, false, true, ['cTribNac', 'cNBS', 'xDescServ']],
    [2, true, false, ['cTribNac', 'cTribMun', 'xDescServ']],
    [2, false, false, ['cTribNac', 'xDescServ']],
    [1, true, true, ['cTribNac', 'cTribMun', 'xDescServ', 'cNBS']],
    [1, false, true, ['cTribNac', 'xDescServ', 'cNBS']],
    [1, true, false, ['cTribNac', 'cTribMun', 'xDescServ']],
    [1, false, false, ['cTribNac', 'xDescServ']]
  ] as const)('serv/cServ segue sequência XSD (ambiente=%s, municipal=%s, NBS=%s)', (ambiente, municipal, nbs, ordem) => {
    const { xml } = gerarXmlDps({ ...entrada, cTribMun: municipal ? '001' : undefined, cNBS: nbs ? '122051000' : '',
      fiscal: { ambiente: ambiente === 2 ? 'homologacao' : 'producao', vigenciaInicio: '2026-01-01', competencia: '2026-10-17',
        municipioPrestacao: '4205407', opcaoSimplesNacional: 'me_epp', regimeApuracaoSn: 'regime_1',
        regimeEspecialTributacao: 0, tribISSQN: 1, tpRetISSQN: 1, cstPisCofins: '08', percentualTotTribSN: 6 } },
      { ...prestador, ambiente }, agora());
    const dps = new XMLParser({ parseTagValue: false, ignoreAttributes: false }).parse(xml).DPS;
    expect(dps['@_xmlns']).toBe('http://www.sped.fazenda.gov.br/nfse');
    expect(dps['@_versao']).toBe('1.01');
    expect(Object.keys(dps.infDPS.serv)).toEqual(['locPrest', 'cServ']);
    expect(dps.infDPS.serv.locPrest).toEqual({ cLocPrestacao: '4205407' });
    expect(Object.keys(dps.infDPS.serv.cServ)).toEqual(ordem);
    expect(dps.infDPS.serv.cServ).toEqual({ cTribNac: '040101', ...(municipal ? { cTribMun: '001' } : {}),
      ...(nbs ? { cNBS: '122051000' } : {}), xDescServ: entrada.xDescServ });
  });

  it('MEI não inclui PIS/COFINS nem percentual total do Simples', () => {
    const { xml } = gerarXmlDps(entrada, { ...prestador, regTrib: { ...prestador.regTrib, opSimpNac: 2 } }, agora());
    expect(xml).toContain('<totTrib><indTotTrib>0</indTotTrib></totTrib>');
    expect(xml).not.toContain('<tribFed>'); expect(xml).not.toContain('<regApTribSN>');
  });
});
