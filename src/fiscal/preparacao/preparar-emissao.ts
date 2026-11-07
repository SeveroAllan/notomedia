/**
 * Resolve os dados usando evidências persistidas; inconsistências viram pendências
 * estruturadas antes de carregar certificado, assinar ou transmitir uma DPS.
 */
import { parametrosEmissaoSchema, type PoliticaEmissao } from './parametros-emissao.js';
import { validarReferenciaFiscal, type ReferenciaFiscalPersistida } from './validar-referencia-fiscal.js';
import type { SolicitacaoEmissaoItem } from '../../worker/emissor-dps-service.js';
export interface PendenciaFiscal { campo: string; codigo: string; mensagem: string }
export interface EvidenciasEmissao {
  perfil: { ambiente: string; confirmado: boolean; opcao: string; regime: string | null; especial: number; municipio: string; serie: string; referencia: string | null; referenciaFiscal?: ReferenciaFiscalPersistida };
  servicos: Array<{ id: string; ctribNac: string; cnbs: string | null; ctribMun: string | null; politica: PoliticaEmissao | null }>;
  competenciaInformada: string | null;
  datasConsultas: string[];
}
export function prepararEmissao(item: SolicitacaoEmissaoItem, evidencias: EvidenciasEmissao, hoje: string, ambientePiloto?:'homologacao') {
  const pendencias: PendenciaFiscal[] = [];
  const adicionar = (campo: string, codigo: string, mensagem: string) => pendencias.push({ campo, codigo, mensagem });
  if (!evidencias.perfil.confirmado) adicionar('perfil', 'PERFIL_NAO_CONFIRMADO', 'Revisar e confirmar os parâmetros do emitente.');
  if (evidencias.servicos.length !== 1) adicionar('servico', 'SERVICO_AMBIGUO', 'Vincular um único serviço fiscal ativo a esta solicitação.');
  const servico = evidencias.servicos.length === 1 ? evidencias.servicos[0] : undefined;
  const politica = servico?.politica;
  const ambienteEscopado = ambientePiloto === 'homologacao' &&
    politica?.perfil?.ambiente === 'homologacao' && evidencias.perfil.ambiente === 'homologacao';
  const validado = parametrosEmissaoSchema.safeParse(politica?.parametros);
  if (!politica?.confirmadoEm || !Number.isFinite(Date.parse(politica.confirmadoEm)) || politica.origem !== 'revisao_onboarding') {
    adicionar('parametros', 'PARAMETROS_NAO_CONFIRMADOS', 'Revisar os parâmetros de emissão do serviço e confirmar sua validade.');
  }
  if (!validado.success) for (const erro of validado.error.issues) adicionar(erro.path.join('.'), 'PARAMETRO_INVALIDO', erro.message);
  if (validado.success) for (const erro of validarReferenciaFiscal(evidencias.perfil.referenciaFiscal,
    { ...politica, parametros: validado.data })) adicionar('referencia', 'REFERENCIA_PENDENTE', erro);
  // A competência segue o dia da emissão; datas de consultas ficam na descrição.
  // Valores históricos de competenciaInformada não alteram a regra atual.
  const competencia = hoje;
  if (!competencia || !/^\d{4}-\d{2}-\d{2}$/.test(competencia) || !Number.isFinite(Date.parse(competencia)) ||
      new Date(competencia).toISOString().slice(0, 10) !== competencia) {
    adicionar('competencia', 'COMPETENCIA_INDEFINIDA', 'Não foi possível determinar uma data válida para a emissão.');
  }
  if (validado.success && competencia && (competencia < validado.data.vigenciaInicio ||
      (validado.data.vigenciaFim && competencia > validado.data.vigenciaFim))) {
    adicionar('vigencia', 'FORA_DA_VIGENCIA', 'Revisar os parâmetros aplicáveis à competência da nota.');
  }
  if (politica && servico) {
    if (politica.ctribNac !== servico.ctribNac || politica.cnbs !== servico.cnbs || politica.ctribMun !== servico.ctribMun ||
        (item.ctribNac && item.ctribNac !== servico.ctribNac) || (item.cnbs && item.cnbs !== servico.cnbs)) {
      adicionar('servico', 'CLASSIFICACAO_DIVERGENTE', 'A classificação da solicitação, do serviço e da revisão fiscal precisa coincidir.');
    }
    const perfil = evidencias.perfil;
    for (const campo of ['ambiente', 'opcao', 'regime', 'especial', 'municipio', 'serie', 'referencia'] as const) {
      if (politica.perfil?.[campo] !== perfil[campo]) adicionar(`perfil.${campo}`, 'PERFIL_ALTERADO', 'O perfil mudou após a revisão dos parâmetros. Confirmar novamente.');
    }
    if (validado.success && ((!ambienteEscopado && validado.data.ambiente !== perfil.ambiente) || validado.data.opcaoSimplesNacional !== perfil.opcao ||
      validado.data.regimeEspecialTributacao !== perfil.especial ||
      (perfil.opcao === 'me_epp' && validado.data.regimeApuracaoSn !== perfil.regime))) {
      adicionar('regime', 'REGIME_DIVERGENTE', 'Os parâmetros confirmados precisam corresponder ao perfil fiscal.');
    }
  }
  if (!servico || !/^\d{6}$/.test(servico.ctribNac)) adicionar('ctribNac', 'CODIGO_INVALIDO', 'Informar o código nacional do serviço com seis dígitos.');
  if (servico?.cnbs && !/^\d{9}$/.test(servico.cnbs)) adicionar('cnbs', 'CODIGO_INVALIDO', 'Conferir o código NBS do serviço.');
  if (servico?.ctribMun && !/^\d{3}$/.test(servico.ctribMun)) adicionar('ctribMun', 'CODIGO_INVALIDO', 'Conferir o código municipal do serviço.');
  if ((item.cindOp && item.cindOp !== (validado.success ? validado.data.ibscbs?.cIndOp : undefined)) ||
      (item.cclassTrib && item.cclassTrib !== (validado.success ? validado.data.ibscbs?.cClassTrib : undefined))) {
    adicionar('IBSCBS', 'CLASSIFICACAO_DIVERGENTE', 'Os dados IBS/CBS da solicitação não correspondem à referência confirmada.');
  }
  if (!Number.isSafeInteger(item.valorServicoCentavos) || item.valorServicoCentavos <= 0) adicionar('valor', 'VALOR_INVALIDO', 'Informar o valor positivo do serviço em centavos.');
  if (!item.xdescServ.trim()) adicionar('descricao', 'DESCRICAO_AUSENTE', 'Informar a descrição do serviço realizado.');
  if (pendencias.length || !validado.success || !servico || !competencia) return { ok: false as const, pendencias };
  const parametros = ambienteEscopado ? {...validado.data,ambiente:'homologacao' as const} : validado.data;
  return { ok: true as const, parametros, competencia, servico,
    origem: { versao: 1, servicoId: servico.id, parametrosConfirmadosEm: politica!.confirmadoEm,
      referenciaHash: politica!.referenciaHash,
      competencia: 'data_emissao', classificacao: 'servico_revisado',
      dadosAplicados: { competencia, ctribNac: servico.ctribNac, cnbs: servico.cnbs, ctribMun: servico.ctribMun, parametros } } };
}
