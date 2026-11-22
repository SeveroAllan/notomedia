/**
 * Orquestrador I/O de leitura rápida de atendimentos da agenda conectada da
 * conta (TribeMD ou Amplimed), com cache curto em memória e modo híbrido:
 * responde na hora se concluir em até `esperaSincronaMs`, ou conclui em
 * segundo plano avisando no WhatsApp sem estourar o timeout da IA.
 */

import {
  calcularJanelaDiasConsulta,
  filtrarEOrdenarAtendimentos,
  formatarResumoAssincronoAgenda,
  type AtendimentoAgendaResumo,
  type FiltroAtendimentosAgenda,
  type ResultadoFiltroAtendimentos
} from './filtrar-atendimentos-agenda.js';

export type ResultadoConsultaAgendaConta =
  | { ok: true; emAndamento: false; agenda: string; resumo: ResultadoFiltroAtendimentos }
  | { ok: true; emAndamento: true; agenda: string; periodo: { inicio: string; fim: string } }
  | { ok: false; motivo: 'SEM_AGENDA_CONECTADA' | 'LEITURA_INDISPONIVEL' | 'AGENDA_GENERICA_SEM_LEITOR_RAPIDO' };

export interface LeitorAgendaContaDeps {
  obterAgendaConectada: (contaId: string) => Promise<{ conectada: boolean; provedor: string | null; nomeAgenda: string | null }>;
  lerTribemdRapido?: (contaId: string, janelaDias: number, agora: Date) => Promise<
    { ok: true; consultas: AtendimentoAgendaResumo[] } | { ok: false; motivo: string }
  >;
  lerAmplimed?: (contaId: string, inicio: string, fim: string) => Promise<
    { ok: true; consultas: AtendimentoAgendaResumo[] } | { ok: false; motivo: string }
  >;
  esperaSincronaMs?: number;
}

const TTL_CACHE_MS = 5 * 60_000;

export function criarConsultorAgendaConta(deps: LeitorAgendaContaDeps) {
  const cache = new Map<string, { expiraEm: number; janelaDias: number; agenda: string; consultas: AtendimentoAgendaResumo[] }>();
  const emVoo = new Map<string, Promise<{ ok: true; agenda: string; consultas: AtendimentoAgendaResumo[] } | { ok: false; motivo: string }>>();

  async function executarLeitura(
    contaId: string,
    provedor: string,
    nomeAgenda: string,
    janelaDias: number,
    filtro: FiltroAtendimentosAgenda,
    agora: Date
  ): Promise<{ ok: true; agenda: string; consultas: AtendimentoAgendaResumo[] } | { ok: false; motivo: string }> {
    if (provedor === 'tribemd' && deps.lerTribemdRapido) {
      const r = await deps.lerTribemdRapido(contaId, janelaDias, agora);
      if (!r.ok) return { ok: false, motivo: r.motivo };
      cache.set(contaId, { expiraEm: Date.now() + TTL_CACHE_MS, janelaDias, agenda: nomeAgenda, consultas: r.consultas });
      return { ok: true, agenda: nomeAgenda, consultas: r.consultas };
    }
    if (provedor === 'amplimed' && deps.lerAmplimed) {
      const r = await deps.lerAmplimed(contaId, filtro.dataInicio, filtro.dataFim);
      if (!r.ok) return { ok: false, motivo: r.motivo };
      cache.set(contaId, { expiraEm: Date.now() + TTL_CACHE_MS, janelaDias, agenda: nomeAgenda, consultas: r.consultas });
      return { ok: true, agenda: nomeAgenda, consultas: r.consultas };
    }
    return { ok: false, motivo: 'AGENDA_GENERICA_SEM_LEITOR_RAPIDO' };
  }

  return async function consultarAgendaConta(entrada: {
    contaId: string;
    filtro: FiltroAtendimentosAgenda;
    agora?: Date;
    aoConcluirAssincrono?: (texto: string, sucesso: boolean) => Promise<void>;
  }): Promise<ResultadoConsultaAgendaConta> {
    const agora = entrada.agora ?? new Date();
    const hojeIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora);
    const agenda = await deps.obterAgendaConectada(entrada.contaId);
    if (!agenda.conectada || !agenda.provedor) {
      return { ok: false, motivo: 'SEM_AGENDA_CONECTADA' };
    }

    const nomeAgenda = agenda.nomeAgenda || agenda.provedor;
    const janelaDias = calcularJanelaDiasConsulta(entrada.filtro.dataInicio, hojeIso);
    const cached = cache.get(entrada.contaId);
    if (cached && cached.expiraEm > Date.now() && cached.janelaDias >= janelaDias) {
      return {
        ok: true,
        emAndamento: false,
        agenda: cached.agenda,
        resumo: filtrarEOrdenarAtendimentos(cached.consultas, entrada.filtro)
      };
    }

    let promessa = emVoo.get(entrada.contaId);
    if (!promessa) {
      promessa = executarLeitura(entrada.contaId, agenda.provedor, nomeAgenda, janelaDias, entrada.filtro, agora)
        .finally(() => { emVoo.delete(entrada.contaId); });
      emVoo.set(entrada.contaId, promessa);
    }

    const esperaMs = deps.esperaSincronaMs ?? 20_000;
    const limite = Symbol('timeout');
    const corrida = await Promise.race([
      promessa,
      new Promise<typeof limite>(resolve => {
        const t = setTimeout(() => resolve(limite), esperaMs);
        t.unref();
      })
    ]);

    if (corrida !== limite) {
      if (!corrida.ok) {
        return {
          ok: false,
          motivo: corrida.motivo === 'AGENDA_GENERICA_SEM_LEITOR_RAPIDO'
            ? 'AGENDA_GENERICA_SEM_LEITOR_RAPIDO'
            : 'LEITURA_INDISPONIVEL'
        };
      }
      return {
        ok: true,
        emAndamento: false,
        agenda: corrida.agenda,
        resumo: filtrarEOrdenarAtendimentos(corrida.consultas, entrada.filtro)
      };
    }

    // Continua em segundo plano sem travar a conversa e envia o resultado assim que terminar.
    void promessa.then(async resultado => {
      if (!entrada.aoConcluirAssincrono) return;
      if (!resultado.ok) {
        await entrada.aoConcluirAssincrono(
          `Não consegui ler os atendimentos da agenda ${nomeAgenda} agora. Quer que eu tente de novo em instantes?`,
          false
        );
        return;
      }
      const resumo = filtrarEOrdenarAtendimentos(resultado.consultas, entrada.filtro);
      await entrada.aoConcluirAssincrono(formatarResumoAssincronoAgenda(resultado.agenda, resumo), true);
    }).catch(() => undefined);

    return {
      ok: true,
      emAndamento: true,
      agenda: nomeAgenda,
      periodo: { inicio: entrada.filtro.dataInicio, fim: entrada.filtro.dataFim }
    };
  };
}
