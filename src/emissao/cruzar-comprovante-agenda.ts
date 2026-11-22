/**
 * Regras puras para cruzar um comprovante de pagamento com atendimentos da
 * agenda médica nos dias anteriores, ignorando consultas que já têm nota
 * emitida/enfileirada e aplicando vínculos de pagadores secundários já salvos.
 */

import type { AtendimentoAgendaResumo } from '../agenda/filtrar-atendimentos-agenda.js';
import type { DadosComprovanteExtraido } from '../midia/midia-tipos.js';

export const JANELA_DIAS_BUSCA_COMPROVANTE = 30;
export const TOLERANCIA_DIAS_APOS_COMPROVANTE = 2;

export interface PagadorSecundarioSalvo {
  id: string;
  pagadorNomeNormalizado: string;
  pagadorCpfHash?: string | null;
  pacienteNome: string;
  pacienteTelefone?: string | null;
  emitirNoCpfDe: 'paciente' | 'pagador';
}

export interface EntradaCruzamentoComprovante {
  comprovante: DadosComprovanteExtraido;
  dataReferenciaIso: string;
  atendimentosAgenda: readonly AtendimentoAgendaResumo[];
  /** Chaves já emitidas/enfileiradas (atendimentoId ou chaveConsultaNormalizada). */
  chavesJaEmitidas: ReadonlySet<string>;
  pagadoresSecundarios: readonly PagadorSecundarioSalvo[];
  telefoneRemetente?: string | null;
  cpfPagadorHash?: string | null;
  janelaDiasAnteriores?: number;
}

export type ResultadoCruzamentoComprovante =
  | {
      tipo: 'encontrado_unico';
      atendimento: AtendimentoAgendaResumo;
      origemMatch: 'pagador_secundario' | 'nome_pagador' | 'valor_unico_recente';
      pagadorSecundarioUsado?: PagadorSecundarioSalvo;
      valorDivergente: boolean;
    }
  | {
      tipo: 'ambiguo';
      motivo: 'MULTIPLOS_ATENDIMENTOS' | 'VALOR_DIVERGENTE';
      candidatos: AtendimentoAgendaResumo[];
    }
  | {
      tipo: 'nao_encontrado';
      motivo: 'TODAS_CONSULTAS_JA_EMITIDAS' | 'PAGADOR_NAO_ENCONTRADO';
      consultasRecentesSemNota: AtendimentoAgendaResumo[];
    };

export function normalizarNomeParaBusca(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function chaveAtendimentoSemNota(paciente: string, dataIso: string): string {
  return `${normalizarNomeParaBusca(paciente)}|${dataIso.slice(0, 10)}`;
}

function deslocarDias(iso: string, deltaDias: number): string {
  const base = Date.parse(`${iso.slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(base)) return iso.slice(0, 10);
  return new Date(base + deltaDias * 86_400_000).toISOString().slice(0, 10);
}

function nomesCompativeis(a: string, b: string): boolean {
  const na = normalizarNomeParaBusca(a);
  const nb = normalizarNomeParaBusca(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const tokensA = na.split(' ').filter(t => t.length >= 3);
  const tokensB = nb.split(' ').filter(t => t.length >= 3);
  if (tokensA.length < 2 || tokensB.length < 2) return false;
  const comuns = tokensA.filter(t => tokensB.includes(t));
  return comuns.length >= 2 && tokensA[0] === tokensB[0];
}

function jaPossuiNota(item: AtendimentoAgendaResumo, emitidas: ReadonlySet<string>): boolean {
  if (item.atendimentoId && emitidas.has(item.atendimentoId)) return true;
  return emitidas.has(chaveAtendimentoSemNota(item.paciente, item.data));
}

function localizarPagadorSecundario(
  entrada: EntradaCruzamentoComprovante
): PagadorSecundarioSalvo | undefined {
  if (entrada.cpfPagadorHash) {
    const porCpf = entrada.pagadoresSecundarios.find(p => p.pagadorCpfHash && p.pagadorCpfHash === entrada.cpfPagadorHash);
    if (porCpf) return porCpf;
  }
  const nomePagador = entrada.comprovante.nomePagador;
  if (!nomePagador) return undefined;
  const norm = normalizarNomeParaBusca(nomePagador);
  return entrada.pagadoresSecundarios.find(p => p.pagadorNomeNormalizado === norm || nomesCompativeis(p.pagadorNomeNormalizado, norm));
}

export function cruzarComprovanteComAgenda(
  entrada: EntradaCruzamentoComprovante
): ResultadoCruzamentoComprovante {
  const dataBase = entrada.comprovante.dataPagamento ?? entrada.dataReferenciaIso;
  const janela = entrada.janelaDiasAnteriores ?? JANELA_DIAS_BUSCA_COMPROVANTE;
  const inicioJanela = deslocarDias(dataBase, -janela);
  const fimJanela = deslocarDias(dataBase, TOLERANCIA_DIAS_APOS_COMPROVANTE);

  const noPeriodo = entrada.atendimentosAgenda
    .filter(a => {
      const dia = a.data.slice(0, 10);
      return dia >= inicioJanela && dia <= fimJanela;
    })
    .sort((a, b) => b.data.localeCompare(a.data));

  const semNota = noPeriodo.filter(a => !jaPossuiNota(a, entrada.chavesJaEmitidas));
  if (!semNota.length) {
    return {
      tipo: 'nao_encontrado',
      motivo: noPeriodo.length > 0 ? 'TODAS_CONSULTAS_JA_EMITIDAS' : 'PAGADOR_NAO_ENCONTRADO',
      consultasRecentesSemNota: []
    };
  }

  // 1. Verifica vínculo de pagador secundário já aprendido antes de perguntar novamente ao médico.
  const secundario = localizarPagadorSecundario(entrada);
  if (secundario) {
    const matchesSec = semNota.filter(a => nomesCompativeis(a.paciente, secundario.pacienteNome));
    if (matchesSec.length === 1) {
      const alvo = matchesSec[0]!;
      const valorDivergente = Boolean(
        alvo.valorCentavos && entrada.comprovante.valorCentavos && alvo.valorCentavos !== entrada.comprovante.valorCentavos
      );
      return {
        tipo: 'encontrado_unico',
        atendimento: alvo,
        origemMatch: 'pagador_secundario',
        pagadorSecundarioUsado: secundario,
        valorDivergente
      };
    }
    if (matchesSec.length > 1) {
      return { tipo: 'ambiguo', motivo: 'MULTIPLOS_ATENDIMENTOS', candidatos: matchesSec.slice(0, 5) };
    }
  }

  // 2. Match direto pelo nome do pagador no comprovante.
  const nomePagador = entrada.comprovante.nomePagador;
  if (nomePagador) {
    const matchesNome = semNota.filter(a => nomesCompativeis(a.paciente, nomePagador));
    if (matchesNome.length === 1) {
      const alvo = matchesNome[0]!;
      const valorDivergente = Boolean(
        alvo.valorCentavos && entrada.comprovante.valorCentavos && alvo.valorCentavos !== entrada.comprovante.valorCentavos
      );
      return { tipo: 'encontrado_unico', atendimento: alvo, origemMatch: 'nome_pagador', valorDivergente };
    }
    if (matchesNome.length > 1) {
      const mesmoValor = entrada.comprovante.valorCentavos
        ? matchesNome.filter(a => a.valorCentavos === entrada.comprovante.valorCentavos)
        : [];
      if (mesmoValor.length === 1) {
        return { tipo: 'encontrado_unico', atendimento: mesmoValor[0]!, origemMatch: 'nome_pagador', valorDivergente: false };
      }
      return { tipo: 'ambiguo', motivo: 'MULTIPLOS_ATENDIMENTOS', candidatos: matchesNome.slice(0, 5) };
    }
  }

  // 3. Sem nome compatível (ex.: pagamento de terceiro ainda desconhecido): nunca chuta — devolve consultas sem nota para perguntar ao médico.
  return {
    tipo: 'nao_encontrado',
    motivo: 'PAGADOR_NAO_ENCONTRADO',
    consultasRecentesSemNota: semNota.slice(0, 5)
  };
}
