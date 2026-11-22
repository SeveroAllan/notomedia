/**
 * Consolidador assíncrono em segundo plano (Sleep-Time Compute, inspirado no
 * Letta). Roda fora do caminho crítico de resposta do WhatsApp para manter os
 * blocos `perfil_medico` e `pendencias_e_combinados` enxutos, sem duplicatas e
 * livres de contradições com `estado_vivo_consultorio`.
 */

import OpenAI from 'openai';
import {
  COOLDOWN_SLEEP_TIME_MS,
  MIN_NOVAS_MENSAGENS_SLEEP_TIME,
  sanitizarConteudoBloco,
  type BlocoMemoriaNucleo
} from './blocos-memoria-config.js';
import type { BlocosMemoriaRepositorio } from './blocos-memoria-repositorio.js';
import type { ServicoMemoriaConversa } from './gerenciar-memoria-conversa.js';

export interface EntradaConsolidacaoSleepTime {
  estadoVivoConsultorio: string;
  perfilMedicoAtual: string;
  pendenciasAtuais: string;
  turnosRecentes: readonly string[];
}

export interface SaidaConsolidacaoSleepTime {
  perfilMedico?: string | null;
  pendenciasECombinados?: string | null;
}

export interface ConsolidadorBlocosIa {
  consolidar(entrada: EntradaConsolidacaoSleepTime): Promise<SaidaConsolidacaoSleepTime | null>;
}

const INSTRUCAO_SLEEP_TIME = [
  'Você mantém a memória núcleo de uma secretária médica no WhatsApp (Noto).',
  'Receberá o estado real do banco (`estadoVivoConsultorio`), os blocos atuais (`perfilMedicoAtual` e `pendenciasAtuais`) e os turnos recentes da conversa.',
  'Devolva JSON estrito: {"perfilMedico":"...","pendenciasECombinados":"..."}.',
  'Regras para `perfilMedico`: guarde APENAS preferências pessoais de comunicação e hábitos do consultório que NÃO estejam em `estadoVivoConsultorio` (ex.: como gosta de ser chamado, prefere mensagens bem curtas, revisa notas toda sexta, paciente X não quer nota no WhatsApp). NUNCA copie status de agenda, certificado, fiscal ou regras de comprovante que já vivem em `estadoVivoConsultorio`. Máximo 5 linhas curtas.',
  'Regras para `pendenciasECombinados`: guarde APENAS combinados ou pendências concretas realmente em aberto (ex.: aguardando CPF de paciente X, lembrar sexta de revisar notas). NUNCA grave restrições ou bloqueios repetindo regras de preferência (ex.: NUNCA escreva "emitir apenas após comprovante"). REMOVA imediatamente tudo que já foi resolvido ou contradiga `estadoVivoConsultorio`. Se não houver nada aberto, devolva string vazia "".',
  'NUNCA inclua CPFs, senhas, links ou fatos inventados. Sem repetições. Português direto.'
].join(' ');

export function criarConsolidadorBlocosOpenAi(
  apiKey: string,
  modelo = 'gpt-4.1-mini'
): ConsolidadorBlocosIa {
  const client = new OpenAI({ apiKey, maxRetries: 1 });

  return {
    async consolidar(entrada) {
      if (!apiKey || !entrada.turnosRecentes.length) return null;
      try {
        const resp = await client.responses.create({
          model: modelo,
          instructions: INSTRUCAO_SLEEP_TIME,
          input: JSON.stringify(entrada)
        });
        const texto = resp.output_text?.trim() ?? '';
        const limpo = texto.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
        const json = JSON.parse(limpo) as Record<string, unknown>;
        return {
          perfilMedico: typeof json['perfilMedico'] === 'string' ? json['perfilMedico'] : null,
          pendenciasECombinados: typeof json['pendenciasECombinados'] === 'string'
            ? json['pendenciasECombinados']
            : null
        };
      } catch {
        return null;
      }
    }
  };
}

function extrairBloco(blocos: readonly BlocoMemoriaNucleo[], rotulo: BlocoMemoriaNucleo['rotulo']): string {
  return blocos.find(b => b.rotulo === rotulo)?.conteudo ?? '';
}

export interface ServicoSleepTimeMemoria {
  notificarTurno(contaId: string): void;
  executarAgora(contaId: string): Promise<boolean>;
}

export function criarConsolidadorSleepTime(deps: {
  blocosRepo: BlocosMemoriaRepositorio;
  memoriaConversa: Pick<ServicoMemoriaConversa, 'carregarContexto'>;
  obterEstadoVivo: (contaId: string) => Promise<string>;
  consolidadorIa: ConsolidadorBlocosIa | null;
  cooldownMs?: number;
  minNovasMensagens?: number;
  agora?: () => number;
}): ServicoSleepTimeMemoria {
  const cooldownMs = deps.cooldownMs ?? COOLDOWN_SLEEP_TIME_MS;
  const minNovas = deps.minNovasMensagens ?? MIN_NOVAS_MENSAGENS_SLEEP_TIME;
  const agoraFn = deps.agora ?? (() => Date.now());
  const emExecucao = new Set<string>();
  const ultimoRunPorConta = new Map<string, number>();
  const turnosDesdeRun = new Map<string, number>();

  async function executarAgora(contaId: string): Promise<boolean> {
    if (!contaId || !deps.consolidadorIa || emExecucao.has(contaId)) return false;
    emExecucao.add(contaId);
    try {
      const [blocos, contexto, estadoVivo] = await Promise.all([
        deps.blocosRepo.listarBlocos(contaId),
        deps.memoriaConversa.carregarContexto(contaId),
        deps.obterEstadoVivo(contaId).catch(() => '')
      ]);
      if (!contexto.turnosCurtoPrazo.length) return false;

      const perfilAtual = extrairBloco(blocos, 'perfil_medico');
      const pendenciasAtuais = extrairBloco(blocos, 'pendencias_e_combinados');
      const resultado = await deps.consolidadorIa.consolidar({
        estadoVivoConsultorio: estadoVivo || extrairBloco(blocos, 'estado_vivo_consultorio'),
        perfilMedicoAtual: perfilAtual,
        pendenciasAtuais,
        turnosRecentes: contexto.turnosCurtoPrazo.slice(-16)
      });
      if (!resultado) return false;

      let salvou = false;
      if (typeof resultado.perfilMedico === 'string') {
        const limpo = sanitizarConteudoBloco(resultado.perfilMedico);
        if (limpo !== perfilAtual) {
          await deps.blocosRepo.salvarBloco({
            contaId, rotulo: 'perfil_medico', conteudo: limpo, atualizadoPor: 'sleep_time'
          });
          salvou = true;
        }
      }
      if (typeof resultado.pendenciasECombinados === 'string') {
        const limpo = sanitizarConteudoBloco(resultado.pendenciasECombinados);
        if (limpo !== pendenciasAtuais) {
          await deps.blocosRepo.salvarBloco({
            contaId, rotulo: 'pendencias_e_combinados', conteudo: limpo, atualizadoPor: 'sleep_time'
          });
          salvou = true;
        }
      }
      ultimoRunPorConta.set(contaId, agoraFn());
      turnosDesdeRun.set(contaId, 0);
      return salvou;
    } catch {
      return false;
    } finally {
      emExecucao.delete(contaId);
    }
  }

  function notificarTurno(contaId: string): void {
    if (!contaId || !deps.consolidadorIa) return;
    const contagem = (turnosDesdeRun.get(contaId) ?? 0) + 1;
    turnosDesdeRun.set(contaId, contagem);
    const ultimo = ultimoRunPorConta.get(contaId) ?? 0;
    const passouCooldown = agoraFn() - ultimo >= cooldownMs;
    if (emExecucao.has(contaId)) return;
    if (contagem < minNovas && !passouCooldown) return;
    void executarAgora(contaId);
  }

  return { notificarTurno, executarAgora };
}
