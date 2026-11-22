/**
 * Motor assíncrono de proatividade do Noto:
 * - Pela manhã mapeia os horários agendados do dia das contas com
 *   `revisao_diaria_agenda = true` e agenda verificações 10 minutos após cada
 *   atendimento;
 * - Ao vencer o horário (+10 min), verifica se a consulta foi marcada como
 *   finalizada e prepara/emite automaticamente conforme as preferências;
 * - Em horário comercial faz follow-up gentil de CPFs pedidos a pacientes há >24h.
 */

import type pg from 'pg';
import type { AtendimentoAgendaResumo } from '../agenda/filtrar-atendimentos-agenda.js';
import type { CasoEmissaoRegistro, CasoEmissaoRepositorio } from '../emissao/caso-emissao-repositorio.js';
import { chaveAtendimentoSemNota } from '../emissao/cruzar-comprovante-agenda.js';
import type { ResultadoOperacaoEmissao } from '../emissao/orquestrar-emissao-conta.js';
import {
  formatarAvisoProativoConsultas,
  formatarFollowupCpfTravado,
  HORA_INICIO_MAPEAMENTO_MANHA_SP,
  HORA_LIMITE_MAPEAMENTO_SP,
  identificarCasosCpfTravados,
  obterRelogioSp,
  planejarHorariosDoDia,
  reagendarSlotNaoFinalizado,
  selecionarSlotsParaVerificarAgora,
  type HorarioConsultaAgenda,
  type ResumoItemProativo,
  type SlotConsultaMonitorado
} from './rotina-proativa-regras.js';

export interface MotorRotinaProativaDeps {
  pool: Pick<pg.Pool, 'query'>;
  repositorioCasos: Pick<CasoEmissaoRepositorio, 'listarChavesConsultasComNota' | 'listarAbertosOuRecentes'>;
  lerHorariosDoDia: (contaId: string, diaIso: string, agora: Date) => Promise<HorarioConsultaAgenda[]>;
  lerFinalizadosDoDiaDetalhado: (contaId: string, diaIso: string, agora: Date) => Promise<AtendimentoAgendaResumo[]>;
  prepararEmissaoProativa: (entrada: {
    contaId: string;
    pacienteNome: string;
    dataConsulta: string;
    valorCentavos?: number | null;
    pacienteCpf?: string | null;
    pacienteTelefone?: string | null;
    atendimentoExternoId?: string | null;
    jaDetalhado: true;
    aprovadoAgora: false;
  }) => Promise<ResultadoOperacaoEmissao>;
  enviarTextoMedico: (contaId: string, telefone: string, texto: string) => Promise<boolean>;
  intervaloMs?: number;
  agora?: () => Date;
}

interface AgendaMonitoradaConta {
  diaIso: string;
  slots: SlotConsultaMonitorado[];
}

export function criarMotorRotinaProativa(deps: MotorRotinaProativaDeps) {
  const agoraFn = deps.agora ?? (() => new Date());
  const agendaPorConta = new Map<string, AgendaMonitoradaConta>();
  const followupsEnviados = new Set<string>();
  let emExecucao = false;
  let ultimoCheckFollowupMs = 0;

  async function listarContasComRotinaAtiva(): Promise<Array<{ contaId: string; telefone: string }>> {
    const { rows } = await deps.pool.query(
      `select p.conta_id,
              (select u.telefone from public.usuarios u
                where u.conta_id = p.conta_id and u.ativo = true and u.telefone is not null
                order by u.criado_em asc limit 1) as telefone
         from public.conta_preferencias_emissao p
        where p.revisao_diaria_agenda = true`
    ).catch(() => ({ rows: [] as any[] }));
    return rows
      .filter((r: any) => Boolean(r.conta_id && r.telefone))
      .map((r: any) => ({ contaId: String(r.conta_id), telefone: String(r.telefone) }));
  }

  async function processarContaNoCiclo(
    conta: { contaId: string; telefone: string },
    relogio: { diaIso: string; hora: number },
    agora: Date
  ): Promise<void> {
    const agoraMs = agora.getTime();
    let monitor = agendaPorConta.get(conta.contaId);

    // 1. Mapeamento matinal dos horários agendados de hoje (1x por dia após 07h).
    if ((!monitor || monitor.diaIso !== relogio.diaIso) &&
        relogio.hora >= HORA_INICIO_MAPEAMENTO_MANHA_SP &&
        relogio.hora <= HORA_LIMITE_MAPEAMENTO_SP) {
      const [horariosHoje, jaEmitidas] = await Promise.all([
        deps.lerHorariosDoDia(conta.contaId, relogio.diaIso, agora).catch(() => []),
        deps.repositorioCasos.listarChavesConsultasComNota(conta.contaId).catch(() => new Set<string>())
      ]);
      monitor = {
        diaIso: relogio.diaIso,
        slots: planejarHorariosDoDia({
          horariosHoje,
          chavesJaEmitidas: jaEmitidas,
          diaIso: relogio.diaIso,
          agoraMs
        })
      };
      agendaPorConta.set(conta.contaId, monitor);
    }

    if (!monitor || !monitor.slots.length) return;

    // 2. Verifica apenas slots que já passaram de 10 minutos após o atendimento.
    const devidos = selecionarSlotsParaVerificarAgora(monitor.slots, agoraMs);
    if (!devidos.length) return;

    const [finalizadosHoje, jaEmitidas] = await Promise.all([
      deps.lerFinalizadosDoDiaDetalhado(conta.contaId, relogio.diaIso, agora).catch(() => []),
      deps.repositorioCasos.listarChavesConsultasComNota(conta.contaId).catch(() => new Set<string>())
    ]);

    const avisos: ResumoItemProativo[] = [];
    for (const slot of devidos) {
      const chaveNomeDia = chaveAtendimentoSemNota(slot.paciente, relogio.diaIso);
      if (jaEmitidas.has(slot.chave) || jaEmitidas.has(chaveNomeDia)) {
        slot.concluido = true;
        continue;
      }

      const match = finalizadosHoje.find(a =>
        (slot.atendimentoId && a.atendimentoId === slot.atendimentoId)
        || chaveAtendimentoSemNota(a.paciente, a.data.slice(0, 10)) === chaveNomeDia
      );
      if (!match) {
        const atualizado = reagendarSlotNaoFinalizado(slot, agoraMs);
        Object.assign(slot, atualizado);
        continue;
      }

      slot.concluido = true;
      const res = await deps.prepararEmissaoProativa({
        contaId: conta.contaId,
        pacienteNome: match.paciente,
        dataConsulta: relogio.diaIso,
        valorCentavos: match.valorCentavos ?? null,
        pacienteCpf: match.cpf ?? null,
        pacienteTelefone: match.telefone ?? null,
        atendimentoExternoId: match.atendimentoId ?? slot.atendimentoId,
        jaDetalhado: true,
        aprovadoAgora: false
      }).catch(() => null);

      if (res && res.acao !== 'duplicado' && res.acao !== 'erro' && res.acao !== 'cancelada') {
        avisos.push({
          paciente: res.caso?.pacienteNome || match.paciente,
          valorCentavos: res.caso?.valorCentavos ?? match.valorCentavos ?? null,
          acao: res.acao,
          ambiente: res.caso?.ambiente,
          valorSugeridoFormatado: res.valorSugeridoFormatado
        });
      }
    }

    const texto = formatarAvisoProativoConsultas(avisos);
    if (texto) {
      await deps.enviarTextoMedico(conta.contaId, conta.telefone, texto).catch(() => false);
    }
  }

  async function verificarFollowupsTravados(agoraMs: number, hora: number): Promise<void> {
    if (hora < 9 || hora > 19 || agoraMs - ultimoCheckFollowupMs < 3_600_000) return;
    ultimoCheckFollowupMs = agoraMs;

    const { rows } = await deps.pool.query(
      `select distinct c.conta_id,
              (select u.telefone from public.usuarios u
                where u.conta_id = c.conta_id and u.ativo = true and u.telefone is not null
                order by u.criado_em asc limit 1) as telefone
         from public.noto_casos_emissao c
        where c.estado = 'aguardando_cpf_paciente'
          and c.atualizado_em < now() - interval '24 hours'`
    ).catch(() => ({ rows: [] as any[] }));

    for (const r of rows as Array<{ conta_id: string; telefone: string | null }>) {
      if (!r.conta_id || !r.telefone) continue;
      const recentes: CasoEmissaoRegistro[] = await deps.repositorioCasos
        .listarAbertosOuRecentes(String(r.conta_id), 15)
        .catch(() => []);
      const travados = identificarCasosCpfTravados({
        casos: recentes,
        agoraMs,
        jaAvisados: followupsEnviados
      });
      for (const caso of travados.slice(0, 2)) {
        const ok = await deps.enviarTextoMedico(String(r.conta_id), r.telefone, formatarFollowupCpfTravado(caso))
          .catch(() => false);
        if (ok) followupsEnviados.add(caso.id);
      }
    }
  }

  async function executarCiclo(): Promise<void> {
    if (emExecucao) return;
    emExecucao = true;
    try {
      const agora = agoraFn();
      const relogio = obterRelogioSp(agora);
      const contas = await listarContasComRotinaAtiva();
      for (const conta of contas) {
        await processarContaNoCiclo(conta, relogio, agora).catch(() => undefined);
      }
      await verificarFollowupsTravados(agora.getTime(), relogio.hora).catch(() => undefined);
    } finally {
      emExecucao = false;
    }
  }

  function iniciar() {
    let ativo = true;
    const timer = setInterval(() => {
      if (!ativo) return;
      void executarCiclo();
    }, deps.intervaloMs ?? 60_000);
    timer.unref();
    return {
      parar() {
        ativo = false;
        clearInterval(timer);
      }
    };
  }

  return { executarCiclo, iniciar, obterAgendaPlanejada: (contaId: string) => agendaPorConta.get(contaId) ?? null };
}
