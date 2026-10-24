import { afterEach, expect, it, vi } from 'vitest';
import { completarOpenAi } from '../src/io/nvidia/chat-client.js';

afterEach(() => vi.unstubAllGlobals());

it('GPT-6 usa reasoning_effort e max_completion_tokens sem parametros de amostragem', async () => {
  const fetchMock=vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}),{status:200}));
  vi.stubGlobal('fetch',fetchMock);

  await completarOpenAi('k','gpt-6.1-sol',[{role:'user',content:'oi'}],{
    formatoJson:true,reasoningEffort:'medium',temperature:.1,maxTokens:2048,tentativasMax:1
  });

  const corpo=JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(corpo).toMatchObject({model:'gpt-6.1-sol',reasoning_effort:'medium',max_completion_tokens:2048});
  expect(corpo).not.toHaveProperty('temperature');
  expect(corpo).not.toHaveProperty('max_tokens');
});

it('modelo sem raciocinio preserva temperature e max_tokens', async () => {
  const fetchMock=vi.fn(async () =>
    new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'ok'}}]}),{status:200}));
  vi.stubGlobal('fetch',fetchMock);

  await completarOpenAi('k','gpt-4o-mini',[{role:'user',content:'oi'}],{
    temperature:.2,maxTokens:1234,tentativasMax:1
  });

  const corpo=JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(corpo).toMatchObject({model:'gpt-4o-mini',temperature:.2,max_tokens:1234});
  expect(corpo).not.toHaveProperty('reasoning_effort');
  expect(corpo).not.toHaveProperty('max_completion_tokens');
});
