/**
 * Regras puras para decidir a próxima etapa de um caso de emissão de NFS-e
 * no WhatsApp, combinando as 5 preferências da conta, prontidão fiscal real
 * (Certificado A1 + dados tributários) e trava de ambiente (homologação padrão).
 */

import type { PreferenciasEmissaoConta } from '../conta/preferencias-emissao.js';
import { validarCpf } from '../paciente/validar-cpf.js';

export interface ProntidaoFiscalEmissao {
  certificadoValido: boolean;
  dadosFiscaisProntos: boolean;
  ambiente: 'homologacao' | 'producao';
  producaoLiberadaNaConta: boolean;
}

export interface ContextoDecisaoEmissao {
  pacienteNome: string | null;
  pacienteCpf: string | null;
  pacienteTelefone: string | null;
  valorCentavos: number | null;
  dataConsulta: string | null;
  matchAmbiguoOuDivergente: boolean;
  aprovadoPeloMedico: boolean;
  instanciaConsultorioConectada: boolean;
  preferencias: PreferenciasEmissaoConta;
  prontidaoFiscal: ProntidaoFiscalEmissao;
}

export type DecisaoProximoPassoEmissao =
  | { acao: 'esclarecer_com_medico'; motivo: 'PACIENTE_OU_CONSULTA_INDEFINIDA' | 'VALOR_AUSENTE' | 'MATCH_AMBIGUO_OU_DIVERGENTE' }
  | { acao: 'solicitar_cpf_paciente' }
  | { acao: 'solicitar_cpf_medico' }
  | { acao: 'aguardar_aprovacao_medico' }
  | { acao: 'aguardar_prontidao_fiscal'; motivo: 'CERTIFICADO_A1_PENDENTE' | 'DADOS_FISCAIS_PENDENTES' | 'PRODUCAO_NAO_LIBERADA' }
  | { acao: 'pronto_para_enfileirar'; ambiente: 'homologacao' | 'producao' };

export function decidirProximoPassoEmissao(ctx: ContextoDecisaoEmissao): DecisaoProximoPassoEmissao {
  if (ctx.matchAmbiguoOuDivergente) {
    return { acao: 'esclarecer_com_medico', motivo: 'MATCH_AMBIGUO_OU_DIVERGENTE' };
  }
  if (!ctx.pacienteNome?.trim() || !ctx.dataConsulta?.trim()) {
    return { acao: 'esclarecer_com_medico', motivo: 'PACIENTE_OU_CONSULTA_INDEFINIDA' };
  }
  if (!ctx.valorCentavos || !Number.isSafeInteger(ctx.valorCentavos) || ctx.valorCentavos <= 0) {
    return { acao: 'esclarecer_com_medico', motivo: 'VALOR_AUSENTE' };
  }

  const cpfValido = validarCpf(ctx.pacienteCpf);
  if (!cpfValido) {
    const podePedirPaciente = ctx.preferencias.solicitarCpfDiretoPaciente === true
      && ctx.instanciaConsultorioConectada
      && Boolean(ctx.pacienteTelefone?.replace(/\D/g, '').length);
    return podePedirPaciente ? { acao: 'solicitar_cpf_paciente' } : { acao: 'solicitar_cpf_medico' };
  }

  // Por padrão (ou quando ainda não configurado), exige aprovação explícita do médico.
  const precisaAprovar = ctx.preferencias.pedirAprovacaoAntesDeEmitir !== false;
  if (precisaAprovar && !ctx.aprovadoPeloMedico) {
    return { acao: 'aguardar_aprovacao_medico' };
  }

  if (!ctx.prontidaoFiscal.certificadoValido) {
    return { acao: 'aguardar_prontidao_fiscal', motivo: 'CERTIFICADO_A1_PENDENTE' };
  }
  if (!ctx.prontidaoFiscal.dadosFiscaisProntos) {
    return { acao: 'aguardar_prontidao_fiscal', motivo: 'DADOS_FISCAIS_PENDENTES' };
  }
  if (ctx.prontidaoFiscal.ambiente === 'producao' && !ctx.prontidaoFiscal.producaoLiberadaNaConta) {
    return { acao: 'aguardar_prontidao_fiscal', motivo: 'PRODUCAO_NAO_LIBERADA' };
  }

  return { acao: 'pronto_para_enfileirar', ambiente: ctx.prontidaoFiscal.ambiente };
}
