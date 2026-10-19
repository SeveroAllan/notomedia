/**
 * Adaptador PostgreSQL do emissor de DPS/NFS-e Nacional (fork kursku/emissor-nfse).
 * Substitui o .env e arquivos locais: lê medico_perfil_fiscal (com decriptação de
 * CPF/CNPJ via pgp_sym_decrypt) e medico_certificados diretamente do banco (seções 1 e 5).
 */

import type pg from 'pg';
import { dadosProfissionaisCompletos } from '../../conta/validar-dados-emissao.js';
import { montarDescricaoServico } from '../../emissao/montar-descricao-servico.js';
import { carregarEvidenciasEmissao } from './carregar-evidencias-emissao.js';
import { prepararEmissao } from '../../fiscal/preparacao/preparar-emissao.js';
import { inferirUfDeMunicipioIbge } from '../../onboarding/regras/inferir-uf-de-municipio-ibge.js';
import { validarDadosDps } from '../../fiscal/preparacao/validar-dados-dps.js';
import { BLOCO_FEDERAL_AUTOMATICO, podeCorrigirTributosFederais } from '../../agente-fiscal/analisar-rejeicao.js';
import type { FalhaEmissao } from '../../agente-fiscal/investigacao.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  EmissorDpsService,
  SolicitacaoEmissaoItem,
  ResultadoEmissaoDps
} from '../../worker/emissor-dps-service.js';
import { montarDps, type ConfigPrestador, type EmissaoInput } from './montar-dps.js';
import { gerarXmlDps } from './gerar-xml-dps.js';
import { extrairChavesCertificado } from './extrair-chaves-certificado.js';
import { assinarXmlDps } from './assinar-xml-dps.js';
import { carregarCertificadoMedico } from './carregar-certificado-medico.js';
import { SefinNacionalClient } from './sefin-nacional-client.js';
import { generateDanfsePdf } from '../../fiscal/danfse/gerar-danfse-pdf.js';
import { comporChaveAcessoNacional } from '../../fiscal/danfse/formatadores-fiscais.js';
import { montarXmlNfse } from '../../fiscal/danfse/montar-xml-nfse.js';
import type { MeuDanfeClient } from '../meudanfe/meu-danfe-client.js';
import type { ConsultaCpfProvider } from '../../paciente/consulta-cpf-provider.js';
import { ehNomeCivilValido } from '../../paciente/regras/validar-nome-civil.js';

export type ConfigPrestadorCompleto = ConfigPrestador & {
  referenciaImportada?: boolean;
  serie: string;
  razaoSocial: string;
  nomeFantasia?: string;
  uf: string;
  email?: string;
  telefone?: string;
  proximoNumeroDps?: number;
};

export class PostgresEmissorDpsService implements EmissorDpsService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly chaveCriptografia: string,
    private readonly meuDanfeClient?: MeuDanfeClient,
    private readonly consultaCpfProvider?: ConsultaCpfProvider,
    private readonly supabaseClient?: SupabaseClient,
    private readonly sefinClient?: SefinNacionalClient,
    private readonly modoAgenteConservador = false,
    private readonly preparacaoFiscalAtiva = false
  ) {}

  emitir(item: SolicitacaoEmissaoItem & { emissaoComprovante?: never }): Promise<
    ResultadoEmissaoDps & ({ sucesso: false } | { pdfStoragePath: string })>;
  emitir(item: SolicitacaoEmissaoItem): Promise<ResultadoEmissaoDps>;
  async emitir(item: SolicitacaoEmissaoItem): Promise<ResultadoEmissaoDps> {
    return this.emitirPreparado(item);
  }

  async corrigirRejeicao(item: SolicitacaoEmissaoItem, falha: FalhaEmissao): Promise<ResultadoEmissaoDps> {
    if (!this.modoAgenteConservador || !podeCorrigirTributosFederais(falha)) {
      return { sucesso: false, erro: 'Correção não autorizada pelas evidências da rejeição.' };
    }
    return this.emitirPreparado(item, falha);
  }

  private async emitirPreparado(item: SolicitacaoEmissaoItem, correcao?: FalhaEmissao): Promise<ResultadoEmissaoDps> {
    // Um mesmo instante define competência e dhEmi, inclusive na virada do dia.
    // Correções preservam o instante da DPS original, sem gerar outra emissão.
    const dataGeracao = correcao ? new Date(String(correcao.contextoTecnico!.dataGeracao)) : new Date();
    const { rows: profissionais } = await this.pool.query(
      'select m.nome_completo, m.crm, m.rqe, m.especialidade, s.aguardando_confirmacao_medico from medicos m join solicitacoes_nota s on s.medico_id=m.id where m.id=$1 and s.id=$2', [item.medicoId,item.id]);
    if (!profissionais[0] || !dadosProfissionaisCompletos(profissionais[0])) {
      return { sucesso: false, erro: 'Informe nome completo e CRM para emitir suas notas.',
        dadosProfissionaisPendentes: true, contextoTecnico: { etapa: 'dados_profissionais', transmitida: false } };
    }
    // Um item já reservado pode conter a identidade anterior à resposta do médico.
    const datas = item.xdescServ.match(/^REFERENTE A CONSULTAS .+ NAS DATAS (.+)$/i)?.[1];
    if (datas) {
      const medico = profissionais[0];
      item = {...item, xdescServ: montarDescricaoServico({nomeCompleto:medico.nome_completo,
        crm:medico.crm, rqe:medico.rqe, especialidade:medico.especialidade}, datas)};
    }
    if ((this.modoAgenteConservador || this.preparacaoFiscalAtiva) && (!this.supabaseClient || !this.sefinClient)) {
      return { sucesso: false, erro: 'Emissão real indisponível: integração fiscal não configurada.' };
    }
    const prestadorConfig = await this.carregarPerfilFiscal(item.medicoId);
    if (!prestadorConfig) {
      return { sucesso: false, erro: `Perfil fiscal não cadastrado para o médico ${item.medicoId}` };
    }
    if (item.emissaoComprovante && prestadorConfig.ambiente !== 2) {
      return { sucesso: false, erro: 'AMBIENTE_FISCAL_BLOQUEADO', codigoErroSefin: 'AMBIENTE_FISCAL_BLOQUEADO' };
    }
    if (prestadorConfig.referenciaImportada && !this.preparacaoFiscalAtiva) {
      return { sucesso: false, erro: 'Ative a preparação fiscal para emitir com os parâmetros da referência importada.',
        pendenciasFiscais: [{ campo: 'configuracao', codigo: 'PREPARACAO_NECESSARIA', mensagem: 'A preparação fiscal precisa estar ativa para validar os parâmetros importados.' }],
        contextoTecnico: { etapa: 'preparacao', transmitida: false } };
    }

    const preparacao = this.preparacaoFiscalAtiva
      ? prepararEmissao(item, await carregarEvidenciasEmissao(this.pool, item), dataGeracao.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }))
      : undefined;
    if (preparacao && !preparacao.ok) {
      return { sucesso: false, erro: 'Há parâmetros fiscais pendentes de revisão antes do envio.',
        pendenciasFiscais: preparacao.pendencias, contextoTecnico: { etapa: 'preparacao', transmitida: false } };
    }
    const tomador = await this.carregarDadosTomador(item.pacienteId);
    if (!tomador || !tomador.cpf) {
      return { sucesso: false, erro: `Paciente ${item.pacienteId} sem CPF válido para emissão` };
    }

    // Se o nome ainda não foi validado, tenta obter via cadastro existente no banco ou API da Receita
    if (!tomador.nomeValidado || !ehNomeCivilValido(tomador.nome)) {
      // 1. Tenta reaproveitar de outro cadastro com o mesmo CPF que já tenha nome validado
      const { rows: pacientesMesmoCpf } = await this.pool.query(
        `select nome, data_nascimento from pacientes
         where medico_id = $1 and cpf_cnpj_hash = (select cpf_cnpj_hash from pacientes where id = $2)
           and nome_validado = true and nome is not null
         limit 1`,
        [item.medicoId, item.pacienteId]
      );
      if (pacientesMesmoCpf.length > 0 && ehNomeCivilValido(pacientesMesmoCpf[0].nome)) {
        tomador.nome = pacientesMesmoCpf[0].nome;
        tomador.nomeValidado = true;
        await this.pool.query(
          `update pacientes set nome = $1, nome_validado = true, data_nascimento = coalesce(data_nascimento, $2), atualizado_em = now() where id = $3`,
          [tomador.nome, pacientesMesmoCpf[0].data_nascimento || null, item.pacienteId]
        );
      } else if (this.consultaCpfProvider && tomador.cpf) {
        // 2. Se não encontrou no banco, consulta a API oficial da Receita Federal
        try {
          const dadosCpf = await this.consultaCpfProvider.consultar(tomador.cpf);
          if (dadosCpf?.nome && ehNomeCivilValido(dadosCpf.nome)) {
            tomador.nome = dadosCpf.nome;
            tomador.nomeValidado = true;
            await this.pool.query(
              `update pacientes set nome = $1, nome_validado = true, data_nascimento = coalesce(data_nascimento, $2), atualizado_em = now() where id = $3`,
              [dadosCpf.nome, dadosCpf.dataNascimento || null, item.pacienteId]
            );
          }
        } catch (err: any) {
          console.warn('[PostgresEmissorDpsService] Falha ao consultar CPF do tomador:', err?.message || err);
        }
      }
    }

    if (!ehNomeCivilValido(tomador.nome)) {
      return {
        sucesso: false,
        erro: `Paciente ${item.pacienteId} sem nome civil completo válido para emissão de NFS-e (nome atual: '${tomador.nome || 'nulo'}').`
      };
    }

    const ndps = await this.obterProximoNdps(item.medicoId, prestadorConfig.proximoNumeroDps);
    const emissaoInput: EmissaoInput = {
      nDPS: String(ndps),
      tomador: {
        CPF: tomador.cpf,
        xNome: tomador.nome!,
        end: tomador.endereco
      },
      xDescServ: item.xdescServ,
      vServ: item.valorServicoCentavos / 100,
      cTribNac: preparacao?.ok ? preparacao.servico.ctribNac : item.ctribNac,
      cNBS: preparacao?.ok ? (preparacao.servico.cnbs ?? '') : (item.cnbs || '122051900'),
      cIndOp: preparacao?.ok ? (item.cindOp ?? '') : (item.cindOp || '100301'),
      cClassTrib: preparacao?.ok ? (item.cclassTrib ?? '') : (item.cclassTrib || '000001'),
      cTribMun: preparacao?.ok ? preparacao.servico.ctribMun ?? undefined : undefined,
      fiscal: preparacao?.ok ? { ...preparacao.parametros, competencia: preparacao.competencia } : undefined
    };

    if (preparacao?.ok) {
      const p = preparacao.parametros;
      prestadorConfig.regTrib.opSimpNac = ({ nao_optante: 1, mei: 2, me_epp: 3 } as const)[p.opcaoSimplesNacional];
      prestadorConfig.regTrib.regApTribSN = ({ regime_1: 1, regime_2: 2, regime_3: 3 } as const)[p.regimeApuracaoSn!];
      prestadorConfig.regTrib.regEspTrib = p.regimeEspecialTributacao;
      prestadorConfig.pTotTribSN = p.percentualTotTribSN ?? 0; // MEI não serializa percentual.
      const pendencias = validarDadosDps(emissaoInput, prestadorConfig);
      if (pendencias.length) return { sucesso: false, erro: 'Dados da DPS precisam de revisão antes do envio.',
        pendenciasFiscais: pendencias, contextoTecnico: { etapa: 'validacao', transmitida: false, origem: preparacao.origem } };
    }
    let ndpsAtual = correcao ? Number(correcao.contextoTecnico!.ndps) : ndps;
    let xmlDpsOriginal: string | undefined;
    const anoMes = (preparacao?.ok ? preparacao.competencia : dataGeracao.toISOString()).slice(0, 7);
    let chaveAcessoFinal = '';
    let respostaSefinRaw: Record<string, unknown> | undefined;
    let xmlAutorizadoFinal: string | undefined;
    let dataEmissaoFinal = new Date();

    if (this.supabaseClient && this.sefinClient) {
      const cert = await carregarCertificadoMedico(this.pool, this.supabaseClient, item.medicoId);
      if (!cert) {
        return {
          sucesso: false,
          erro: `Médico ${item.medicoId} não possui certificado digital A1 ativo cadastrado no sistema para emissão com validade jurídica na SEFIN.`
        };
      }

      let chaves;
      try {
        chaves = extrairChavesCertificado(cert.pfxBuffer, cert.senhaCertificado);
      } catch (err: any) {
        return {
          sucesso: false,
          erro: `Falha ao decodificar certificado A1 do médico: ${err?.message || err}`
        };
      }

      let resSefinFinal: any;
      const MAX_INCREMENTOS_SEQUENCIA = 5;

      for (let seq = 0; seq <= MAX_INCREMENTOS_SEQUENCIA; seq++) {
        emissaoInput.nDPS = String(ndpsAtual);
        const { dpsId, xml: xmlGerado } = gerarXmlDps(emissaoInput, prestadorConfig, dataGeracao);
        xmlDpsOriginal = xmlGerado;
        if (correcao && xmlGerado !== correcao.xmlDpsOriginal) {
          return { sucesso: false, erro: 'Dados da emissão mudaram desde a rejeição. Correção interrompida sem transmitir.' };
        }
        const xmlDps = correcao ? xmlGerado.replace(BLOCO_FEDERAL_AUTOMATICO, '') : xmlGerado;
        const xmlAssinado = assinarXmlDps({
          xml: xmlDps,
          dpsId,
          pemKey: chaves.pemKey,
          pemCert: chaves.pemCert,
          certBase64: chaves.certBase64
        });

        const resSefin = await this.sefinClient.transmitirDps({
          xmlAssinado,
          pfxBuffer: cert.pfxBuffer,
          senhaCertificado: cert.senhaCertificado,
          ambiente: prestadorConfig.ambiente
        });

        resSefinFinal = resSefin;

        // [DIAG-TEMP] captura crua da resposta SEFIN + XML enviado (CPF mascarado) - REMOVER APOS DIAGNOSTICO
        if (!resSefin.sucesso) {
          try {
            const xmlMascarado = xmlAssinado.replace(/<CPF>\d{11}<\/CPF>/g, '<CPF>***</CPF>');
            console.warn('[DIAG_E0014]', JSON.stringify({
              dpsId, nDPS: emissaoInput.nDPS, ambiente: prestadorConfig.ambiente,
              httpStatus: resSefin.httpStatus, codigoErro: resSefin.codigoErro, motivo: resSefin.motivo,
              respostaRaw: resSefin.respostaRaw, xmlEnviado: xmlMascarado
            }));
          } catch (e) { console.warn('[DIAG_E0014] falha ao logar diagnostico', (e as any)?.message); }
        }

        if (resSefin.sucesso) {
          break;
        }

        if (this.modoAgenteConservador || this.preparacaoFiscalAtiva) break;

        if (resSefin.codigoErro === 'E0014' || resSefin.motivo?.includes('E0014')) {
          console.warn(`[PostgresEmissorDpsService] DPS ${ndpsAtual} duplicada (E0014). Avançando para ${ndpsAtual + 1}...`);
          ndpsAtual++;
          await this.pool.query(
            `update medico_perfil_fiscal
             set proximo_numero_dps = greatest(coalesce(proximo_numero_dps, 1), $2),
                 atualizado_em = now()
             where medico_id = $1`,
            [item.medicoId, ndpsAtual]
          );
          if (seq < MAX_INCREMENTOS_SEQUENCIA) {
            continue;
          }
        }

        if (
          resSefin.codigoErro === 'E0676' ||
          resSefin.codigoErro === 'E0710' ||
          resSefin.motivo?.includes('E0676') ||
          resSefin.motivo?.includes('E0710') ||
          resSefin.motivo?.includes('identificado como MEI') ||
          resSefin.motivo?.includes('Para MEI')
        ) {
          console.warn(
            `[PostgresEmissorDpsService] Prestador identificado como MEI na SEFIN (${resSefin.codigoErro || 'E0676/E0710'}). Ajustando perfil fiscal automaticamente para MEI e retransmitindo...`
          );
          prestadorConfig.regTrib.opSimpNac = 2;
          delete (prestadorConfig.regTrib as any).regApTribSN;
          await this.pool.query(
            `update medico_perfil_fiscal
             set opcao_simples_nacional = 'mei',
                 regime_apuracao_sn = null,
                 atualizado_em = now()
             where medico_id = $1`,
            [item.medicoId]
          );
          if (seq < MAX_INCREMENTOS_SEQUENCIA) {
            continue;
          }
        }

        if (
          resSefin.codigoErro === 'E0160' ||
          resSefin.motivo?.includes('E0160') ||
          resSefin.motivo?.includes('opção de situação perante o Simples Nacional')
        ) {
          const eraMei = prestadorConfig.regTrib.opSimpNac === 2;
          if (eraMei) {
            console.warn(
              `[PostgresEmissorDpsService] Prestador não é MEI no mês de competência (E0160). Ajustando perfil fiscal automaticamente para ME/EPP (opSimpNac = 3) e retransmitindo...`
            );
            prestadorConfig.regTrib.opSimpNac = 3;
            prestadorConfig.regTrib.regApTribSN = 1;
            await this.pool.query(
              `update medico_perfil_fiscal
               set opcao_simples_nacional = 'me_epp',
                   regime_apuracao_sn = 'regime_1',
                   atualizado_em = now()
               where medico_id = $1`,
              [item.medicoId]
            );
          } else {
            console.warn(
              `[PostgresEmissorDpsService] Prestador não é ME/EPP no mês de competência (E0160). Ajustando perfil fiscal automaticamente para MEI (opSimpNac = 2) e retransmitindo...`
            );
            prestadorConfig.regTrib.opSimpNac = 2;
            delete (prestadorConfig.regTrib as any).regApTribSN;
            await this.pool.query(
              `update medico_perfil_fiscal
               set opcao_simples_nacional = 'mei',
                   regime_apuracao_sn = null,
                   atualizado_em = now()
               where medico_id = $1`,
              [item.medicoId]
            );
          }
          if (seq < MAX_INCREMENTOS_SEQUENCIA) {
            continue;
          }
        }

        break;
      }

      if (!resSefinFinal || !resSefinFinal.sucesso) {
        return {
          sucesso: false,
          erro: resSefinFinal?.motivo || 'Erro na transmissão à SEFIN',
          codigoErroSefin: resSefinFinal?.codigoErro,
          httpStatus: resSefinFinal?.httpStatus,
          xmlDpsOriginal: correcao ? undefined : xmlDpsOriginal,
          falhaAntesDoEnvio: resSefinFinal?.falhaAntesDoEnvio,
          contextoTecnico: {
            origem: preparacao?.ok ? preparacao.origem : undefined,
            dataGeracao: dataGeracao.toISOString(),
            provedor: 'sefin_nacional', municipio: prestadorConfig.codMunicipio,
            ambiente: prestadorConfig.ambiente, ndps: ndpsAtual, serie: prestadorConfig.serie,
            valorCentavos: item.valorServicoCentavos, ctribNac: item.ctribNac,
            cnbs: emissaoInput.cNBS, cclassTrib: emissaoInput.cClassTrib, cindOp: emissaoInput.cIndOp
          },
          respostaSefinRaw: resSefinFinal?.respostaRaw
        };
      }

      chaveAcessoFinal = resSefinFinal.chaveAcesso;
      respostaSefinRaw = resSefinFinal.respostaRaw;
      xmlAutorizadoFinal = resSefinFinal.xmlAutorizado;
      dataEmissaoFinal = resSefinFinal.dataAutorizacao;
    } else {
      // Modo de simulação local (quando executado sem credenciais do Supabase/SEFIN)
      emissaoInput.nDPS = String(ndpsAtual);
      const layoutDps = montarDps(emissaoInput, prestadorConfig);
      chaveAcessoFinal = comporChaveAcessoNacional({
        codIbgeMunicipio: prestadorConfig.codMunicipio,
        ambiente: prestadorConfig.ambiente === 1 ? 'producao' : 'homologacao',
        anoMes,
        cnpjOuCpf: prestadorConfig.cnpj,
        serie: prestadorConfig.serie || '00001',
        ndps: ndpsAtual
      });
      respostaSefinRaw = { layoutDps };
    }

    const valorServico = item.valorServicoCentavos / 100;
    const aliquotaIss = this.preparacaoFiscalAtiva ? undefined : 2.0;
    const issApurado = aliquotaIss === undefined ? undefined : (valorServico * aliquotaIss) / 100;

    const dadosDanfse = {
      chaveAcesso: chaveAcessoFinal,
      numero: String(ndpsAtual),
      serie: prestadorConfig.serie || '00001',
      competencia: anoMes,
      dataEmissao: dataEmissaoFinal.toISOString(),
      ambiente: (prestadorConfig.ambiente === 1 ? 'producao' : 'homologacao') as 'producao' | 'homologacao',
      prestador: {
        razaoSocial: prestadorConfig.razaoSocial,
        nomeFantasia: prestadorConfig.nomeFantasia,
        cnpj: prestadorConfig.cnpj,
        inscricaoMunicipal: prestadorConfig.im,
        municipio: prestadorConfig.codMunicipio,
        uf: prestadorConfig.uf,
        telefone: prestadorConfig.telefone,
        email: prestadorConfig.email,
        simplesNacional: prestadorConfig.regTrib.opSimpNac !== 1
      },
      tomador: {
        nome: tomador.nome!,
        cpf: tomador.cpf,
        telefone: tomador.telefone,
        endereco: tomador.enderecoCompleto
      },
      servico: {
        municipioPrestacao: emissaoInput.fiscal?.municipioPrestacao,
        ufPrestacao: emissaoInput.fiscal ? inferirUfDeMunicipioIbge(emissaoInput.fiscal.municipioPrestacao) ?? undefined : undefined,
        tipoTributacao: emissaoInput.fiscal ? 'Operação Tributável' : undefined,
        tipoRetencao: emissaoInput.fiscal ? 'Não Retido' : undefined,
        cTribNac: emissaoInput.cTribNac,
        cNBS: emissaoInput.cNBS || undefined,
        discriminacao: item.xdescServ,
        valor: valorServico,
        aliquota: aliquotaIss,
        issApurado,
        cstIbsCbs: this.preparacaoFiscalAtiva ? emissaoInput.fiscal?.ibscbs?.CST : '000 - Tributável Integralmente',
        cClassTrib: this.preparacaoFiscalAtiva ? emissaoInput.fiscal?.ibscbs?.cClassTrib : emissaoInput.cClassTrib,
        cIndOp: this.preparacaoFiscalAtiva ? emissaoInput.fiscal?.ibscbs?.cIndOp : emissaoInput.cIndOp
      }
    };

    let pdfBytes: Uint8Array | Buffer | undefined;

    if (!item.emissaoComprovante && this.meuDanfeClient && (!this.preparacaoFiscalAtiva || xmlAutorizadoFinal)) {
      try {
        const xmlString = xmlAutorizadoFinal || montarXmlNfse({
          chaveAcesso: chaveAcessoFinal,
          numero: String(ndpsAtual),
          serie: prestadorConfig.serie || '00001',
          competencia: anoMes,
          dataEmissao: dadosDanfse.dataEmissao,
          codigoMunicipio: prestadorConfig.codMunicipio,
          prestador: dadosDanfse.prestador,
          tomador: dadosDanfse.tomador,
          servico: { ...dadosDanfse.servico, aliquota: aliquotaIss ?? 0, issApurado: issApurado ?? 0 }
        });

        const resMeuDanfe = await this.meuDanfeClient.converterXmlParaPdf(xmlString);
        if (resMeuDanfe.sucesso && resMeuDanfe.pdfBytes) {
          pdfBytes = resMeuDanfe.pdfBytes;
        }
      } catch {
        // Fallback silencioso para o gerador vetorial nativo
      }
    }

    if (!pdfBytes) {
      try { pdfBytes = await generateDanfsePdf(dadosDanfse); }
      catch (erro) {
        if (!item.emissaoComprovante) throw erro;
        // A autorização fiscal já ocorreu; conservar XML e nota para entrega posterior.
      }
    }

    const xmlStoragePath = `notas/${item.medicoId}/${anoMes}/${chaveAcessoFinal}.xml`;
    if (this.supabaseClient && xmlAutorizadoFinal) {
      try {
        await this.supabaseClient.storage
          .from('notas')
          .upload(xmlStoragePath, Buffer.from(xmlAutorizadoFinal, 'utf-8'), {
            contentType: 'application/xml',
            upsert: true
          });
      } catch (err: any) {
        console.warn('[PostgresEmissorDpsService] Aviso ao gravar XML no Storage:', err?.message || err);
      }
    }

    const pdfBase64 = pdfBytes ? `data:application/pdf;base64,${Buffer.from(pdfBytes).toString('base64')}` : null;

    return {
      sucesso: true,
      chaveAcesso: chaveAcessoFinal,
      ndps: ndpsAtual,
      serie: prestadorConfig.serie || '00001',
      competencia: anoMes,
      dataEmissao: dataEmissaoFinal,
      valorServicosCentavos: item.valorServicoCentavos,
      xmlStoragePath,
      pdfStoragePath: pdfBase64,
      respostaSefinRaw: preparacao?.ok ? { ...respostaSefinRaw, _notoPreparacao: preparacao.origem } : respostaSefinRaw
    };
  }

  private async carregarPerfilFiscal(medicoId: string): Promise<ConfigPrestadorCompleto | null> {
    const sql = `
      select
        m.nome_completo,
        pf.razao_social,
        pf.nome_fantasia,
        pgp_sym_decrypt(pf.cpf_cnpj_encriptado, $2) as documento_limpo,
        pf.inscricao_municipal,
        pf.uf,
        pf.cod_municipio_ibge,
        pf.serie_dps,
        pf.proximo_numero_dps,
        pf.ambiente,
        pf.opcao_simples_nacional,
        pf.regime_apuracao_sn,
        pf.regime_especial_tributacao,
        pf.percentual_tot_trib_sn,
        pf.dados_reforma_tributaria,
        u.email,
        u.telefone
      from medico_perfil_fiscal pf
      join medicos m on m.id = pf.medico_id
      join usuarios u on u.id = m.usuario_id
      where pf.medico_id = $1
      limit 1
    `;
    const { rows } = await this.pool.query(sql, [medicoId, this.chaveCriptografia]);
    if (rows.length === 0) return null;

    const r = rows[0];
    const opSimpNacMap: Record<string, 1 | 2 | 3> = { nao_optante: 1, mei: 2, me_epp: 3 };
    const regApMap: Record<string, 1 | 2 | 3> = { regime_1: 1, regime_2: 2, regime_3: 3 };

    return {
      referenciaImportada: r.dados_reforma_tributaria?.versao === 2,
      cnpj: r.documento_limpo,
      im: r.inscricao_municipal,
      codMunicipio: r.cod_municipio_ibge,
      ambiente: (this.preparacaoFiscalAtiva ? ({ producao: 1, homologacao: 2 } as any)[r.ambiente] : r.ambiente === 'producao' ? 1 : 2),
      serie: this.preparacaoFiscalAtiva ? r.serie_dps : r.serie_dps || '00001',
      razaoSocial: r.razao_social || r.nome_completo,
      nomeFantasia: r.nome_fantasia || undefined,
      uf: this.preparacaoFiscalAtiva ? r.uf : r.uf || 'RS',
      email: r.email,
      telefone: r.telefone,
      proximoNumeroDps: r.proximo_numero_dps ? Number(r.proximo_numero_dps) : undefined,
      regTrib: {
        opSimpNac: opSimpNacMap[r.opcao_simples_nacional] || 3,
        regApTribSN: regApMap[r.regime_apuracao_sn] || 1,
        regEspTrib: (r.regime_especial_tributacao ?? 0) as any
      },
      pTotTribSN: Number(r.percentual_tot_trib_sn || 6.0)
    };
  }

  private async carregarDadosTomador(pacienteId: string): Promise<{
    cpf: string;
    nome: string | null;
    nomeValidado?: boolean;
    telefone?: string;
    enderecoCompleto?: string;
    endereco?: any;
  } | null> {
    const sql = `
      select
        pgp_sym_decrypt(cpf_cnpj_encriptado, $2) as cpf_limpo,
        nome, nome_validado, telefone, cep, cod_municipio_ibge, logradouro, numero, complemento, bairro
      from pacientes
      where id = $1
      limit 1
    `;
    const { rows } = await this.pool.query(sql, [pacienteId, this.chaveCriptografia]);
    if (rows.length === 0) return null;

    const r = rows[0];
    let endereco = undefined;
    let enderecoCompleto = undefined;

    if (r.cod_municipio_ibge && r.cep && r.logradouro && r.numero && r.bairro) {
      endereco = {
        cMun: r.cod_municipio_ibge,
        CEP: r.cep.replace(/\D/g, ''),
        xLgr: r.logradouro,
        nro: r.numero,
        xCpl: r.complemento || undefined,
        xBairro: r.bairro
      };
      enderecoCompleto = `${r.logradouro}, ${r.numero}${r.complemento ? ' - ' + r.complemento : ''}, ${r.bairro}`;
    }

    return {
      cpf: r.cpf_limpo,
      nome: r.nome,
      nomeValidado: Boolean(r.nome_validado),
      telefone: r.telefone || undefined,
      enderecoCompleto,
      endereco
    };
  }

  private async obterProximoNdps(medicoId: string, numeroConfigurado?: number): Promise<number> {
    const sql = `select coalesce(max(ndps), 0) + 1 as proximo from notas_fiscais where medico_id = $1`;
    const { rows } = await this.pool.query(sql, [medicoId]);
    const proximoLocal = Number.parseInt(rows[0].proximo, 10);
    return Math.max(proximoLocal, numeroConfigurado || 1);
  }
}
