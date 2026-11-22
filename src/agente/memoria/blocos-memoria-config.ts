/**
 * Regras puras dos blocos de memória núcleo (inspirado em Core Memory Blocks
 * do Letta): limites, sanitização segura linha a linha e geração determinística
 * do bloco `estado_vivo_consultorio` a partir do estado real do banco.
 * Mantido sem I/O para ser testável isoladamente e garantir zero vazamento de
 * segredos, CPFs ou links de cofre na memória persistente.
 */

import { contemCredencialAgenda } from '../../cofre/links.js';
import type { EstadoProntidaoConta } from '../estado-prontidao-conta.js';

export type RotuloBlocoMemoria =
  | 'perfil_medico'
  | 'estado_vivo_consultorio'
  | 'pendencias_e_combinados';

export type RotuloBlocoEditavelAgente =
  | 'perfil_medico'
  | 'pendencias_e_combinados';

export type AutorBlocoMemoria = 'agente' | 'sistema' | 'sleep_time';

export interface BlocoMemoriaNucleo {
  contaId: string;
  rotulo: RotuloBlocoMemoria;
  conteudo: string;
  versao: number;
  atualizadoPor: AutorBlocoMemoria;
  atualizadoEm: string;
}

export interface MemoriaNucleoPrompt {
  perfil_medico: string;
  estado_vivo_consultorio: string;
  pendencias_e_combinados: string;
}

export interface ResumoCasoEmissaoEstadoVivo {
  estado: string;
  pacienteNome: string | null;
  dataConsulta: string | null;
  valorFormatado: string;
  ambiente: string;
  erroMotivo?: string | null;
}

export const LIMITE_CHARS_BLOCO = 1200;
export const COOLDOWN_SLEEP_TIME_MS = 60_000;
export const MIN_NOVAS_MENSAGENS_SLEEP_TIME = 2;

const REGEX_LINK_COFRE = /https?:\/\/[^\s<>]*\/c\/[^\s<>]*/gi;
const REGEX_CPF_FORMATADO = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
const REGEX_CPF_PURO = /\b\d{11}\b/g;

function normalizarLinhaComparacao(linha: string): string {
  return linha
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^[-•*]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizarConteudoBloco(texto: string): string {
  const linhasSeguras: string[] = [];
  const vistas = new Set<string>();

  for (const bruta of texto.split(/\r?\n/)) {
    const semLink = bruta.trim().replace(REGEX_LINK_COFRE, '[link seguro]');
    if (!semLink || contemCredencialAgenda(semLink)) continue;

    const segura = semLink
      .replace(REGEX_CPF_FORMATADO, '[CPF oculto]')
      .replace(REGEX_CPF_PURO, '[documento oculto]')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    if (!segura) continue;

    const chave = normalizarLinhaComparacao(segura);
    if (!chave || vistas.has(chave)) continue;
    vistas.add(chave);
    linhasSeguras.push(segura);
  }

  return linhasSeguras.join('\n').slice(0, LIMITE_CHARS_BLOCO).trim();
}

export function combinarConteudoBloco(entrada: {
  atual: string;
  novo: string;
  operacao: 'substituir' | 'acrescentar';
}): string {
  if (entrada.operacao === 'substituir') {
    return sanitizarConteudoBloco(entrada.novo);
  }
  const combinado = [entrada.atual.trim(), entrada.novo.trim()].filter(Boolean).join('\n');
  return sanitizarConteudoBloco(combinado);
}

function resumirProfissional(p: EstadoProntidaoConta['profissionais'][number]): string {
  const crm = p.crm ? ` (CRM ${p.crm})` : '';
  const cert = p.certificadoValido ? 'A1 válido' : 'sem A1';
  const fiscal = p.dadosFiscaisProntos ? 'fiscal pronto' : 'fiscal pendente';
  return `${p.nomeCompleto}${crm}: ${cert}, ${fiscal}`;
}

function resumirMotivoErroCaso(erroMotivo?: string | null): string | null {
  const limpo = String(erroMotivo ?? '').replace(/\s+/g, ' ').trim();
  if (!limpo) return null;
  if (/HTTP\s*403|403\b|IIS/i.test(limpo)) {
    return 'bloqueio HTTP 403 no gateway IIS da SEFIN homologação (instabilidade externa do SERPRO; monitoramento automático ativo)';
  }
  if (/timeout|expirou|ECONN|ENOTFOUND|50[234]|indispon/i.test(limpo)) {
    return 'SEFIN homologação temporariamente indisponível (monitoramento automático ativo)';
  }
  return limpo.slice(0, 80);
}

function resumirCasosAtivos(casos: readonly ResumoCasoEmissaoEstadoVivo[]): string[] {
  if (!casos.length) return [];
  const visiveis = casos.slice(0, 6);
  const itens = visiveis.map(c => {
    const nome = c.pacienteNome || 'paciente a confirmar';
    const data = c.dataConsulta ? ` ${c.dataConsulta}` : '';
    return `${nome} (${c.valorFormatado}${data}): ${c.estado} [${c.ambiente}]`;
  });
  const linhas = [`Emissões recentes/abertas: ${itens.join('; ')}`];
  const motivosErro = [...new Set(
    visiveis
      .filter(c => c.estado === 'erro')
      .map(c => resumirMotivoErroCaso(c.erroMotivo))
      .filter((m): m is string => Boolean(m))
  )];
  if (motivosErro.length) {
    linhas.push(`Causa real dos erros abertos: ${motivosErro.join(' | ')}`);
  }
  return linhas;
}

/**
 * Gera o snapshot vivo e determinístico do banco para o bloco
 * `estado_vivo_consultorio`. Como reflete sempre o estado atual real, evita
 * contradições quando o médico completa etapas fora da ordem tradicional.
 */
export function montarBlocoEstadoVivo(
  estado: EstadoProntidaoConta | null,
  casosEmissao: readonly ResumoCasoEmissaoEstadoVivo[] = []
): string {
  if (!estado) return '';
  const linhas: string[] = [];

  if (estado.agenda.conectada) {
    linhas.push(`Agenda conectada: ${estado.agenda.nomeAgenda ?? estado.agenda.provedor ?? 'ativa'}`);
  } else if (estado.ultimaAgendaSolicitada) {
    linhas.push(`Agenda ainda não conectada (último link: ${estado.ultimaAgendaSolicitada.nomeAgenda})`);
  } else {
    linhas.push('Agenda ainda não conectada');
  }

  if (estado.profissionais.length) {
    linhas.push(`Profissionais: ${estado.profissionais.map(resumirProfissional).join(' | ')}`);
  } else {
    linhas.push('Profissionais: nenhum cadastrado ainda');
  }

  if (estado.preferenciasEmissao) {
    const pref = estado.preferenciasEmissao;
    const resumo = pref.resumoCombinado.join('; ');
    if (pref.completas) {
      linhas.push(`Preferências de emissão (completas — já salvas, não perguntar de novo; pedido explícito do médico no chat sempre emite): ${resumo || 'todas definidas'}`);
    } else if (resumo) {
      linhas.push(`Preferências já definidas: ${resumo} | pendentes: ${pref.pendentes.join(', ')}`);
    } else {
      linhas.push(`Preferências de emissão pendentes: ${pref.pendentes.join(', ')}`);
    }
  }

  linhas.push(`Próxima etapa operacional: ${estado.proximaEtapa}`);

  linhas.push(...resumirCasosAtivos(casosEmissao));

  return sanitizarConteudoBloco(linhas.join('\n'));
}
