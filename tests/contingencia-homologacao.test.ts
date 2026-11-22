import { describe, expect, it } from 'vitest';
import { podeUsarContingenciaHomologacao } from '../src/fiscal/regras/decidir-contingencia-homologacao.js';
import { generateDanfsePdf } from '../src/fiscal/danfse/gerar-danfse-pdf.js';
import { extrairMetadadosDanfseDoXml } from '../src/fiscal/danfse/extrair-metadados-danfse-xml.js';
import { montarServicoDanfseComTributos } from '../src/fiscal/danfse/calcular-tributos-danfse.js';
import { montarResumoEntregaNotaMedico } from '../src/emissao/regras/formatar-mensagens-emissao.js';
import type { CasoEmissaoRegistro } from '../src/emissao/caso-emissao-repositorio.js';

describe('Contingência local exclusiva de Homologação', () => {
  const baseValida = {
    permitirContingenciaHomologacao: true,
    pilotoWhatsApp: false,
    ambiente: 2 as const,
    xmlAssinadoPresente: true,
    codigoErroSefin: 'SEFIN_HTTP_403_IIS'
  };

  it('ativa somente em homologação com DPS assinada pelo A1 e indisponibilidade externa da SEFIN', () => {
    expect(podeUsarContingenciaHomologacao(baseValida)).toBe(true);
    expect(podeUsarContingenciaHomologacao({ ...baseValida, codigoErroSefin: 'SEFIN_TIMEOUT' })).toBe(true);
    expect(podeUsarContingenciaHomologacao({ ...baseValida, codigoErroSefin: 'SEFIN_INDISPONIVEL' })).toBe(true);
    expect(podeUsarContingenciaHomologacao({ ...baseValida, codigoErroSefin: undefined, httpStatus: 503 })).toBe(true);
    expect(podeUsarContingenciaHomologacao({ ...baseValida, codigoErroSefin: undefined, falhaAntesDoEnvio: 'ECONNREFUSED' })).toBe(true);
  });

  it('bloqueia absolutamente em produção, piloto restrito, sem flag, sem A1 assinado ou em erro fiscal real', () => {
    expect(podeUsarContingenciaHomologacao({ ...baseValida, ambiente: 1 })).toBe(false);
    expect(podeUsarContingenciaHomologacao({ ...baseValida, pilotoWhatsApp: true })).toBe(false);
    expect(podeUsarContingenciaHomologacao({ ...baseValida, permitirContingenciaHomologacao: false })).toBe(false);
    expect(podeUsarContingenciaHomologacao({ ...baseValida, xmlAssinadoPresente: false })).toBe(false);
    expect(podeUsarContingenciaHomologacao({ ...baseValida, codigoErroSefin: 'E0160', httpStatus: 400 })).toBe(false);
    expect(podeUsarContingenciaHomologacao({ ...baseValida, codigoErroSefin: 'PACIENTE_CPF_INVALIDO', httpStatus: 400 })).toBe(false);
  });

  it('gera PDF DANFSe v2.0 válido com marca d’água de contingência offline sem erro de codificação', async () => {
    const pdf = await generateDanfsePdf({
      numero: '42',
      serie: '00001',
      competencia: '2026-09',
      dataEmissao: '2026-09-28T15:00:00.000Z',
      ambiente: 'homologacao',
      contingenciaHomologacao: true,
      prestador: {
        razaoSocial: 'CLINICA EXEMPLO SERVICOS MEDICOS LTDA',
        cnpj: '11222333000181',
        municipio: '4314902',
        uf: 'RS',
        simplesNacional: true
      },
      tomador: {
        nome: 'Marina Costa',
        cpf: '12345678901'
      },
      servico: {
        cTribNac: '040101',
        discriminacao: 'REFERENTE A CONSULTA MEDICA EM 28/09/2026',
        valor: 800
      }
    });

    expect(pdf.byteLength).toBeGreaterThan(1000);
    expect(Buffer.from(pdf.slice(0, 5)).toString('ascii')).toBe('%PDF-');
  });

  it('formata legenda transparente informando contingência de homologação sem valor fiscal', () => {
    const casoHomolog: CasoEmissaoRegistro = {
      id: 'c1',
      contaId: 'conta-1',
      medicoId: 'med-1',
      origem: 'pedido_medico',
      chaveIdempotencia: 'k1',
      estado: 'emitida',
      pacienteNome: 'Marina Costa',
      pacienteCpf: null,
      pacienteTelefone: null,
      pagadorNome: null,
      pagadorCpfHash: null,
      atendimentoExternoId: null,
      dataConsulta: '2026-09-28',
      valorCentavos: 80000,
      aprovadoPeloMedico: true,
      ambiente: 'homologacao',
      solicitacaoId: 's1',
      notaFiscalId: 'n1',
      erroMotivo: null,
      origemMensagemChave: null,
      criadoEm: '2026-09-28T15:00:00Z',
      atualizadoEm: '2026-09-28T15:00:00Z'
    };

    const resumo = montarResumoEntregaNotaMedico(casoHomolog, { contingenciaHomologacao: true });
    expect(resumo.resumoMedico).toContain('contingência de homologação');
    expect(resumo.resumoMedico).toContain('DPS assinada pelo A1');
    expect(resumo.resumoMedico).toContain('sem valor fiscal');

    const resumoProd = montarResumoEntregaNotaMedico(
      { ...casoHomolog, ambiente: 'producao' },
      { contingenciaHomologacao: true }
    );
    expect(resumoProd.resumoMedico).not.toContain('contingência de homologação');
  });

  it('extrai metadados fiscais do XML real do ADN e projeta ISSQN, PIS/COFINS, IBS/CBS e Lei 12.741/2012 no DANFSe', async () => {
    const xmlObj = {
      NFSe: {
        infNFSe: {
          xTribNac: 'Psicologia.',
          xNBS: 'Serviços psiquiátricos',
          emit: {
            enderNac: { xLgr: 'RUA DAS FLORES', nro: '100', xBairro: 'CENTRO', UF: 'RS', CEP: '90010000' },
            fone: '51999990001',
            email: 'CLINICA@EXEMPLO.COM.BR'
          },
          valores: { pAliqAplic: '2.00' },
          IBSCBS: {
            valores: {
              uf: { pIBSUF: '0.10', pAliqEfetUF: '0.10' },
              mun: { pIBSMun: '0.00', pAliqEfetMun: '0.00' },
              fed: { pCBS: '0.90', pAliqEfetCBS: '0.90' }
            }
          },
          DPS: {
            infDPS: {
              prest: { fone: '51999990002', email: 'dra.exemplo@exemplo.com.br' }
            }
          }
        }
      }
    };

    const meta = extrairMetadadosDanfseDoXml(xmlObj);
    expect(meta).toEqual({
      prestador: {
        endereco: 'RUA DAS FLORES, 100, CENTRO',
        cep: '90010000',
        telefone: '51999990002',
        email: 'dra.exemplo@exemplo.com.br'
      },
      aliquotaIssAplicada: 2,
      descricaoTribNac: 'Psicologia.',
      descricaoNbs: 'Serviços psiquiátricos',
      ibscbsAliquotas: { pIbsUf: 0.1, pIbsMun: 0, pCbs: 0.9 }
    });

    const servico800 = montarServicoDanfseComTributos({
      valorServico: 800,
      discriminacao: 'CONSULTA MEDICA',
      cTribNac: '041601',
      cNBS: '123011300',
      municipioPrestacao: '4314902',
      ufPrestacao: 'RS',
      metadados: meta,
      fiscal: {
        ambiente: 'homologacao',
        municipioPrestacao: '4314902',
        opcaoSimplesNacional: 'nao_optante',
        regimeEspecialTributacao: 0,
        tribISSQN: 1,
        tpRetISSQN: 1,
        cstPisCofins: '01',
        pisCofinsCalculo: { base: 'valor_servico', aliquotaPis: 0.65, aliquotaCofins: 3, tipoRetencao: 0 },
        totalTributos: { tipo: 'percentual', federal: 11.33, estadual: 0, municipal: 2 },
        ibscbs: { finNFSe: '0', indFinal: '0', cIndOp: '030101', indDest: '0', CST: '000', cClassTrib: '000001' },
        vigenciaInicio: '2026-01-01'
      }
    });

    expect(servico800).toMatchObject({
      aliquota: 2,
      baseCalculoIss: 800,
      issApurado: 16,
      valorPis: 5.2,
      valorCofins: 24,
      cstIbsCbs: '000',
      cClassTrib: '000001',
      cIndOp: '030101',
      baseCalculoIbsCbs: 784,
      valorIbsUf: 0.78,
      valorIbsMun: 0,
      valorIbsTotal: 0.78,
      valorCbs: 7.06,
      totalIbsCbs: 7.84,
      totalTributosAproximados: {
        federalPct: 11.33,
        federalValor: 90.64,
        estadualPct: 0,
        estadualValor: 0,
        municipalPct: 2,
        municipalValor: 16
      }
    });

    const pdf = await generateDanfsePdf({
      numero: '5',
      serie: '00001',
      competencia: '2026-11',
      dataEmissao: '2026-11-21T23:55:00.000Z',
      finalidade: 'NFS-e Regular',
      ambiente: 'homologacao',
      contingenciaHomologacao: true,
      prestador: {
        razaoSocial: 'CLINICA EXEMPLO SERVICOS MEDICOS LTDA',
        cnpj: '11222333000181',
        municipio: '4314902',
        uf: 'RS',
        opcaoSimplesNacional: 'nao_optante',
        ...meta?.prestador
      },
      tomador: { nome: 'Marina Costa', cpf: '12345678901' },
      servico: servico800
    });
    expect(Buffer.from(pdf.slice(0, 5)).toString('ascii')).toBe('%PDF-');
  });
});
