/**
 * Regras puras do subagente navegador genérico: guarda de requisições HTTP
 * somente-leitura, filtragem de cookies por domínio aprovado e extração de
 * consultas a partir de blocos de texto observados em portais de agenda.
 */

import crypto from 'node:crypto';
import {
  AGENDAS_SUPORTADAS,
  dominioAprovado,
  type AgendaSuportada,
  type DefinicaoAgendaSuportada
} from '../agenda/agendas-suportadas.js';
import type { EstadoNavegador } from './tribemd-perfil.js';
import { ehNomeCivilValido } from '../paciente/regras/validar-nome-civil.js';
import { validarCpf } from '../paciente/validar-cpf.js';

export interface ConsultaPortalGenerico {
  idExterno: string;
  dataHora: string;
  profissional: string;
  status: 'realizada' | 'cancelada' | 'faltou' | 'agendada';
  tipoCobranca: 'particular' | 'convenio' | 'cortesia';
  valorCentavos: number;
  telefone: string | null;
  pacienteNome: string;
  cpf: string | null;
}

const ACAO_MUTACAO_URL =
  /(?:^|\/)(?:logout|sair|delete|remove|update|create|save|excluir|salvar|editar|novo|cancelar|deletar|emitir)(?:\/|$)/i;

export function permitirRequisicaoPortalSomenteLeitura(opcoes: {
  url: string;
  metodo: string;
  tipo: string;
  provedor: AgendaSuportada;
  hostExtra?: string | null;
  envioLoginLiberado: boolean;
}): boolean {
  let u: URL;
  try {
    u = new URL(opcoes.url);
  } catch {
    return false;
  }
  if (opcoes.tipo === 'websocket') return false;
  const metodo = opcoes.metodo.toUpperCase();
  const ehPortal = dominioAprovado(opcoes.provedor, opcoes.url, opcoes.hostExtra);
  if (metodo === 'POST') {
    return ehPortal && opcoes.envioLoginLiberado && !ACAO_MUTACAO_URL.test(u.pathname);
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(metodo)) return false;
  if (u.protocol !== 'https:') return false;
  if (ehPortal && ACAO_MUTACAO_URL.test(u.pathname) && opcoes.tipo === 'document') return false;
  return true;
}

export function filtrarEstadoSessaoPorDominios(
  estado: EstadoNavegador,
  provedor: AgendaSuportada,
  hostExtra?: string | null
): EstadoNavegador {
  const cfg = AGENDAS_SUPORTADAS[provedor] as DefinicaoAgendaSuportada;
  const hosts = new Set<string>(cfg.dominios.map(d => d.toLowerCase()));
  if (hostExtra) hosts.add(hostExtra.trim().toLowerCase());
  const hostOk = (rawHost: string): boolean => {
    const h = rawHost.replace(/^\./, '').toLowerCase();
    return [...hosts].some(d => h === d || h.endsWith(`.${d}`));
  };
  return {
    cookies: estado.cookies.filter(c => hostOk(c.domain)),
    origins: estado.origins.filter(o => {
      try {
        return hostOk(new URL(o.origin).hostname);
      } catch {
        return false;
      }
    })
  };
}

function extrairDataBloco(texto: string, dataPadraoIso: string): string {
  const iso = texto.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1]!;
  const br = texto.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return dataPadraoIso;
}

function extrairHorarioBloco(texto: string): string | null {
  const m = texto.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/);
  if (!m) return null;
  return `${m[1]!.padStart(2, '0')}:${m[2]}`;
}

function extrairValorCentavosBloco(texto: string): number {
  const comMoeda = texto.match(/R\$\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2})|\d+(?:[.,]\d{2})?)/i);
  if (comMoeda) {
    const num = Number(comMoeda[1]!.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(num) && num >= 0 ? Math.round(num * 100) : 0;
  }
  const decimal = texto.match(/\b(\d{2,5},\d{2})\b/);
  if (!decimal) return 0;
  const num = Number(decimal[1]!.replace(',', '.'));
  return Number.isFinite(num) && num >= 0 ? Math.round(num * 100) : 0;
}

function extrairCpfBloco(texto: string): string | null {
  for (const cand of texto.matchAll(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g)) {
    const digits = cand[0].replace(/\D/g, '');
    if (validarCpf(digits)) return digits;
  }
  return null;
}

function extrairTelefoneBloco(texto: string): string | null {
  const m = texto.match(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9?\d{4}[-.\s]?\d{4})\b/);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) return null;
  return digits.length <= 11 ? `55${digits}` : digits;
}

function detectarStatusBloco(textoNorm: string): ConsultaPortalGenerico['status'] {
  if (/\b(cancelad[ao]|desmarcad[ao]|excluid[ao])\b/.test(textoNorm)) return 'cancelada';
  if (/\b(faltou|falta|ausente|nao compareceu|no[- ]?show)\b/.test(textoNorm)) return 'faltou';
  if (/\b(realizad[ao]|atendid[ao]|finalizad[ao]|concluid[ao]|pago|faturad[ao])\b/.test(textoNorm)) return 'realizada';
  return 'agendada';
}

function detectarCobrancaBloco(textoNorm: string): ConsultaPortalGenerico['tipoCobranca'] {
  if (/\b(cortesia|gratuit[ao]|isento|retorno sem custo)\b/.test(textoNorm)) return 'cortesia';
  if (/\b(convenio|unimed|bradesco|sulamerica|amil|hapvida|notredame|porto seguro)\b/.test(textoNorm)) return 'convenio';
  return 'particular';
}

function extrairNomePacienteBloco(texto: string): string | null {
  const limpo = texto
    .replace(/R\$\s*\d[\d.,]*/gi, ' ')
    .replace(/\b\d{2}\/\d{2}\/\d{4}\b/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b([01]?\d|2[0-3])[:h][0-5]\d\b/g, ' ')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, ' ')
    .replace(/(?:\+?55\s*)?\(?\d{2}\)?\s*9?\d{4}[-.\s]?\d{4}/g, ' ')
    .replace(/\b(particular|convenio|convênio|cortesia|realizada|finalizado|finalizada|atendido|atendida|confirmado|confirmada|cancelado|cancelada|faltou|agendada|agendado|pago)\b/gi, ' ');

  const segmentos = limpo
    .split(/[\n|•–—;]+|\s{2,}|\s-\s/)
    .map(s => s.replace(/[^a-zA-ZÀ-ÿ\s']/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  return segmentos.find(seg => ehNomeCivilValido(seg)) ?? null;
}

export function extrairConsultasDeBlocosHtml(opcoes: {
  blocos: readonly string[];
  dataPadraoIso: string;
  profissionalPadrao: string;
  provedor: AgendaSuportada;
}): ConsultaPortalGenerico[] {
  const resultado: ConsultaPortalGenerico[] = [];
  const vistos = new Set<string>();

  for (const bruto of opcoes.blocos) {
    const texto = String(bruto || '').replace(/\s+/g, ' ').trim();
    if (texto.length < 8 || texto.length > 600) continue;
    const horario = extrairHorarioBloco(texto);
    if (!horario) continue;
    const pacienteNome = extrairNomePacienteBloco(texto);
    if (!pacienteNome) continue;

    const dataIso = extrairDataBloco(texto, opcoes.dataPadraoIso);
    const chaveDedup = `${dataIso}T${horario}|${pacienteNome.toLowerCase()}`;
    if (vistos.has(chaveDedup)) continue;
    vistos.add(chaveDedup);

    const textoNorm = texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const idHash = crypto.createHash('sha1').update(`${opcoes.provedor}:${chaveDedup}`).digest('hex').slice(0, 12);

    resultado.push({
      idExterno: `${opcoes.provedor}_${dataIso}_${horario.replace(':', '')}_${idHash}`,
      dataHora: `${dataIso}T${horario}:00-03:00`,
      profissional: opcoes.profissionalPadrao || 'Profissional Responsável',
      status: detectarStatusBloco(textoNorm),
      tipoCobranca: detectarCobrancaBloco(textoNorm),
      valorCentavos: extrairValorCentavosBloco(texto),
      telefone: extrairTelefoneBloco(texto),
      pacienteNome,
      cpf: extrairCpfBloco(texto)
    });
  }
  return resultado;
}
