import { normalizarNomeMedico } from '../conta/medicos-conta.js';
import { consultaPertenceAoProfissional } from '../agenda/profissionais-agenda.js';
import type { ResultadoFonteAgenda } from '../agenda/fonte-agenda.js';
import type { LeituraParaConferencia } from './conferencia-atendimentos.js';

const FORMATO_DATA = /^\d{4}-\d{2}-\d{2}$/;
function dataValida(s: string) {
  return FORMATO_DATA.test(s) && !Number.isNaN(Date.parse(s + 'T12:00:00Z')) &&
    new Date(s + 'T12:00:00Z').toISOString().slice(0, 10) === s;
}
export function janelaConferencia(agora = new Date()): {inicio:string; fim:string} {
  const fim = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo'}).format(agora);
  const inicio = new Date(fim + 'T12:00:00Z');
  inicio.setUTCDate(inicio.getUTCDate() - 29);
  return {inicio:inicio.toISOString().slice(0,10),fim};
}

/** FonteAgenda só libera consultas depois de validar cobertura e detalhes completos. */
export function leituraTribemdParaConferencia(
  resultado: ResultadoFonteAgenda, nome: string, janela: {inicio:string;fim:string}
): LeituraParaConferencia {
  if (resultado.tipo !== 'consultas') {
    return {ok:false,motivo:resultado.codigo==='SINCRONIZACAO_INCOMPLETA'
      ? 'LEITURA_INCOMPLETA' : 'INTEGRACAO_INDISPONIVEL'};
  }
  if (resultado.fonte !== 'tribemd') return {ok:false,motivo:'LEITURA_INCOMPLETA'};
  if (!nome.trim() || !normalizarNomeMedico(nome)) return {ok:false,motivo:'IDENTIDADE_INCOMPLETA'};
  let totalRealizados = 0;
  const referencias:string[] = [];
  for (const c of resultado.consultas) {
    if (c.status !== 'realizada') continue;
    const data = c.dataHora.slice(0,10);
    if (!dataValida(data)) return {ok:false,motivo:'LEITURA_INCOMPLETA'};
    if (data < janela.inicio || data > janela.fim) continue;
    // A única médica cadastrada NÃO recebe consultas com profissional ausente.
    if (!c.profissional?.trim()) return {ok:false,motivo:'IDENTIDADE_INCOMPLETA'};
    if (!consultaPertenceAoProfissional(c,nome)) continue;
    totalRealizados++;
    referencias.push(c.idExterno);
  }
  return {ok:true,agenda:'tribemd',totalRealizados,referencias,semReferencia:0};
}

export interface DiaConferenciaAmplimed {
  data:string;
  consultas: readonly {status:'realizada'|'cancelada'|'faltou'|'agendada'}[];
  elegiveis: readonly {idExterno:string}[];
}

/** Leitor Amplimed já valida selectedprofs, resourceId, cobertura diária e legibilidade. */
export function leituraAmplimedParaConferencia(
  dias: readonly DiaConferenciaAmplimed[], janela:{inicio:string;fim:string}
): LeituraParaConferencia {
  if (!dataValida(janela.inicio) || !dataValida(janela.fim) || !Array.isArray(dias)) {
    return {ok:false,motivo:'LEITURA_INCOMPLETA'};
  }
  const vistos = new Set<string>();
  let totalRealizados = 0;
  const referencias:string[] = [];
  for (const d of dias) {
    if (!dataValida(d.data) || d.data < janela.inicio || d.data > janela.fim || vistos.has(d.data)) {
      return {ok:false,motivo:'LEITURA_INCOMPLETA'};
    }
    vistos.add(d.data);
    totalRealizados += d.consultas.filter((c: DiaConferenciaAmplimed['consultas'][number])=>c.status==='realizada').length;
    for (const e of d.elegiveis) {
      if (!e.idExterno || !e.idExterno.startsWith(d.data + 'T')) {
        return {ok:false,motivo:'REFERENCIAS_AMBIGUAS'};
      }
      referencias.push(e.idExterno);
    }
  }
  const esperado = Math.round((Date.parse(janela.fim+'T12:00:00Z') -
    Date.parse(janela.inicio+'T12:00:00Z')) / 86400000) + 1;
  if (esperado !== 30 || vistos.size !== esperado || referencias.length > totalRealizados) {
    return {ok:false,motivo:'LEITURA_INCOMPLETA'};
  }
  // Cortesia, convênio e atendimentos sem detalhes são observados, não viram nota pendente.
  return {ok:true,agenda:'amplimed',totalRealizados,referencias,
    semReferencia:totalRealizados-referencias.length};
}
