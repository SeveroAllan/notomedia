/**
 * Caso de uso para emissão em lote por dia ou período na agenda conectada
 * (ex.: "emite as notas do dia 28 de setembro"). Lê os atendimentos já com
 * CPF, telefone e valor em uma única passagem pela agenda, ignora consultas
 * que já possuem nota e prepara/enfileira cada item conforme as preferências.
 */

import { formatarDataBr, type AtendimentoAgendaResumo } from '../agenda/filtrar-atendimentos-agenda.js';
import type { CasoEmissaoRepositorio, ChaveMensagemCaso } from './caso-emissao-repositorio.js';
import { chaveAtendimentoSemNota } from './cruzar-comprovante-agenda.js';
import { formatarValorReais } from './extrair-cpf-mensagem.js';
import type { ResultadoOperacaoEmissao } from './orquestrar-emissao-conta.js';

export interface ItemResultadoLoteEmissao {
  paciente: string;
  data: string;
  valorFormatado: string;
  acao: ResultadoOperacaoEmissao['acao'] | 'ja_emitida';
  motivo?: string;
}

export type ResultadoEmissaoLotePeriodo =
  | {
      ok: true;
      emAndamento: true;
      periodo: { inicio: string; fim: string };
      aviso: string;
    }
  | {
      ok: boolean;
      emAndamento?: false;
      periodo: { inicio: string; fim: string };
      totalEncontrados: number;
      enfileiradas: number;
      pendentes: number;
      jaEmitidas: number;
      itens: ItemResultadoLoteEmissao[];
      motivo?: string;
    };

export interface EmissaoLotePeriodoDeps {
  repositorio: CasoEmissaoRepositorio;
  obterAtendimentosDetalhados: (contaId: string, inicioIso: string, fimIso: string) => Promise<AtendimentoAgendaResumo[]>;
  prepararIndividual: (entrada: {
    contaId: string;
    pacienteNome: string;
    dataConsulta: string;
    valorCentavos?: number | null;
    pacienteCpf?: string | null;
    pacienteTelefone?: string | null;
    atendimentoExternoId?: string | null;
    jaDetalhado?: boolean;
    aprovadoAgora?: boolean;
    chaveMensagemMedico?: ChaveMensagemCaso | null;
  }) => Promise<ResultadoOperacaoEmissao>;
}

export function formatarResumoLoteWhatsApp(res: Extract<ResultadoEmissaoLotePeriodo, { emAndamento?: false }>): string {
  const periodoTxt = res.periodo.inicio === res.periodo.fim
    ? formatarDataBr(res.periodo.inicio)
    : `${formatarDataBr(res.periodo.inicio)} a ${formatarDataBr(res.periodo.fim)}`;
  if (!res.ok) {
    return `Tentei abrir sua agenda em ${periodoTxt}, mas a leitura da agenda oscilou agora e não consegui puxar os atendimentos. Quer que eu tente consultar esse dia novamente?`;
  }
  if (!res.totalEncontrados) {
    return `Olhei sua agenda em ${periodoTxt}, mas não encontrei consultas finalizadas para emitir.`;
  }

  const enfileiradas = res.itens.filter(i => i.acao === 'enfileirada');
  const jaEmitidas = res.itens.filter(i => i.acao === 'ja_emitida' || i.acao === 'duplicado');
  const pendentes = res.itens.filter(i => !['enfileirada', 'ja_emitida', 'duplicado'].includes(i.acao));
  const partes: string[] = [];

  if (enfileiradas.length) {
    const lista = enfileiradas.map(i => `${i.paciente} (${i.valorFormatado})`).join(', ');
    partes.push(`Já coloquei na fila de emissão (homologação) de ${periodoTxt}: ${lista}. Vou mandando os PDFs conforme saírem.`);
  }
  if (pendentes.length) {
    const detalhes = pendentes.map(i => {
      const motivo = i.acao === 'solicitar_cpf_paciente' ? 'pedi o CPF ao paciente'
        : i.acao === 'solicitar_cpf_medico' ? 'falta CPF'
        : i.acao === 'aguardar_aprovacao_medico' ? 'pronta aguardando seu OK'
        : i.acao === 'aguardar_prontidao_fiscal' ? 'falta Certificado A1/fiscal'
        : i.motivo === 'VALOR_AUSENTE' ? 'falta o valor'
        : 'precisa conferência';
      return `${i.paciente} (${i.valorFormatado}, ${motivo})`;
    }).join(', ');
    partes.push(`${enfileiradas.length ? 'Ficaram pendentes' : `Olhei ${periodoTxt} e ficaram pendentes`}: ${detalhes}.`);
  }
  if (jaEmitidas.length) {
    const nomes = jaEmitidas.map(i => i.paciente).join(', ');
    partes.push(`${jaEmitidas.length === 1 ? 'Já tinha nota emitida' : 'Já tinham nota emitida'}: ${nomes}.`);
  }
  return partes.join(' ');
}

export async function prepararEmissaoLotePeriodo(
  entrada: {
    contaId: string;
    dataInicio: string;
    dataFim: string;
    aprovadoAgora?: boolean;
    chaveMensagemMedico?: ChaveMensagemCaso | null;
  },
  deps: EmissaoLotePeriodoDeps
): Promise<Extract<ResultadoEmissaoLotePeriodo, { emAndamento?: false }>> {
  let todos: AtendimentoAgendaResumo[];
  let jaEmitidasSet: Set<string>;
  try {
    [todos, jaEmitidasSet] = await Promise.all([
      deps.obterAtendimentosDetalhados(entrada.contaId, entrada.dataInicio, entrada.dataFim),
      deps.repositorio.listarChavesConsultasComNota(entrada.contaId)
    ]);
  } catch (erro) {
    return {
      ok: false,
      periodo: { inicio: entrada.dataInicio, fim: entrada.dataFim },
      totalEncontrados: 0,
      enfileiradas: 0,
      pendentes: 0,
      jaEmitidas: 0,
      itens: [],
      motivo: erro instanceof Error && erro.message ? erro.message : 'LEITURA_AGENDA_INDISPONIVEL'
    };
  }

  const noPeriodo = todos
    .filter(a => {
      const dia = a.data.slice(0, 10);
      return dia >= entrada.dataInicio && dia <= entrada.dataFim;
    })
    .sort((a, b) => a.data.localeCompare(b.data));

  if (!noPeriodo.length) {
    return {
      ok: true,
      periodo: { inicio: entrada.dataInicio, fim: entrada.dataFim },
      totalEncontrados: 0,
      enfileiradas: 0,
      pendentes: 0,
      jaEmitidas: 0,
      itens: []
    };
  }

  const itens: ItemResultadoLoteEmissao[] = [];
  let enfileiradas = 0;
  let pendentes = 0;
  let jaEmitidas = 0;

  for (const atend of noPeriodo.slice(0, 15)) {
    const dia = atend.data.slice(0, 10);
    const jaTem = (atend.atendimentoId && jaEmitidasSet.has(atend.atendimentoId))
      || jaEmitidasSet.has(chaveAtendimentoSemNota(atend.paciente, dia));
    if (jaTem) {
      jaEmitidas++;
      itens.push({ paciente: atend.paciente, data: formatarDataBr(dia), valorFormatado: formatarValorReais(atend.valorCentavos), acao: 'ja_emitida' });
      continue;
    }

    const r = await deps.prepararIndividual({
      contaId: entrada.contaId,
      pacienteNome: atend.paciente,
      dataConsulta: dia,
      valorCentavos: atend.valorCentavos ?? null,
      pacienteCpf: atend.cpf ?? null,
      pacienteTelefone: atend.telefone ?? null,
      atendimentoExternoId: atend.atendimentoId ?? null,
      jaDetalhado: true,
      aprovadoAgora: entrada.aprovadoAgora,
      chaveMensagemMedico: entrada.chaveMensagemMedico
    });

    if (r.acao === 'enfileirada') enfileiradas++;
    else if (r.acao === 'duplicado') jaEmitidas++;
    else pendentes++;

    itens.push({
      paciente: atend.paciente,
      data: formatarDataBr(dia),
      valorFormatado: formatarValorReais(r.caso?.valorCentavos ?? atend.valorCentavos),
      acao: r.acao,
      motivo: r.motivo
    });
  }

  return {
    ok: true,
    periodo: { inicio: entrada.dataInicio, fim: entrada.dataFim },
    totalEncontrados: noPeriodo.length,
    enfileiradas,
    pendentes,
    jaEmitidas,
    itens
  };
}
