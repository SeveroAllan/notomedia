import { describe, expect, it } from 'vitest';
import { carregarConfig } from '../src/config.js';

const homologacao: NodeJS.ProcessEnv = {
  NOTO_PILOTO_RESTRITO: 'true',
  ENVIO_REAL_ALLOWLIST: '5511999990000',
  APP_PUBLIC_ORIGIN: 'https://homologacao.example.test',
  NOTO_WORKER_EMBUTIDO_ATIVO: 'false',
  AGENTE_FISCAL_ATIVO: 'false',
  PREPARACAO_FISCAL_ATIVA: 'false',
  EMISSAO_COMPROVANTE_HOMOLOGACAO_ATIVA: 'false',
  RETOMADA_RECUSA_SEFIN_ATIVA: 'false',
  NOTO_AGENT_ATIVO: 'true',
  NOTO_AGENT_ENVIO_ATIVO: 'true',
  OPENAI_API_KEY: 'chave-ficticia',
  EVOLUTION_API_URL: 'https://otp.example.test',
  EVOLUTION_GLOBAL_API_KEY: 'chave-otp-ficticia',
  EVOLUTION_OFFICIAL_INSTANCE_NAME: 'homologacao_otp',
  EVOLUTION_ASSISTANT_URL: 'https://assistente.example.test',
  EVOLUTION_ASSISTANT_API_KEY: 'chave-agente-ficticia',
  EVOLUTION_ASSISTANT_INSTANCE_NAME: 'homologacao_agente',
  EVOLUTION_WEBHOOK_SECRET: 'segredo-otp-ficticio',
  EVOLUTION_ASSISTANT_WEBHOOK_SECRET: 'segredo-agente-ficticio'
};

describe('configuracao fail-closed da homologacao', () => {
  it('carrega somente o ambiente isolado e restrito', () => {
    const config = carregarConfig({ ...homologacao });
    expect(config.notoPilotoRestrito).toBe(true);
    expect(config.workerEmbutidoAtivo).toBe(false);
    expect(config.pareamentoWebhookOrigin).toBe('https://homologacao.example.test');
    expect(config.envioRealAllowlist).toEqual(['5511999990000']);
  });

  it('permite a instancia oficial existente como remetente OTP somente-saida', () => {
    const config = carregarConfig({ ...homologacao, EVOLUTION_OFFICIAL_INSTANCE_NAME: 'notomed_oficial' });
    expect(config.evolutionOfficialInstanceName).toBe('notomed_oficial');
    expect(config.evolutionAssistantInstanceName).toBe('homologacao_agente');
  });

  it('ainda rejeita assistente igual ao remetente OTP', () => {
    expect(() => carregarConfig({ ...homologacao,
      EVOLUTION_OFFICIAL_INSTANCE_NAME: 'notomed_oficial',
      EVOLUTION_ASSISTANT_INSTANCE_NAME: 'notomed_oficial'
    })).toThrow('HOMOLOGACAO_EXIGE_EVOLUTION_ISOLADA');
  });

  it.each([
    [{ ENVIO_REAL_ALLOWLIST: '' }, 'HOMOLOGACAO_EXIGE_EXATAMENTE_UM_TELEFONE'],
    [{ ENVIO_REAL_ALLOWLIST: '5511999990000,5511988881111' }, 'HOMOLOGACAO_EXIGE_EXATAMENTE_UM_TELEFONE'],
    [{ APP_PUBLIC_ORIGIN: '', COFRE_ORIGEM: 'https://antigo.example.test' }, 'HOMOLOGACAO_EXIGE_APP_PUBLIC_ORIGIN_HTTPS'],
    [{ APP_PUBLIC_ORIGIN: 'http://homologacao.example.test' }, 'HOMOLOGACAO_EXIGE_APP_PUBLIC_ORIGIN_HTTPS'],
    [{ NOTO_WORKER_EMBUTIDO_ATIVO: 'true' }, 'HOMOLOGACAO_EXIGE_PROCESSAMENTO_FISCAL_DESLIGADO'],
    [{ AGENTE_FISCAL_ATIVO: 'true' }, 'HOMOLOGACAO_EXIGE_PROCESSAMENTO_FISCAL_DESLIGADO'],
    [{ NOTO_AGENT_ENVIO_ATIVO: 'false' }, 'HOMOLOGACAO_EXIGE_ASSISTENTE_EXPLICITAMENTE_ATIVO'],
    [{ EVOLUTION_ASSISTANT_INSTANCE_NAME: 'homologacao_otp' }, 'HOMOLOGACAO_EXIGE_EVOLUTION_ISOLADA'],
    [{ EVOLUTION_ASSISTANT_INSTANCE_NAME: 'notomed_assistente' }, 'HOMOLOGACAO_EXIGE_EVOLUTION_ISOLADA'],
    [{ EVOLUTION_ASSISTANT_WEBHOOK_SECRET: 'segredo-otp-ficticio' }, 'HOMOLOGACAO_EXIGE_SEGREDOS_WEBHOOK_DISTINTOS']
  ] as const)('rejeita configuracao insegura: %j', (sobrescrever, codigo) => {
    expect(() => carregarConfig({ ...homologacao, ...sobrescrever })).toThrow(codigo);
  });
});
