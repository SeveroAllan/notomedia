import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvolutionApiClient } from '../src/io/evolution/evolution-api-client.js';

afterEach(() => vi.restoreAllMocks());

describe('presença digitando na Evolution', () => {
  it('inicia composing sem esperar o delay e encerra explicitamente com paused', async () => {
    const chamadas: Array<{ url: string; body: any }> = [];
    let liberarComposing: ((resposta: Response) => void) | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      chamadas.push({ url: String(url), body });
      if (body.presence === 'composing') {
        return await new Promise<Response>(resolve => { liberarComposing = resolve; });
      }
      return new Response(null, { status: 201 });
    });

    const client = new EvolutionApiClient('https://evolution.example', 'chave', 'assistente', 'oficial');
    const sessao = await client.iniciarDigitacao({
      instanciaNome: 'assistente',
      contatoTelefone: '5511999990000@s.whatsapp.net'
    });

    expect(sessao).not.toBeNull();
    expect(chamadas).toEqual([{
      url: 'https://evolution.example/chat/sendPresence/assistente',
      body: { number: '5511999990000', presence: 'composing', delay: 20_000 }
    }]);

    await sessao!.parar();
    expect(chamadas[1]).toEqual({
      url: 'https://evolution.example/chat/sendPresence/assistente',
      body: { number: '5511999990000', presence: 'paused', delay: 1 }
    });

    liberarComposing?.(new Response(null, { status: 201 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(chamadas).toHaveLength(2);
  });

  it('não envia presença pelo canal reservado somente a OTP', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const client = new EvolutionApiClient('https://evolution.example', 'chave', 'assistente', 'oficial');

    expect(await client.iniciarDigitacao({
      instanciaNome: 'oficial',
      contatoTelefone: '5511999990000'
    })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
