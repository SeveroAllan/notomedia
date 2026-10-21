import { describe, expect, it, vi } from 'vitest';
import { PesquisaRegistroProfissional } from '../src/cadastro/google-registro.js';
import { completarOpenAi } from '../src/io/nvidia/chat-client.js';

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

  it('sem chave OpenAI falha explicitamente antes de qualquer rede', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(completarOpenAi('  ', 'gpt-4o-mini', [{ role: 'user', content: 'oi' }]))
      .rejects.toMatchObject({ codigo: 'IA_NAO_CONFIGURADA' });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});

it('CRM sem chave OpenAI permanece desligado, sem pesquisa ou extração', async () => {
  const pesquisar = vi.fn();
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  const consulta = new PesquisaRegistroProfissional({ fontePesquisa: { configurada: true, origem: 'teste', pesquisar } });
  expect(await consulta.buscar('Medica Ficticia')).toEqual({ estado: 'indisponivel', codigo: 'CRM_FONTE_NAO_CONFIGURADA' });
  expect(pesquisar).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockRestore();
});

it('CRM usa diretamente o endpoint, a chave e o modelo padrão OpenAI', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: '{"registros":[]}' } }]
  }), { status: 200 }));
  const consulta = new PesquisaRegistroProfissional({ openaiApiKey: 'sk-ficticia', fontePesquisa: {
    configurada: true, origem: 'teste', pesquisar: async () => ({ estado: 'consultado', dados: [] })
  } });
  expect(await consulta.buscar('Medica Ficticia')).toEqual({ estado: 'nao_encontrado', codigo: 'NVIDIA_SEM_REGISTROS' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('https://api.openai.com/v1/chat/completions');
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-ficticia');
  expect(JSON.parse(String(init.body)).model).toBe('gpt-4o-mini');
  fetchMock.mockRestore();
});
