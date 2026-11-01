import { createHmac } from 'node:crypto';

export interface ConsultaFiscalEfemera {
  contaId: string;
  medicoId: string;
  origemAgenda: string;
  referenciaConsulta: string;
  inicioConsulta: string;
  profissionalConfirmado: boolean;
  tomador: { nome?: string; cpfCnpj?: string; endereco?: unknown };
  valorCentavos: number;
}

export type EscolhaAgrupamento = 'agrupar' | 'separar';
export type DuracaoEscolha = 'somente_esta_vez' | 'sempre';
export interface PreferenciaAgrupamento {
  contaId: string;
  medicoId?: string;
  contexto: 'consultas_mesmo_paciente_mesmo_dia';
  decisao: EscolhaAgrupamento;
  autorizadoPor: string;
}

export function chaveConsultaFiscal(consulta: ConsultaFiscalEfemera, segredo: string): string {
  if (!consulta.medicoId || !consulta.origemAgenda || !consulta.referenciaConsulta ||
      !consulta.inicioConsulta || !consulta.profissionalConfirmado) {
    throw new Error('Consulta sem identificação profissional e referência de agenda confirmadas');
  }
  if (!Number.isInteger(consulta.valorCentavos) || consulta.valorCentavos < 0) {
    throw new Error('Valor de consulta inválido');
  }
  if (segredo.length < 32) throw new Error('Segredo HMAC insuficiente');
  const data = new Date(consulta.inicioConsulta);
  if (Number.isNaN(data.getTime())) throw new Error('Data de consulta inválida');
  // No patient name, tax identifier, address or clinical description in persisted key.
  const canonical = JSON.stringify([1, consulta.medicoId, consulta.origemAgenda,
    consulta.referenciaConsulta, data.toISOString()]);
  return createHmac('sha256', segredo).update(canonical).digest('hex');
}

export function resolverAgrupamento(
  consultas: readonly ConsultaFiscalEfemera[],
  preferencia?: PreferenciaAgrupamento,
  mesmoTomadorConfirmado = false,
): { tipo: 'perguntar'; motivo: string } | { tipo: 'aplicar'; decisao: EscolhaAgrupamento } {
  if (consultas.length < 2) return { tipo: 'aplicar', decisao: 'separar' };\n  if (!mesmoTomadorConfirmado) return { tipo: 'perguntar', motivo: 'tomador_nao_confirmado' };
  if (consultas.some(c => !c.profissionalConfirmado)) {
    return { tipo: 'perguntar', motivo: 'profissional_nao_confirmado' };
  }
  if (new Set(consultas.map(c => c.medicoId)).size !== 1 ||
      new Set(consultas.map(c => c.contaId)).size !== 1) {
    return { tipo: 'perguntar', motivo: 'medicos_ou_contas_diferentes' };
  }
  if (!preferencia || preferencia.contaId !== consultas[0]!.contaId ||
      (preferencia.medicoId && preferencia.medicoId !== consultas[0]!.medicoId)) {
    return { tipo: 'perguntar', motivo: 'escolha_do_operador_necessaria' };
  }
  return { tipo: 'aplicar', decisao: preferencia.decisao };
}

export function registrarEscolha(
  decisao: EscolhaAgrupamento,
  duracao: DuracaoEscolha,
  contaId: string,
  medicoId: string,
  autorizadoPor: string,
): { persistir: false; decisao: EscolhaAgrupamento } | { persistir: true; preferencia: PreferenciaAgrupamento } {
  if (!contaId || !medicoId || !autorizadoPor) throw new Error('Operador autorizado obrigatório');
  if (duracao === 'somente_esta_vez') return { persistir: false, decisao };
  return { persistir: true, preferencia: {
    contaId, medicoId, contexto: 'consultas_mesmo_paciente_mesmo_dia', decisao, autorizadoPor,
  } };
}
