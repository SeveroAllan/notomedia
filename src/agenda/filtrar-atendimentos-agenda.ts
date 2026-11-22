/**
 * Regras puras para filtrar, ordenar e resumir atendimentos lidos da agenda
 * conectada em qualquer intervalo interpretado naturalmente pela IA.
 * Separado de navegador/banco para permanecer rápido e testável sem I/O.
 */

export interface AtendimentoAgendaResumo {
  data: string;
  paciente: string;
  profissional?: string | null;
  situacao?: string | null;
  valorCentavos?: number | null;
  atendimentoId?: string | null;
  cpf?: string | null;
  telefone?: string | null;
}

export interface FiltroAtendimentosAgenda {
  dataInicio: string;
  dataFim: string;
  filtroPaciente?: string | null;
  filtroProfissional?: string | null;
}

export interface ResultadoFiltroAtendimentos {
  periodo: { inicio: string; fim: string };
  totalEncontrados: number;
  ultimoAtendimento: AtendimentoAgendaResumo | null;
  atendimentos: AtendimentoAgendaResumo[];
  profissionaisNoPeriodo?: string[];
  ultimoAtendimentoSemFiltroProfissional?: AtendimentoAgendaResumo | null;
}

function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export function calcularJanelaDiasConsulta(dataInicio: string, hojeIso: string): number {
  const ini = Date.parse(`${dataInicio}T12:00:00Z`);
  const fim = Date.parse(`${hojeIso}T12:00:00Z`);
  if (!Number.isFinite(ini) || !Number.isFinite(fim)) return 30;
  const diff = Math.ceil((fim - ini) / 86_400_000) + 1;
  return Math.min(Math.max(diff, 7), 90);
}

export function filtrarEOrdenarAtendimentos(
  lista: readonly AtendimentoAgendaResumo[],
  filtro: FiltroAtendimentosAgenda
): ResultadoFiltroAtendimentos {
  const buscaPac = filtro.filtroPaciente ? normalizar(filtro.filtroPaciente) : '';
  const buscaProf = filtro.filtroProfissional ? normalizar(filtro.filtroProfissional) : '';

  const noPeriodo = lista
    .filter(item => {
      const dataDia = item.data.slice(0, 10);
      if (dataDia < filtro.dataInicio || dataDia > filtro.dataFim) return false;
      if (buscaPac && !normalizar(item.paciente).includes(buscaPac)) return false;
      return true;
    })
    .sort((a, b) => b.data.localeCompare(a.data));

  const filtrados = buscaProf
    ? noPeriodo.filter(item => !item.profissional || normalizar(item.profissional).includes(buscaProf))
    : noPeriodo;

  const profissionaisNoPeriodo = [...new Set(noPeriodo.map(i => i.profissional).filter((p): p is string => Boolean(p)))];
  const semMatchProfissional = Boolean(buscaProf && filtrados.length === 0 && noPeriodo.length > 0);

  return {
    periodo: { inicio: filtro.dataInicio, fim: filtro.dataFim },
    totalEncontrados: filtrados.length,
    ultimoAtendimento: filtrados[0] ?? null,
    atendimentos: filtrados.slice(0, 15),
    ...(profissionaisNoPeriodo.length ? { profissionaisNoPeriodo } : {}),
    ...(semMatchProfissional ? { ultimoAtendimentoSemFiltroProfissional: noPeriodo[0] ?? null } : {})
  };
}

export function formatarDataBr(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

export function formatarResumoAssincronoAgenda(
  agendaNome: string,
  resumo: ResultadoFiltroAtendimentos
): string {
  if (!resumo.totalEncontrados || !resumo.ultimoAtendimento) {
    return `Olhei a agenda ${agendaNome} entre ${formatarDataBr(resumo.periodo.inicio)} e ${formatarDataBr(resumo.periodo.fim)}, mas não encontrei atendimentos finalizados nesse período.`;
  }
  if (resumo.totalEncontrados === 1) {
    const u = resumo.ultimoAtendimento;
    return `Encontrei 1 atendimento finalizado na agenda ${agendaNome}: ${u.paciente} em ${formatarDataBr(u.data)}.`;
  }
  if (resumo.atendimentos.length <= 10) {
    const nomes = resumo.atendimentos.map(a => `${a.paciente} (${formatarDataBr(a.data)})`).join(', ');
    return `Encontrei ${resumo.totalEncontrados} atendimentos finalizados na agenda ${agendaNome}: ${nomes}.`;
  }
  const u = resumo.ultimoAtendimento;
  return `Encontrei ${resumo.totalEncontrados} atendimentos finalizados nesse período na agenda ${agendaNome}. O mais recente foi ${u.paciente} em ${formatarDataBr(u.data)}.`;
}
