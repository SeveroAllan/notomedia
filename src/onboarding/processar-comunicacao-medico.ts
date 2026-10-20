import { MemoriaConversaMedico, sanitizarTextoMedico } from './contexto-conversa-medico.js';
import { montarPerguntaComunicacao } from './regras/decidir-proxima-acao.js';
import { orquestrarComunicacao } from './orquestrar-comunicacao.js';
import type { HistoricoComunicacaoRepositorio } from './historico-comunicacao-repositorio.js';
import type { ProximaAcaoNoto, ExtratorRespostaMedico } from './regras/decidir-proxima-acao.js';

type Entrada = Parameters<typeof orquestrarComunicacao>[0];
export type EstadoComunicacaoMedico = Pick<Entrada, 'nomeMedico' | 'estado'>;

// Serializa os gatilhos locais para que uma resposta não seja descartada por reserva ocupada.
const processamentos = new Map<string, Promise<ProximaAcaoNoto>>();

/** A comunicação externa recebe apenas ações determinísticas já auditadas. */
export async function processarComunicacaoMedico(
  entrada: Pick<Entrada, 'medicoId' | 'chaveProcessamento' | 'respostaMedico'> & { agora: Date; chaveConversa?: string },
  deps: { ativo: boolean; memoriaConversa?: MemoriaConversaMedico; extratorResposta?: ExtratorRespostaMedico; historico: HistoricoComunicacaoRepositorio;
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
      const { memoriaConversa } = deps;
      const conversa = entrada.chaveConversa;
      const respostaMedico = entrada.respostaMedico ? { ...entrada.respostaMedico,
        texto: sanitizarTextoMedico(entrada.respostaMedico.texto),
        mensagensSeguras: memoriaConversa && conversa ? memoriaConversa.ler(entrada.medicoId, conversa) : entrada.respostaMedico.mensagensSeguras
      } : undefined;
      const acao = await orquestrarComunicacao({ ...entrada, ...estado, respostaMedico }, { historico: deps.historico, log: deps.log, extratorResposta: deps.extratorResposta });
      await deps.aoDecidir?.(acao, entrada.chaveProcessamento);
      if (memoriaConversa && conversa) {
        if (respostaMedico) memoriaConversa.registrar(entrada.medicoId, conversa, `medico:${entrada.chaveProcessamento}`, respostaMedico.texto);
        const pergunta = montarPerguntaComunicacao(acao);
        if (pergunta) memoriaConversa.registrar(entrada.medicoId, conversa, `noto:${entrada.chaveProcessamento}`, pergunta);
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
