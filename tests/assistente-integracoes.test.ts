import { afterEach, expect, it, vi } from 'vitest';
import { carregarConfig } from '../src/config.js';
import { criarEnvioAssistente, criarModeloAssistente } from '../src/assistente/integracoes.js';

const telefone = '5551993527271';
const configuracao = () => carregarConfig({
  NOTO_AMBIENTE_OPERACAO: 'homologacao', ENVIO_MEDICO_REAL_ATIVO: 'true', ENVIO_REAL_ALLOWLIST: telefone,
  EVOLUTION_ASSISTANT_URL: 'http://127.0.0.1:9', EVOLUTION_ASSISTANT_API_KEY: 'chave-ficticia',
  EVOLUTION_OFFICIAL_INSTANCE_NAME: 'oficial', EVOLUTION_ASSISTANT_INSTANCE_NAME: 'assistente',
  OPENAI_API_KEY: 'chave-ficticia'
});
afterEach(() => vi.restoreAllMocks());

it('usa OpenAI e o contrato de reasoning da base para o planner gpt-6', async () => {
  const rede = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: '{"resposta":"Olá"}' } }]
  })));
  const modelo = criarModeloAssistente(configuracao(), 'gpt-6.1-sol');
  expect(await modelo([{ role: 'user', content: 'Olá' }])).toBe('{"resposta":"Olá"}');
  expect(rede.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
  const corpo = JSON.parse(String(rede.mock.calls[0][1]?.body));
  expect(corpo).toMatchObject({ model: 'gpt-6.1-sol', reasoning_effort: 'medium', max_completion_tokens: 8192 });
  expect(corpo).not.toHaveProperty('temperature');
});

it('envia pela instância assistente e conserva o bloqueio do canal oficial de OTP', async () => {
  const rede = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ key: { id: 'msg-1' } })));
  expect(await criarEnvioAssistente(configuracao())(telefone, 'Olá')).toMatchObject({ sucesso: true, mensagemId: 'msg-1' });
  expect(rede.mock.calls[0][0]).toBe('http://127.0.0.1:9/message/sendText/assistente');
  const config = configuracao();
  config.evolutionAssistantInstanceName = config.evolutionOfficialInstanceName;
  expect((await criarEnvioAssistente(config)(telefone, 'Olá')).sucesso).toBe(false);
  expect(rede).toHaveBeenCalledTimes(1);
});

it.each(['ambiente', 'flag', 'allowlist'] as const)('não envia quando a trava %s está fechada', async trava => {
  const rede = vi.spyOn(globalThis, 'fetch');
  const config = configuracao();
  if (trava === 'ambiente') config.ambienteOperacao = 'producao';
  if (trava === 'flag') config.envioMedicoRealAtivo = false;
  if (trava === 'allowlist') config.envioRealAllowlist = ['5511888888888'];
  expect(await criarEnvioAssistente(config)(telefone, 'Olá')).toEqual({ sucesso: false });
  expect(rede).not.toHaveBeenCalled();
});
