import { createHmac } from 'node:crypto';
import type { ResultadoFonteAgenda } from '../agenda/fonte-agenda.js';
import type { ProximaAcaoNoto } from '../onboarding/regras/decidir-proxima-acao.js';
import { validarCpf } from '../paciente/validar-cpf.js';
import type { ConsultaEmAbertoRegistro } from './atendimento-repositorio.js';
import type { DadosMensagemEvolution } from '../whatsapp/payload-webhook-schema.js';

type CampoComprovante = 'valorCentavos' | 'dataPagamento' | 'nomePagador' | 'nomeFavorecido';
// Definido pelo dono: escala de 0 a 1, mínimo inclusivo para todos os campos obrigatórios.
export const CONFIANCA_MINIMA_COMPROVANTE = 0.90;

export interface CamposComprovante {
  comprovanteHash?: string;
  nomePagadorHash?: string;
  nomeFavorecidoHash?: string;
  valorCentavos?: number | null;
  dataPagamento?: string | null;
  nomePagador?: string | null;
  nomeFavorecido?: string | null;
  confianca?: Partial<Record<CampoComprovante, number>>;
}
export type ResultadoExtracaoComprovante =
  | { tipo: 'extraido'; campos: CamposComprovante }
  | { tipo: 'ilegivel' }
  | { tipo: 'pdf_nao_suportado' }
  | { tipo: 'nao_comprovante' };
export interface ExtratorComprovante {
  extrair(mensagem: DadosMensagemEvolution): Promise<ResultadoExtracaoComprovante>;
}
export interface EstadoPedidoComprovante {
  medicoId: string;
  duvidaVinculo?: string;
  consulta?: { fonte: string; idExterno: string; dataHora: string; valorConsultaCentavos: number | null };
  paciente: { nome: string | null; cpf: string | null };
  ultimaConsulta: Pick<ConsultaEmAbertoRegistro, 'valorConsultaCentavos'> | null;
}
export interface LeitorEstadoPedidoComprovante {
  lerEstado(medicoId: string, pacienteId: string): Promise<EstadoPedidoComprovante>;
}
export type DecisaoPedidoComprovante =
  | (Extract<ProximaAcaoNoto, { tipo: 'pedir_agenda' }> & { motivo: 'SEM_AGENDA_CONECTADA' })
  | { tipo: 'nenhuma'; motivo: 'COMPROVANTE_JA_PROCESSADO' | 'AUDITORIA_FALHOU' }
  | { tipo: 'perguntar_medico'; motivo: 'VINCULO_TELEFONE_INDEFINIDO' | 'CONSULTA_AMBIGUA_OU_AUSENTE' | 'LEITURA_INDISPONIVEL' | 'COMPROVANTE_ILEGIVEL' | 'NAO_COMPROVANTE'
      | 'CAMPO_OBRIGATORIO_AUSENTE' | 'CONFIANCA_INSUFICIENTE' | 'CADASTRO_INCOMPLETO' | 'VALOR_DIVERGENTE' | 'PDF_NAO_SUPORTADO' | 'FONTE_INDISPONIVEL' | 'ACESSO_EXPIRADO' }
  | { tipo: 'perguntar_pacote'; motivo: 'VALOR_MULTIPLO_CONSULTA' }
  | { tipo: 'pedido_nota_pronto'; motivo: 'VALOR_IGUAL_ULTIMA_CONSULTA'; pedido: {
      medicoId: string; valorCentavos: number; dataPagamento: string;
      paciente: { nome: string; cpf: string }; observacao?: { pagador: string };
    } };
export interface AuditoriaComprovante {
  lido: ResultadoExtracaoComprovante | null;
  estado: EstadoPedidoComprovante & { nomePresente?: boolean; cpfValido?: boolean; pacienteHash?: string; consultaChave?: string };
  decisao: Pick<DecisaoPedidoComprovante, 'tipo' | 'motivo'> & { pedidoHash?: string };
}

export function decidirPedidoComprovante(
  lido: ResultadoExtracaoComprovante | null,
  estado: EstadoPedidoComprovante,
  processados: Array<ResultadoExtracaoComprovante | null>,
  agenda?: ResultadoFonteAgenda
): DecisaoPedidoComprovante {
  if (agenda?.tipo === 'erro') {
    if (agenda.codigo === 'SEM_AGENDA_CONECTADA') return { tipo: 'pedir_agenda', agendaInformada: null, motivo: agenda.codigo };
    return { tipo: 'perguntar_medico', motivo: agenda.codigo };
  }
  if (estado.duvidaVinculo === 'VINCULO_TELEFONE_INDEFINIDO' || estado.duvidaVinculo === 'CONSULTA_AMBIGUA_OU_AUSENTE') return { tipo: 'perguntar_medico', motivo: estado.duvidaVinculo };
  if (!lido) return { tipo: 'perguntar_medico', motivo: 'LEITURA_INDISPONIVEL' };
  if (lido.tipo === 'pdf_nao_suportado') return { tipo: 'perguntar_medico', motivo: 'PDF_NAO_SUPORTADO' };
  if (lido.tipo === 'ilegivel') return { tipo: 'perguntar_medico', motivo: 'COMPROVANTE_ILEGIVEL' };
  if (lido.tipo === 'nao_comprovante') return { tipo: 'perguntar_medico', motivo: 'NAO_COMPROVANTE' };
  const { valorCentavos, dataPagamento, nomePagador, nomeFavorecido, confianca } = lido.campos;
  if (valorCentavos == null || !dataPagamento?.trim() || !nomePagador?.trim() || !nomeFavorecido?.trim()) {
    return { tipo: 'perguntar_medico', motivo: 'CAMPO_OBRIGATORIO_AUSENTE' };
  }
  if (processados.some(anterior => anterior?.tipo === 'extraido' && anterior.campos.valorCentavos === valorCentavos &&
      anterior.campos.dataPagamento === dataPagamento && anterior.campos.nomePagador === nomePagador)) {
    return { tipo: 'nenhuma', motivo: 'COMPROVANTE_JA_PROCESSADO' };
  }
  const campos: CampoComprovante[] = ['valorCentavos', 'dataPagamento', 'nomePagador', 'nomeFavorecido'];
  if (campos.some(campo => {
    const valor = confianca?.[campo];
    return typeof valor !== 'number' || !Number.isFinite(valor) || valor < CONFIANCA_MINIMA_COMPROVANTE || valor > 1;
  })) return { tipo: 'perguntar_medico', motivo: 'CONFIANCA_INSUFICIENTE' };
  const valorConsulta = estado.ultimaConsulta?.valorConsultaCentavos;
  if (!estado.paciente.nome?.trim() || !estado.paciente.cpf || !validarCpf(estado.paciente.cpf) ||
      !valorConsulta || !Number.isSafeInteger(valorConsulta) || valorConsulta < 0) {
    return { tipo: 'perguntar_medico', motivo: 'CADASTRO_INCOMPLETO' };
  }
  if (!Number.isSafeInteger(valorCentavos) || valorCentavos <= 0) return { tipo: 'perguntar_medico', motivo: 'VALOR_DIVERGENTE' };
  if (valorCentavos === valorConsulta) return { tipo: 'pedido_nota_pronto', motivo: 'VALOR_IGUAL_ULTIMA_CONSULTA', pedido: {
    medicoId: estado.medicoId, valorCentavos, dataPagamento,
    paciente: { nome: estado.paciente.nome, cpf: estado.paciente.cpf },
    ...(nomePagador === estado.paciente.nome ? {} : { observacao: { pagador: nomePagador } })
  } };
  if (valorCentavos >= valorConsulta * 2 && valorCentavos % valorConsulta === 0) {
    return { tipo: 'perguntar_pacote', motivo: 'VALOR_MULTIPLO_CONSULTA' };
  }
  return { tipo: 'perguntar_medico', motivo: 'VALOR_DIVERGENTE' };
}

export function chaveConsulta(pepper: string, medicoId: string, fonte: string, idExterno: string): string {
  return createHmac('sha256', pepper).update(JSON.stringify([medicoId, fonte, idExterno])).digest('hex');
}
export function chaveComprovante(pepper: string, lido: ResultadoExtracaoComprovante | null): string | null {
  if (lido?.tipo !== 'extraido') return null;
  return createHmac('sha256', pepper).update(JSON.stringify([lido.campos.valorCentavos, lido.campos.dataPagamento, lido.campos.nomePagador])).digest('hex');
}
export function hashPedidoComprovante(pepper: string, pedido: Extract<DecisaoPedidoComprovante, { tipo: 'pedido_nota_pronto' }>['pedido']): string {
  return createHmac('sha256', pepper).update(JSON.stringify(pedido)).digest('hex');
}
export function auditarComprovante(pepper: string, estado: EstadoPedidoComprovante, lido: ResultadoExtracaoComprovante | null, decisao: DecisaoPedidoComprovante): AuditoriaComprovante {
  const hash = (valor: unknown) => createHmac('sha256', pepper).update(JSON.stringify(valor ?? null)).digest('hex');
  return {
    estado: { medicoId: estado.medicoId, paciente: { nome: null, cpf: null }, ultimaConsulta: null,
      nomePresente: !!estado.paciente.nome?.trim(), cpfValido: !!estado.paciente.cpf && validarCpf(estado.paciente.cpf),
      pacienteHash: hash([estado.paciente.nome, estado.paciente.cpf]),
      ...(estado.consulta ? { consultaChave: chaveConsulta(pepper, estado.medicoId, estado.consulta.fonte, estado.consulta.idExterno) } : {}) },
    lido: lido?.tipo === 'extraido' ? { tipo: 'extraido', campos: { comprovanteHash: chaveComprovante(pepper, lido)!,
      nomePagadorHash: hash(lido.campos.nomePagador), nomeFavorecidoHash: hash(lido.campos.nomeFavorecido), confianca: Object.fromEntries(
        (['valorCentavos', 'dataPagamento', 'nomePagador', 'nomeFavorecido'] as const).flatMap(campo => {
          const valor = lido.campos.confianca?.[campo];
          return typeof valor === 'number' && Number.isFinite(valor) ? [[campo, valor]] : [];
        })) } } : lido ? { tipo: lido.tipo } : null,
    decisao: { tipo: decisao.tipo, motivo: decisao.motivo, ...(decisao.tipo === 'pedir_agenda' ? { agendaInformada: null } : {}), ...(decisao.tipo === 'pedido_nota_pronto' ? { pedidoHash: hashPedidoComprovante(pepper, decisao.pedido) } : {}) }
  };
}
