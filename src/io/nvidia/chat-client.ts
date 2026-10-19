/** Uma fronteira de IA: nunca propaga corpos do provedor ou segue redirects. Compatível com NVIDIA e OpenAI. */
export class ErroNvidiaChat extends Error {
  constructor(public readonly codigo: string, public readonly statusHttp?: number) {
    super('A resposta da NVIDIA não foi concluída.');
  }
}
export type MensagemNvidia = { role: 'system' | 'user'; content: unknown };

export interface OpcoesCompletarNvidia {
  timeoutMs?: number;
  temperature?: number;
  formatoJson?: boolean;
  maxTokens?: number;
  tentativasMax?: 1 | 2;
}

const tempoEsgotado = (erro: unknown): boolean => erro instanceof Error && ['TimeoutError', 'AbortError'].includes(erro.name);

export interface ProvedorIaCompativel { baseUrl: string; apiKey: string; extraBody?: Record<string, unknown> }

const PROVEDOR_NVIDIA: Omit<ProvedorIaCompativel, 'apiKey'> = { baseUrl: 'https://integrate.api.nvidia.com/v1', extraBody: { chat_template_kwargs: { thinking: false } } };
const PROVEDOR_OPENAI: Omit<ProvedorIaCompativel, 'apiKey'> = { baseUrl: 'https://api.openai.com/v1' };

export async function completarOpenAi(
  apiKey: string, model: string, messages: MensagemNvidia[], opcoesOuTimeout: number | OpcoesCompletarNvidia = 90_000
): Promise<string> {
  return completarChatCompativel({ ...PROVEDOR_OPENAI, apiKey }, model, messages, opcoesOuTimeout);
}

export async function completarNvidia(
  apiKey: string, model: string, messages: MensagemNvidia[], opcoesOuTimeout: number | OpcoesCompletarNvidia = 90_000
): Promise<string> {
  return completarChatCompativel({ ...PROVEDOR_NVIDIA, apiKey }, model, messages, opcoesOuTimeout);
}

export async function completarChatCompativel(
  provedor: ProvedorIaCompativel, model: string, messages: MensagemNvidia[], opcoesOuTimeout: number | OpcoesCompletarNvidia = 90_000
): Promise<string> {
  const apiKey = provedor.apiKey;
  if (!apiKey.trim()) throw new ErroNvidiaChat('IA_NAO_CONFIGURADA');
  const timeoutMs = typeof opcoesOuTimeout === 'number' ? opcoesOuTimeout : (opcoesOuTimeout.timeoutMs ?? 90_000);
  const temperature = typeof opcoesOuTimeout === 'object' && typeof opcoesOuTimeout.temperature === 'number' ? opcoesOuTimeout.temperature : 1;
  const formatoJson = typeof opcoesOuTimeout === 'object' && opcoesOuTimeout.formatoJson === true;
  const maxTokens = typeof opcoesOuTimeout === 'object' ? (opcoesOuTimeout.maxTokens ?? 4096) : 4096;
  let response: Response | undefined;
  const tentativasMax = typeof opcoesOuTimeout === 'object' ? (opcoesOuTimeout.tentativasMax ?? 2) : 2;
  for (let tentativa = 1; tentativa <= tentativasMax; tentativa++) {
    try {
      response = await fetch(`${provedor.baseUrl}/chat/completions`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          model, stream: false, temperature, max_tokens: maxTokens,
          ...(formatoJson ? { response_format: { type: 'json_object' } } : {}),
          ...(provedor.extraBody ?? {}), messages
        })
      });
      break;
    } catch (erro) {
      if (tentativa === tentativasMax) throw new ErroNvidiaChat(tempoEsgotado(erro) ? 'IA_TEMPO_ESGOTADO' : 'IA_CONEXAO_FALHOU');
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  if (!response || !response.ok) {
    if (response) await response.body?.cancel().catch(() => {});
    throw new ErroNvidiaChat('IA_HTTP_ERRO', response?.status);
  }
  try {
    const data = await response.json() as { choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }> };
    const choice = data.choices?.[0];
    if (choice?.finish_reason && choice.finish_reason !== 'stop') throw Error('incompleta');
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content.trim() || content.length > 32_768) throw Error('conteudo');
    return content;
  } catch (erro) { throw new ErroNvidiaChat(tempoEsgotado(erro) ? 'IA_TEMPO_ESGOTADO' : 'IA_RESPOSTA_INVALIDA', response.status); }
}
