import type { AppConfig } from '../config.js';
import { completarOpenAi } from '../io/nvidia/chat-client.js';
import { EvolutionApiClient } from '../io/evolution/evolution-api-client.js';
import { operacaoHomologacaoExplicita, telefoneNaAllowlist } from '../whatsapp/ambiente-operacao-homolog.js';
import type { ModeloAssistente } from './conversa.js';

export function criarModeloAssistente(config: AppConfig, modelo: string): ModeloAssistente {
  return mensagens => completarOpenAi(config.openaiApiKey ?? '', modelo, mensagens,
    { formatoJson: true, tentativasMax: 1, timeoutMs: 60000,
      ...(modelo.startsWith('gpt-6') ? { reasoningEffort: 'medium', maxTokens: 8192 } : { temperature: 0.2 }) });
}

export function criarEnvioAssistente(config: AppConfig) {
  const evolution = new EvolutionApiClient(config.evolutionAssistantUrl, config.evolutionAssistantApiKey,
    config.evolutionOfficialInstanceName, config.evolutionOfficialInstanceName);
  return async (telefone: string, texto: string) => {
    if (!operacaoHomologacaoExplicita(config) || !config.envioMedicoRealAtivo || !telefoneNaAllowlist(config, telefone)) {
      return { sucesso: false };
    }
    return evolution.enviarTexto({ instanciaNome: config.evolutionAssistantInstanceName, contatoTelefone: telefone, texto });
  };
}
