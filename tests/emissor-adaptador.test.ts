import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { PDFDocument } from 'pdf-lib';
import { PostgresEmissorDpsService } from '../src/io/fiscal/postgres-emissor-dps-service.js';

const item = { id: 'solicitacao-1', medicoId: 'medico-1', pacienteId: 'paciente-1', valorServicoCentavos: 35025,
  xdescServ: 'Consulta de Ana Oliveira. Pagamento realizado por Paulo Oliveira.', ctribNac: '040101' };

function cadastroFiscal(opcoes: { profissional?: boolean; perfil?: boolean; referencia?: boolean; cpf?: string; nome?: string } = {}) {
  const consultas: Array<{ sql: string; valores: unknown[] }> = [];
  const pool = { async query(sql: string, valores: unknown[]) {
    consultas.push({ sql: sql.replace(/\s+/g, ' ').trim(), valores });
    if (sql.includes('from medicos m join solicitacoes_nota')) return { rows: opcoes.profissional === false ? [] : [{ nome_completo: 'Clara Almeida', crm: '12345/SC', rqe: '6789', especialidade: 'Psiquiatria', aguardando_confirmacao_medico: false }] };
    if (sql.includes('from medico_perfil_fiscal pf')) return { rows: opcoes.perfil === false ? [] : [{ nome_completo: 'Clara Almeida', razao_social: 'Clinica Ficticia', documento_limpo: '12345678000195', inscricao_municipal: '12345',
      uf: 'SC', cod_municipio_ibge: '4205407', serie_dps: '00001', proximo_numero_dps: 42, ambiente: 'homologacao', opcao_simples_nacional: 'me_epp', regime_apuracao_sn: 'regime_1', regime_especial_tributacao: 0,
      percentual_tot_trib_sn: 6, dados_reforma_tributaria: { versao: opcoes.referencia ? 2 : 1 } }] };
    if (sql.includes('from pacientes') && sql.includes('where id = $1')) return { rows: [{ cpf_limpo: opcoes.cpf ?? '52998224725', nome: opcoes.nome ?? 'Ana Oliveira', nome_validado: true }] };
    if (sql.includes('from pacientes') && sql.includes('cpf_cnpj_hash')) return { rows: [] };
    if (sql.includes('max(ndps)')) return { rows: [{ proximo: '41' }] };
    throw new Error('SQL inesperado no teste do emissor: ' + sql);
  } } as unknown as pg.Pool;
  return { pool, consultas };
}

describe('adaptador real de emissão com SQL fake, sem prefeitura', () => {
  it('modo local sem integrações retorna sucesso simulado e PDF válido (comportamento atual)', async () => {
    const banco = cadastroFiscal();
    const resultado = await new PostgresEmissorDpsService(banco.pool, 'chave-ficticia').emitir(item);
    expect(resultado).toMatchObject({ sucesso: true, ndps: 42, serie: '00001', valorServicosCentavos: 35025 });
    if (!resultado.sucesso) throw new Error('O modo local deveria retornar sucesso simulado');
    expect(resultado.respostaSefinRaw).toMatchObject({ layoutDps: { infDps: { toma: { CPF: '52998224725', xNome: 'Ana Oliveira' },
      serv: { cServ: { xDescServ: item.xdescServ } }, valores: { vServPrest: { vServ: 350.25 } } } } });
    expect(banco.consultas.find(c => c.sql.includes('from pacientes') && c.sql.includes('where id = $1'))!.valores).toEqual(['paciente-1', 'chave-ficticia']);
    expect(resultado.pdfStoragePath).toMatch(/^data:application\/pdf;base64,/);
    const bytes = Buffer.from(resultado.pdfStoragePath.split(',')[1], 'base64');
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 595.28, height: 841.89 });
  });
  it('ausência de dados profissionais impede acesso ao perfil e ao paciente', async () => {
    const banco = cadastroFiscal({ profissional: false });
    expect(await new PostgresEmissorDpsService(banco.pool, 'chave-ficticia').emitir(item)).toEqual({ sucesso: false, erro: 'Informe nome completo e CRM para emitir suas notas.', codigoErroSefin: 'DADOS_PROFISSIONAIS_INCOMPLETOS', dadosProfissionaisPendentes: true, contextoTecnico: { etapa: 'dados_profissionais', transmitida: false } });
    expect(banco.consultas).toHaveLength(1);
  });
  it('modo conservador sem integrações não permite simulação', async () => {
    const banco = cadastroFiscal();
    expect(await new PostgresEmissorDpsService(banco.pool, 'chave-ficticia', undefined, undefined, undefined, undefined, true).emitir(item))
      .toEqual({ sucesso: false, erro: 'Emissão real indisponível: integração fiscal não configurada.', codigoErroSefin: 'INTEGRACAO_FISCAL_INDISPONIVEL' });
    expect(banco.consultas).toHaveLength(1);
  });
  it('perfil fiscal ausente bloqueia emissão', async () => {
    const banco = cadastroFiscal({ perfil: false });
    expect(await new PostgresEmissorDpsService(banco.pool, 'chave-ficticia').emitir(item)).toEqual({ sucesso: false, erro: 'Perfil fiscal não cadastrado para o médico medico-1', codigoErroSefin: 'PERFIL_FISCAL_INCOMPLETO' });
  });
  it('referência importada exige preparação fiscal ativa', async () => {
    const banco = cadastroFiscal({ referencia: true });
    expect(await new PostgresEmissorDpsService(banco.pool, 'chave-ficticia').emitir(item)).toMatchObject({ sucesso: false,
      pendenciasFiscais: [{ campo: 'configuracao', codigo: 'PREPARACAO_NECESSARIA', mensagem: 'A preparação fiscal precisa estar ativa para validar os parâmetros importados.' }], contextoTecnico: { transmitida: false } });
    expect(banco.consultas).toHaveLength(2);
  });
  it('paciente sem CPF não avança para numeração nem PDF', async () => {
    const banco = cadastroFiscal({ cpf: '' });
    expect(await new PostgresEmissorDpsService(banco.pool, 'chave-ficticia').emitir(item)).toEqual({ sucesso: false, erro: 'Paciente paciente-1 sem CPF válido para emissão', codigoErroSefin: 'PACIENTE_CPF_INVALIDO' });
    expect(banco.consultas.some(c => c.sql.includes('max(ndps)'))).toBe(false);
  });
});
