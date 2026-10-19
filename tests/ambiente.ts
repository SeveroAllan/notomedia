import { vi } from 'vitest';

// Imports de infraestrutura não podem consumir credenciais do ambiente real.
for (const nome of [
  'DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'EVOLUTION_GLOBAL_API_KEY',
  'EVOLUTION_WEBHOOK_SECRET', 'EVOLUTION_ASSISTANT_API_KEY', 'NVIDIA_API_KEY',
  'HUB_DESENVOLVEDOR_TOKEN', 'MEU_DANFE_API_KEY', 'OPENSERP_BASE_URL',
  'COFRE_ORIGEM', 'COFRE_CHAVE', 'COFRE_DIRETORIO', 'TRIBEMD_TESTE_ORIGEM',
  'TRIBEMD_TESTE_CHAVE', 'TRIBEMD_TESTE_DIRETORIO'
]) vi.stubEnv(nome, '');
vi.stubEnv('ENVIO_REAL_ALLOWLIST', '');
vi.stubEnv('DOTENV_CONFIG_PATH', '/dev/null');
vi.stubEnv('SUPABASE_URL', 'https://supabase.invalid');
vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'credencial-ficticia-de-teste');
vi.stubEnv('ENCRYPTION_KEY', 'chave-ficticia-de-testes');
vi.stubEnv('APP_PEPPER', 'pepper-ficticio-de-testes');
for (const nome of ['AGENTE_FISCAL_ATIVO', 'PREPARACAO_FISCAL_ATIVA', 'ENVIO_MEDICO_REAL_ATIVO', 'ENVIO_PACIENTE_REAL_ATIVO', 'EMISSAO_COMPROVANTE_HOMOLOGACAO_ATIVA']) vi.stubEnv(nome, 'false');

const fetchLocal = globalThis.fetch;
vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('REDE_EXTERNA_PROIBIDA_NOS_TESTES');
  }
  return fetchLocal(input, init);
});
