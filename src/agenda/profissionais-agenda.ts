export interface ConsultaComProfissional {
  profissional?: string | null;
}

const normalizar = (texto: string) => texto
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('pt-BR')
  .replace(/\b(?:dr|dra|doutor|doutora)\.?\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export function profissionaisIdentificados(consultas: readonly ConsultaComProfissional[]): string[] {
  const porChave = new Map<string, string>();
  for (const consulta of consultas) {
    const nome = consulta.profissional?.trim();
    const chave = nome ? normalizar(nome) : '';
    if (chave && !porChave.has(chave)) porChave.set(chave, nome!);
  }
  return [...porChave.values()].sort((a,b)=>a.localeCompare(b,'pt-BR'));
}

export function consultaPertenceAoProfissional(consulta: ConsultaComProfissional, nomeMedico: string): boolean {
  const profissional = consulta.profissional?.trim();
  return !!profissional && normalizar(profissional) === normalizar(nomeMedico);
}

export function filtrarConsultasDoProfissional<T extends ConsultaComProfissional>(
  consultas: readonly T[],
  nomeMedico: string,
  exigirIdentificacao: boolean
): { ok: true; consultas: T[] } | { ok: false; motivo: 'PROFISSIONAL_NAO_IDENTIFICADO' | 'PROFISSIONAL_AMBIGUO' } {
  if (!exigirIdentificacao) return { ok: true, consultas: [...consultas] };
  if (consultas.some(c => !c.profissional?.trim())) return { ok: false, motivo: 'PROFISSIONAL_NAO_IDENTIFICADO' };
  const filtradas = consultas.filter(c => consultaPertenceAoProfissional(c,nomeMedico));
  if (!filtradas.length && consultas.length) return { ok: false, motivo: 'PROFISSIONAL_AMBIGUO' };
  return { ok: true, consultas: filtradas };
}
