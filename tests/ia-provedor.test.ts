import { describe, expect, it, vi } from 'vitest';
import { completarNvidia, completarOpenAi } from '../src/io/nvidia/chat-client.js';

const respostaOk = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"tipo":"ilegivel"}' } }] }), { status: 200 });

describe('fronteira de IA compatível', () => {
  it('OpenAI usa api.openai.com sem campos específicos da NVIDIA', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaOk());
    const out = await completarOpenAi('sk-ficticia', 'gpt-4o-mini', [{ role: 'user', content: 'oi' }], { formatoJson: true, tentativasMax: 1 });
    expect(out).toBe('{"tipo":"ilegivel"}');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const corpo = JSON.parse(String(init.body));
    expect(corpo.model).toBe('gpt-4o-mini');
    expect(corpo.chat_template_kwargs).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-ficticia');
    fetchMock.mockRestore();
  });

  it('NVIDIA mantém endpoint e chat_template_kwargs (legado)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respostaOk());
    await completarNvidia('nvapi-ficticia', 'modelo-ficticio', [{ role: 'user', content: 'oi' }], { tentativasMax: 1 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(JSON.parse(String(init.body)).chat_template_kwargs).toEqual({ thinking: false });
    fetchMock.mockRestore();
  });
});
