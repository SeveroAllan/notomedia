/**
 * Leitura e validação das variáveis de ambiente de infraestrutura e segredos.
 * Este é o único módulo autorizado a interagir com process.env para segredos,
 * isolando regras de negócio e permitindo fallback seguro para desenvolvimento.
 */

import 'dotenv/config';

export interface AppConfig {
  porta: number;
  host: string;
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
  preparacaoFiscalAtiva?: boolean;
  comunicacaoMedicoAtiva?: boolean;
  emissaoComprovanteHomologacaoAtiva?: boolean;
  envioMedicoRealAtivo?: boolean;
  envioPacienteRealAtivo?: boolean;
  envioRealAllowlist?: string[];
  meuDanfeApiKey?: string;
  hubDesenvolvedorToken?: string;
}

export function carregarConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env['PREPARACAO_FISCAL_ATIVA'] === 'true' && env['AGENTE_FISCAL_ATIVO'] !== 'true') {
    throw new Error('PREPARACAO_FISCAL_ATIVA requer AGENTE_FISCAL_ATIVO para tratar pendências sem retentativas cegas.');
  }
  return {
    porta: Number.parseInt(env['PORT'] || '3000', 10),
    host: env['HOST'] || '0.0.0.0',
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
    preparacaoFiscalAtiva: env['PREPARACAO_FISCAL_ATIVA'] === 'true',
    comunicacaoMedicoAtiva: env['COMUNICACAO_MEDICO_ATIVA'] === 'true',
    emissaoComprovanteHomologacaoAtiva: env['EMISSAO_COMPROVANTE_HOMOLOGACAO_ATIVA'] === 'true',
    envioMedicoRealAtivo: env['ENVIO_MEDICO_REAL_ATIVO'] === 'true',
    envioPacienteRealAtivo: env['ENVIO_PACIENTE_REAL_ATIVO'] === 'true',
    envioRealAllowlist: (env['ENVIO_REAL_ALLOWLIST'] || '').split(/[,;\s]+/).filter(Boolean),
    meuDanfeApiKey: env['MEU_DANFE_API_KEY'],
    hubDesenvolvedorToken: env['HUB_DESENVOLVEDOR_TOKEN'],
  };
}

export const config = carregarConfig();
