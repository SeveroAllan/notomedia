/**
 * Validação pura dos dados enviados pelo formulário multi-profissional do cofre
 * (`/c/profissionais/:token`). Normaliza nome completo, CRM com UF e RQE opcional,
 * evitando duplicidades no mesmo envio sem depender de banco ou HTTP.
 */

import { nomeProfissionalValido, normalizarCrm } from '../conta/validar-dados-emissao.js';
import { normalizarNomeMedico } from '../conta/medicos-conta.js';

export interface ProfissionalFormularioCofre {
  nomeCompleto: string;
  crm: string;
  rqe: string | null;
}

export type ResultadoValidacaoProfissionais =
  | { ok: true; profissionais: ProfissionalFormularioCofre[] }
  | { ok: false; detalhe: string };

function lerListaTexto(valor: unknown): string[] {
  if (Array.isArray(valor)) return valor.map(item => String(item ?? ''));
  if (valor === undefined || valor === null) return [];
  return [String(valor)];
}

function extrairEntradasBrutas(corpo: unknown): Array<{ nome?: unknown; crm?: unknown; rqe?: unknown }> {
  if (!corpo || typeof corpo !== 'object') return [];
  const obj = corpo as Record<string, unknown>;
  if (Array.isArray(obj['profissionais'])) {
    return obj['profissionais'].filter(
      (item): item is { nome?: unknown; crm?: unknown; rqe?: unknown } => Boolean(item && typeof item === 'object')
    );
  }
  const nomes = lerListaTexto(obj['nome'] ?? obj['nome[]']);
  const crms = lerListaTexto(obj['crm'] ?? obj['crm[]']);
  const rqes = lerListaTexto(obj['rqe'] ?? obj['rqe[]']);
  const total = Math.max(nomes.length, crms.length);
  return Array.from({ length: total }, (_, idx) => ({
    nome: nomes[idx] ?? '',
    crm: crms[idx] ?? '',
    rqe: rqes[idx] ?? ''
  }));
}

export function validarProfissionaisFormularioCofre(corpo: unknown): ResultadoValidacaoProfissionais {
  const entradas = extrairEntradasBrutas(corpo).filter(e => String(e.nome ?? '').trim() || String(e.crm ?? '').trim());
  if (!entradas.length) {
    return { ok: false, detalhe: 'Informe ao menos um profissional com nome completo e CRM/UF.' };
  }
  if (entradas.length > 20) {
    return { ok: false, detalhe: 'É possível cadastrar até 20 profissionais por envio.' };
  }

  const validados: ProfissionalFormularioCofre[] = [];
  const vistos = new Set<string>();

  for (const [indice, item] of entradas.entries()) {
    const nomeCompleto = String(item.nome ?? '').trim().replace(/\s+/g, ' ');
    if (!nomeProfissionalValido(nomeCompleto)) {
      return { ok: false, detalhe: `Profissional ${indice + 1}: informe o nome completo (nome e sobrenome).` };
    }
    const crm = normalizarCrm(String(item.crm ?? ''));
    if (!crm || !crm.includes('/')) {
      return { ok: false, detalhe: `Profissional ${indice + 1} (${nomeCompleto}): informe o CRM com UF (ex.: 12345/SP).` };
    }
    const rqeLimpo = String(item.rqe ?? '').replace(/\D/g, '');
    if (rqeLimpo && !/^[1-9]\d{0,11}$/.test(rqeLimpo)) {
      return { ok: false, detalhe: `Profissional ${indice + 1} (${nomeCompleto}): informe apenas os números do RQE.` };
    }
    const chave = normalizarNomeMedico(nomeCompleto);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    validados.push({ nomeCompleto, crm, rqe: rqeLimpo || null });
  }

  return validados.length
    ? { ok: true, profissionais: validados }
    : { ok: false, detalhe: 'Nenhum profissional válido informado.' };
}
