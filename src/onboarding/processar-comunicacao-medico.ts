import { sanitizarTextoMedico } from './contexto-conversa-medico.js';
import { montarPerguntaComunicacao } from './regras/decidir-proxima-acao.js';
import { orquestrarComunicacao } from './orquestrar-comunicacao.js';
import type { HistoricoComunicacaoRepositorio } from './historico-comunicacao-repositorio.js';
import type { ProximaAcaoNoto, ExtratorRespostaMedico } from './regras/decidir-proxima-acao.js';

import type { ConversadorMedico } from './conversador-medico.js';
import type { PostgresMemoriaConversaMedico, MemoriaConversa } from './conversa-repositorio.js';

type Entrada = Parameters<typeof orquestrarComunicacao>[0];
export type EstadoComunicacaoMedico = Pick<Entrada, 'nomeMedico' | 'estado'>;

// Serializa os gatilhos locais para que uma resposta não seja descartada por reserva ocupada.
const processamentos = new Map<string, Promise<ProximaAcaoNoto>>();

/** A comunicação externa recebe apenas ações determinísticas já auditadas. */
export async function processarComunicacaoMedico(
  entrada: Pick<Entrada, 'medicoId' | 'chaveProcessamento' | 'respostaMedico'> & { agora: Date; chaveConversa?: string },
  deps: { ativo: boolean; conversaLivreAtiva?: boolean; memoriaPersistida?: PostgresMemoriaConversaMedico;
    conversador?: Pick<ConversadorMedico, 'responder' | 'resumir'>;
    aoConversar?: (fala: string[], chave: string) => Promise<void>;
    memoriaConversa?: MemoriaConversa; extratorResposta?: ExtratorRespostaMedico; historico: HistoricoComunicacaoRepositorio;
    lerEstado: (medicoId: string, agora: Date) => Promise<EstadoComunicacaoMedico | null>;
    tratarCofre?: (medicoId: string, texto: string) => Promise<boolean>;
    aoDecidir?: (acao: ProximaAcaoNoto, chave: string) => Promise<void>;
    log: (nivel: 'info' | 'erro', mensagem: string) => void }
): Promise<ProximaAcaoNoto> {
  if (!deps.ativo) return { tipo: 'nenhuma' };
  const anterior = processamentos.get(entrada.medicoId);
  const processamento = (anterior ? anterior.catch(() => {}) : Promise.resolve()).then(async (): Promise<ProximaAcaoNoto> => {
    try {
      if (entrada.respostaMedico && await deps.tratarCofre?.(entrada.medicoId, entrada.respostaMedico.texto)) return { tipo: 'nenhuma' };
      if (entrada.respostaMedico && /\b(senha|password|token|secret|segredo|api[_ -]?key)\b/i.test(entrada.respostaMedico.texto)) return { tipo: 'nenhuma' };
      const estado = await deps.lerEstado(entrada.medicoId, entrada.agora);
      if (!estado) return { tipo: 'nenhuma' };
      const memoriaConversa = deps.conversaLivreAtiva === true ? deps.memoriaPersistida : deps.memoriaConversa;
      const conversa = entrada.chaveConversa;
      const respostaMedico = entrada.respostaMedico ? { ...entrada.respostaMedico,
        texto: sanitizarTextoMedico(entrada.respostaMedico.texto),
        mensagensSeguras: memoriaConversa && conversa ? await memoriaConversa.ler(entrada.medicoId, conversa) : entrada.respostaMedico.mensagensSeguras
      } : undefined;
      let semDecisao = false;
      const acao = await orquestrarComunicacao({ ...entrada, ...estado, respostaMedico }, {
        historico: deps.historico, log: deps.log, extratorResposta: deps.extratorResposta,
        aoSemDecisao: deps.conversaLivreAtiva === true ? () => { semDecisao = true; } : undefined
      });
      await deps.aoDecidir?.(acao, entrada.chaveProcessamento);
      if (deps.conversaLivreAtiva === true && acao.tipo === 'nenhuma' && !semDecisao) return acao;
      let fala: string[] | undefined;
      if (deps.conversaLivreAtiva === true && respostaMedico && acao.tipo === 'nenhuma' && deps.conversador) {
        const resumo = conversa ? await deps.memoriaPersistida?.lerResumo(entrada.medicoId, conversa) : null;
        fala = await deps.conversador.responder({ texto: respostaMedico.texto, mensagens: respostaMedico.mensagensSeguras ?? [],
          resumo: resumo?.resumo ?? null, estado: estado.estado });
      }
      if (memoriaConversa && conversa) {
        if (respostaMedico) await memoriaConversa.registrar(entrada.medicoId, conversa, `medico:${entrada.chaveProcessamento}`, respostaMedico.texto);
        const pergunta = fala ? fala.join('\n') : montarPerguntaComunicacao(acao);
        if (pergunta) await memoriaConversa.registrar(entrada.medicoId, conversa, `noto:${entrada.chaveProcessamento}`, pergunta, 'noto');
      }
      if (fala) await deps.aoConversar?.(fala, entrada.chaveProcessamento);
      if (deps.conversaLivreAtiva === true && respostaMedico && conversa && deps.memoriaPersistida && deps.conversador) {
        await atualizarResumo(deps.memoriaPersistida, deps.conversador, entrada.medicoId, conversa);
      }
      return acao;
    } catch {
      deps.log('erro', 'COMUNICACAO_ESTADO_FALHOU');
      return { tipo: 'nenhuma' };
    }
  });
  processamentos.set(entrada.medicoId, processamento);
  try { return await processamento; }
  finally { if (processamentos.get(entrada.medicoId) === processamento) processamentos.delete(entrada.medicoId); }
}

async function atualizarResumo(memoria: PostgresMemoriaConversaMedico, conversador: Pick<ConversadorMedico, 'resumir'>, medicoId: string, conversa: string): Promise<void> {
  try {
    const anterior = await memoria.lerResumo(medicoId, conversa);
    const antigas = await memoria.lerAntigas(medicoId, conversa, anterior?.ateId ?? '0');
    if (antigas.length <= 20) return;
    const resumo = await conversador.resumir({ resumo: anterior?.resumo ?? null, mensagens: antigas.map(mensagem => mensagem.texto) });
    if (resumo !== null) await memoria.gravarResumo(medicoId, conversa, resumo, antigas.at(-1)!.id);
  } catch { /* Resumo é auxiliar: sua indisponibilidade não interrompe a conversa. */ }
}
