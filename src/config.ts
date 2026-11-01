/**
 * Leitura e validação das variáveis de ambiente de infraestrutura e segredos.
 * Este é o único módulo autorizado a interagir com process.env para segredos,
 * isolando regras de negócio e permitindo fallback seguro para desenvolvimento.
 */

import 'dotenv/config';

export interface AppConfig {
  porta: number;
  host: string;
  appPublicOrigin?: string;
  pareamentoWebhookOrigin?: string;
  databaseUrl: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  encryptionKey: string;
  appPepper: string;
  evolutionApiUrl: string;
  evolutionGlobalApiKey: string;
  evolutionWebhookSecret: string;
  evolutionOfficialInstanceName: string;
  evolutionAssistantUrl: string;
  evolutionAssistantApiKey: string;
  evolutionAssistantInstanceName: string;
  evolutionAssistantWebhookSecret: string;
  loginOtpEmailEnabled?: boolean;
  loginOtpEmailAllowlist?: string[];
  loginOtpEmailFrom?: string;
  resendApiKey?: string;
  devEmailAlerta?: string;
  openserpBaseUrl?: string;
  nvidiaApiKey?: string;
  nvidiaRegistroModel?: string;
  openaiApiKey?: string;
  openaiVisaoModel?: string;
  openaiTextoModel?: string;
  agenteFiscalAtivo?: boolean;
  notoAgentAtivo?: boolean;
  notoAgentEnvioAtivo?: boolean;
  notoAgentTracesAtivos?: boolean;
  notoAgentDiagnosticoAtivo?: boolean;
  notoAgentWebhookSecret?: string;
  workerEmbutidoAtivo?: boolean;
  notoAgentLoginContaExistenteApenas?: boolean;
  notoAgentBoasVindasOtpTesteAtivas?: boolean;
  retomadaRecusaSefinAtiva?: boolean;
  preparacaoFiscalAtiva?: boolean;
  comunicacaoMedicoAtiva?: boolean;
  emissaoComprovanteHomologacaoAtiva?: boolean;
  envioMedicoRealAtivo?: boolean;
  envioPacienteRealAtivo?: boolean;
  envioRealAllowlist?: string[];
  notoPilotoRestrito?: boolean;
  meuDanfeApiKey?: string;
  hubDesenvolvedorToken?: string;
}

export function carregarConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env['PREPARACAO_FISCAL_ATIVA'] === 'true' && env['AGENTE_FISCAL_ATIVO'] !== 'true') {
    throw new Error('PREPARACAO_FISCAL_ATIVA requer AGENTE_FISCAL_ATIVO para tratar pendências sem retentativas cegas.');
  }
  if (env['NOTO_AGENT_BOAS_VINDAS_OTP_TESTE_ATIVAS'] === 'true' &&
      (env['NOTO_AGENT_LOGIN_CONTA_EXISTENTE_APENAS'] !== 'true' ||
       env['NOTO_AGENT_ATIVO'] !== 'true' || env['NOTO_AGENT_ENVIO_ATIVO'] !== 'true')) {
    throw new Error('Boas-vindas do piloto exigem conta preexistente e flags explícitas do agente.');
  }
  if (env['NOTO_PILOTO_RESTRITO'] === 'true') {
    const permitir = (env['ENVIO_REAL_ALLOWLIST'] ?? '').split(/[,;\s]+/).filter(Boolean);
    if (permitir.length !== 1 || !/^(?:55)?\d{10,11}$/.test(permitir[0]!.replace(/\D/g, ''))) {
      throw new Error('HOMOLOGACAO_EXIGE_EXATAMENTE_UM_TELEFONE');
    }
    const origem = env['APP_PUBLIC_ORIGIN']?.trim() ?? '';
    if (!/^https:\/\/[^/]+$/i.test(origem)) {
      throw new Error('HOMOLOGACAO_EXIGE_APP_PUBLIC_ORIGIN_HTTPS');
    }
    if (env['NOTO_WORKER_EMBUTIDO_ATIVO'] !== 'false' ||
        env['AGENTE_FISCAL_ATIVO'] === 'true' ||
        env['PREPARACAO_FISCAL_ATIVA'] === 'true' ||
        env['EMISSAO_COMPROVANTE_HOMOLOGACAO_ATIVA'] === 'true' ||
        env['RETOMADA_RECUSA_SEFIN_ATIVA'] === 'true') {
      throw new Error('HOMOLOGACAO_EXIGE_PROCESSAMENTO_FISCAL_DESLIGADO');
    }
    if (env['NOTO_AGENT_ATIVO'] !== 'true' || env['NOTO_AGENT_ENVIO_ATIVO'] !== 'true' ||
        !env['OPENAI_API_KEY']?.trim()) {
      throw new Error('HOMOLOGACAO_EXIGE_ASSISTENTE_EXPLICITAMENTE_ATIVO');
    }
    const instanciaOtp = env['EVOLUTION_OFFICIAL_INSTANCE_NAME']?.trim();
    const instanciaAgente = env['EVOLUTION_ASSISTANT_INSTANCE_NAME']?.trim();
    if (!instanciaOtp || !instanciaAgente || instanciaOtp === instanciaAgente ||
        instanciaOtp === 'notomed_oficial' || instanciaAgente === 'notomed_assistente' ||
        !env['EVOLUTION_API_URL']?.trim() || !env['EVOLUTION_GLOBAL_API_KEY']?.trim() ||
        !env['EVOLUTION_ASSISTANT_URL']?.trim() ||
        !(env['EVOLUTION_ASSISTANT_GLOBAL_API_KEY'] || env['EVOLUTION_ASSISTANT_API_KEY'])?.trim()) {
      throw new Error('HOMOLOGACAO_EXIGE_EVOLUTION_ISOLADA');
    }
    if (!env['EVOLUTION_WEBHOOK_SECRET']?.trim() ||
        !env['EVOLUTION_ASSISTANT_WEBHOOK_SECRET']?.trim() ||
        env['EVOLUTION_WEBHOOK_SECRET'] === env['EVOLUTION_ASSISTANT_WEBHOOK_SECRET']) {
      throw new Error('HOMOLOGACAO_EXIGE_SEGREDOS_WEBHOOK_DISTINTOS');
    }
  }
  return {
    porta: Number.parseInt(env['PORT'] || '3000', 10),
    host: env['HOST'] || '0.0.0.0',
    appPublicOrigin: env['APP_PUBLIC_ORIGIN']?.trim() || env['COFRE_ORIGEM']?.trim() || undefined,
    pareamentoWebhookOrigin: env['APP_PUBLIC_ORIGIN']?.trim() || undefined,
    databaseUrl: env['DATABASE_URL'] || '',
    supabaseUrl: env['SUPABASE_URL'] || '',
    supabaseServiceRoleKey: env['SUPABASE_SERVICE_ROLE_KEY'] || '',
    encryptionKey: env['ENCRYPTION_KEY'] || 'dev_secret_key_default_32_chars_ok',
    appPepper: env['APP_PEPPER'] || 'dev_pepper_default_secret_string',
    evolutionApiUrl: env['EVOLUTION_API_URL'] || '',
    evolutionGlobalApiKey: env['EVOLUTION_GLOBAL_API_KEY'] || '',
    evolutionWebhookSecret: env['EVOLUTION_WEBHOOK_SECRET'] || '',
    evolutionOfficialInstanceName: env['EVOLUTION_OFFICIAL_INSTANCE_NAME'] || 'notomed_oficial',
    evolutionAssistantUrl: env['EVOLUTION_ASSISTANT_URL'] || env['EVOLUTION_API_URL'] || '',
    evolutionAssistantApiKey: env['EVOLUTION_ASSISTANT_GLOBAL_API_KEY'] || env['EVOLUTION_ASSISTANT_API_KEY'] || env['EVOLUTION_GLOBAL_API_KEY'] || '',
    evolutionAssistantInstanceName: env['EVOLUTION_ASSISTANT_INSTANCE_NAME'] || 'notomed_assistente',
    evolutionAssistantWebhookSecret: env['EVOLUTION_ASSISTANT_WEBHOOK_SECRET'] || env['EVOLUTION_WEBHOOK_SECRET'] || '',
    loginOtpEmailEnabled: env['LOGIN_OTP_EMAIL_ENABLED'] === 'true',
    loginOtpEmailAllowlist: (env['LOGIN_OTP_EMAIL_ALLOWLIST'] || '').split(/[,;\s]+/).filter(Boolean),
    loginOtpEmailFrom: env['LOGIN_OTP_EMAIL_FROM']?.trim() || undefined,
    resendApiKey: env['RESEND_API_KEY'],
    devEmailAlerta: env['DEV_EMAIL_ALERTA'],
    openserpBaseUrl: env['OPENSERP_BASE_URL']?.trim() || undefined,
    nvidiaApiKey: env['NVIDIA_API_KEY']?.trim() || undefined,
    nvidiaRegistroModel: env['NVIDIA_REGISTRO_MODEL']?.trim() || 'meta/llama-3.2-90b-vision-instruct',
    openaiApiKey: env['OPENAI_API_KEY']?.trim() || undefined,
    openaiVisaoModel: env['OPENAI_VISAO_MODEL']?.trim() || 'gpt-4o-mini',
    openaiTextoModel: env['OPENAI_TEXTO_MODEL']?.trim() || 'gpt-4o-mini',
    agenteFiscalAtivo: env['AGENTE_FISCAL_ATIVO'] === 'true',
    notoAgentAtivo: env['NOTO_AGENT_ATIVO'] === 'true',
    notoAgentEnvioAtivo: env['NOTO_AGENT_ENVIO_ATIVO'] === 'true',
    notoAgentTracesAtivos: env['NOTO_AGENT_TRACES_ATIVOS'] === 'true',
    notoAgentDiagnosticoAtivo: env['NOTO_AGENT_DIAGNOSTICO_ATIVO'] === 'true',
    notoAgentWebhookSecret: env['EVOLUTION_ASSISTANT_WEBHOOK_SECRET']?.trim() || '',
    workerEmbutidoAtivo: env['NOTO_WORKER_EMBUTIDO_ATIVO'] !== 'false',
    notoAgentLoginContaExistenteApenas: env['NOTO_AGENT_LOGIN_CONTA_EXISTENTE_APENAS'] === 'true',
    notoAgentBoasVindasOtpTesteAtivas: env['NOTO_AGENT_BOAS_VINDAS_OTP_TESTE_ATIVAS'] === 'true',
    retomadaRecusaSefinAtiva: env['RETOMADA_RECUSA_SEFIN_ATIVA'] === 'true',
    preparacaoFiscalAtiva: env['PREPARACAO_FISCAL_ATIVA'] === 'true',
    comunicacaoMedicoAtiva: env['COMUNICACAO_MEDICO_ATIVA'] === 'true',
    emissaoComprovanteHomologacaoAtiva: env['EMISSAO_COMPROVANTE_HOMOLOGACAO_ATIVA'] === 'true',
    envioMedicoRealAtivo: env['ENVIO_MEDICO_REAL_ATIVO'] === 'true',
    envioPacienteRealAtivo: env['ENVIO_PACIENTE_REAL_ATIVO'] === 'true',
    envioRealAllowlist: (env['ENVIO_REAL_ALLOWLIST'] || '').split(/[,;\s]+/).filter(Boolean),
    notoPilotoRestrito: env['NOTO_PILOTO_RESTRITO'] === 'true',
    meuDanfeApiKey: env['MEU_DANFE_API_KEY'],
    hubDesenvolvedorToken: env['HUB_DESENVOLVEDOR_TOKEN'],
  };
}

export const config = carregarConfig();
