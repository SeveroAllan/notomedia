import { normalizarNomeMedico } from '../conta/medicos-conta.js';
import { consultaPertenceAoProfissional } from '../agenda/profissionais-agenda.js';
import type { ResultadoFonteAgenda } from '../agenda/fonte-agenda.js';
import type { LeituraParaConferencia } from './conferencia-atendimentos.js';

const FORMATO_DATA = /^\d{4}-\d{2}-\d{2}$/;
function dataValida(s: string) {
  return FORMATO_DATA.test(s) && !Number.isNaN(Date.parse(s + 'T12:00:00Z')) &&
    new Date(s + 'T12:00:00Z').toISOString().slice(0, 10) === s;
}
export function janelaConferencia(agora = new Date(), desde?: string): {inicio:string; fim:string} {
  const fim = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo'}).format(agora);
  const inicio = new Date(fim + 'T12:00:00Z');
  inicio.setUTCDate(inicio.getUTCDate() - 29);
  return {inicio:desde ?? inicio.toISOString().slice(0,10),fim};
}

const mesesPeriodo = 'janeiro fevereiro marco abril maio junho julho agosto setembro outubro novembro dezembro'.split(' ');
const dataExtenso = new RegExp(`\\b(\\d{1,2}) de (${mesesPeriodo.join('|')})(?: de (\\d{4}))?\\b`, 'g');

export function extrairInicioConferencia(texto: string, hoje: string) {
  const fala = texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const anos = new Set(fala.match(/\b(?:19|20)\d{2}\b/g) ?? []);
  const datas = [
    ...Array.from(fala.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g), m => [m[3]!, m[2]!, m[1], m.index, m[0].length] as const),
    ...Array.from(fala.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b(?!\/)/g), m => [m[1]!, m[2]!, m[3], m.index, m[0].length] as const),
    ...Array.from(fala.matchAll(dataExtenso), m => [m[1]!, String(mesesPeriodo.indexOf(m[2]!) + 1), m[3], m.index, m[0].length] as const)
  ];
  if (datas.length > 1 || /\b(?:ate|entre)\b/.test(fala)) return { motivo: 'INTERVALO_OU_MULTIPLAS_DATAS' } as const;
  if (anos.size > 1) return { motivo: 'MULTIPLOS_ANOS' } as const;
  if (/\b(?:nao|nem|exceto)\b/.test(fala)) return { motivo: 'DATA_NEGADA' } as const;
  const data = datas[0];
  if (!data) return { motivo: 'DATA_NAO_IDENTIFICADA' } as const;
  const [dia, mes, ano, posicao, tamanho] = data;
  const antes = fala.slice(0, posicao).trim();
  const depois = fala.slice(posicao + tamanho).trim();
  if (!/^(?:(?:na verdade|corrigindo)[,: ]*(?:e )?)?(?:(?:quero conferir |o periodo comeca )?(?:desde|a partir de|em))?$/.test(antes) ||
      !/^[.!]*$/.test(depois)) return { motivo: 'DATA_SEM_ESCOPO_CLARO' } as const;
  if (anos.size && (!ano || !anos.has(ano))) return { motivo: 'ANO_DIVERGENTE' } as const;
  const inicio = (ano ?? hoje.slice(0, 4)) + '-' + mes!.padStart(2, '0') + '-' + dia!.padStart(2, '0');
  if (!dataValida(inicio)) return { motivo: 'DATA_INVALIDA' } as const;
  if (inicio > hoje) return { motivo: 'DATA_FUTURA' } as const;
  return { inicio, anoExplicito: Boolean(ano) } as const;
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
  let totalRealizados = 0, descartadosStatus = 0, descartadosData = 0, descartadosProfissional = 0;
  const referencias:string[] = [];
  for (const c of resultado.consultas) {
    if (c.status !== 'realizada') { descartadosStatus++; continue; }
    const data = c.dataHora.slice(0,10);
    if (!dataValida(data)) return {ok:false,motivo:'LEITURA_INCOMPLETA'};
    if (data < janela.inicio || data > janela.fim) { descartadosData++; continue; }
    // A única médica cadastrada NÃO recebe consultas com profissional ausente.
    if (!c.profissional?.trim()) return {ok:false,motivo:'IDENTIDADE_INCOMPLETA'};
    if (!consultaPertenceAoProfissional(c,nome)) { descartadosProfissional++; continue; }
    totalRealizados++;
    referencias.push(c.idExterno);
  }
  const bruta = resultado.contagensBrutas;
  if (!bruta) return {ok:true,agenda:'tribemd',totalRealizados,referencias,semReferencia:0};
  descartadosStatus += bruta.descartadosStatus;
  descartadosData += bruta.descartadosData;
  const outrosDescartados = bruta.brutos - totalRealizados - descartadosStatus - descartadosData - descartadosProfissional;
  if (!Number.isSafeInteger(outrosDescartados) || outrosDescartados < 0)
    return {ok:false,motivo:'LEITURA_INCOMPLETA'};
  return {ok:true,agenda:'tribemd',totalRealizados,referencias,semReferencia:0,contagensLeitura:{
    brutos:bruta.brutos, realizados:totalRealizados, descartadosStatus, descartadosData,
    descartadosProfissional, outrosDescartados
  }};
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
