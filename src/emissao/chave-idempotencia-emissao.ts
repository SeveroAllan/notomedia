/**
 * Helpers puros para gerar chaves determinísticas de idempotência anti-duplicidade
 * e formatar resumos sanitizados (com CPF mascarado) dos casos de emissão para
 * o agente IA e notificações no WhatsApp.
 */

import { createHash } from 'node:crypto';
import type { DadosComprovanteExtraido } from '../midia/midia-tipos.js';
import type { CasoEmissaoRegistro } from './caso-emissao-repositorio.js';
import { normalizarNomeParaBusca } from './cruzar-comprovante-agenda.js';
import { formatarValorReais, mascararCpfParaChat } from './extrair-cpf-mensagem.js';
import { formatarDataBr } from '../agenda/filtrar-atendimentos-agenda.js';

export function gerarChaveIdempotenciaComprovante(
  comprovante: DadosComprovanteExtraido,
  fallbackIdMensagem: string
): string {
  if (comprovante.identificadorTransacao?.trim()) {
    const e2e = comprovante.identificadorTransacao.trim().toLowerCase();
    return createHash('sha256').update(`tx:${e2e}`).digest('hex').slice(0, 32);
  }
  const base = [
    comprovante.valorCentavos ?? 0,
    comprovante.dataPagamento ?? '',
    normalizarNomeParaBusca(comprovante.nomePagador ?? ''),
    fallbackIdMensagem
  ].join('|');
  return createHash('sha256').update(`comp:${base}`).digest('hex').slice(0, 32);
}

export function gerarChaveIdempotenciaPedido(entrada: {
  atendimentoExternoId?: string | null;
  pacienteNome: string;
  dataConsulta: string;
  valorCentavos: number;
}): string {
  const base = entrada.atendimentoExternoId
    ? `atend:${entrada.atendimentoExternoId}`
    : `ped:${normalizarNomeParaBusca(entrada.pacienteNome)}|${entrada.dataConsulta.slice(0, 10)}|${entrada.valorCentavos}`;
  return createHash('sha256').update(base).digest('hex').slice(0, 32);
}

export function resumirCasoParaAgente(caso: CasoEmissaoRegistro) {
  return {
    casoId: caso.id,
    origem: caso.origem,
    estado: caso.estado,
    pacienteNome: caso.pacienteNome,
    pacienteCpfMascarado: mascararCpfParaChat(caso.pacienteCpf),
    possuiCpf: Boolean(caso.pacienteCpf),
    pagadorNome: caso.pagadorNome,
    dataConsulta: caso.dataConsulta ? formatarDataBr(caso.dataConsulta) : null,
    dataConsultaIso: caso.dataConsulta,
    valorFormatado: formatarValorReais(caso.valorCentavos),
    valorCentavos: caso.valorCentavos,
    ambiente: caso.ambiente,
    aprovadoPeloMedico: caso.aprovadoPeloMedico,
    solicitacaoId: caso.solicitacaoId,
    erroMotivo: caso.erroMotivo
  };
}
