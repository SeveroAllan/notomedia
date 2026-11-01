/** Processo EXCLUSIVO do piloto: não importa src/server, pool global, Supabase
 * service-role, workers fiscais, recuperação de cadastro ou endpoints de escrita.
 * O login/OTP continua na aplicação atual, com autorização e infraestrutura próprias.
 */
import pg from 'pg';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { EvolutionApiClient } from '../io/evolution/evolution-api-client.js';
import { resolverReferenciaAgendaConta } from '../conta/referencia-agenda-conta.js';
import { CofreTribemd } from '../cofre/tribemd-cofre.js';
import { CofreAmplimed } from '../cofre/amplimed-cofre.js';
import { consultarStatusAgendasInterno } from '../cofre/status-interno.js';
import { criarAppPilotoLeitura } from './piloto-app.js';
import { validarBancoPilotoSomenteLeitura } from './banco-piloto.js';

export function validarConfiguracaoPiloto(env: NodeJS.ProcessEnv) {
  const lista = (env['ENVIO_REAL_ALLOWLIST'] ?? '').split(/[,;\s]+/).filter(Boolean);
  if (lista.length !== 1) throw new Error('PILOTO_EXIGE_UM_DESTINATARIO');
  const digitos = lista[0]!.replace(/\D/g, '');
  const telefone = /^\d{10,11}$/.test(digitos) ? '55' + digitos : digitos;
  if (!/^55\d{10,11}$/.test(telefone)) throw new Error('PILOTO_TELEFONE_INVALIDO');
  const databaseUrl = env['NOTO_AGENT_PILOTO_DATABASE_URL']?.trim();
  if (!databaseUrl || databaseUrl === env['DATABASE_URL'] ||
      !/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    throw new Error('PILOTO_EXIGE_DSN_READONLY_SEPARADO');
  }
  if (env['NOTO_AGENT_ATIVO'] !== 'true' || env['NOTO_AGENT_ENVIO_ATIVO'] !== 'true') {
    throw new Error('PILOTO_EXIGE_FLAGS_EXPLICITAS');
  }
  if (!env['OPENAI_API_KEY']?.trim() || !config.evolutionAssistantUrl || !config.evolutionAssistantApiKey ||
    !env['EVOLUTION_ASSISTANT_URL']?.trim() ||\n    !env['EVOLUTION_ASSISTANT_INSTANCE_NAME']?.trim() ||\n    !(env['EVOLUTION_ASSISTANT_GLOBAL_API_KEY'] || env['EVOLUTION_ASSISTANT_API_KEY'])?.trim() ||\n    !env['EVOLUTION_ASSISTANT_WEBHOOK_SECRET']?.trim() ||
    config.evolutionAssistantInstanceName === config.evolutionOfficialInstanceName ||
    env['EVOLUTION_ASSISTANT_WEBHOOK_SECRET'] === env['EVOLUTION_WEBHOOK_SECRET'] ||
    env['EVOLUTION_ASSISTANT_WEBHOOK_SECRET'] === config.evolutionAssistantApiKey) {
    throw new Error('PILOTO_INTEGRACOES_NAO_ISOLADAS');
  }
  return { databaseUrl, telefone };
}

export async function iniciarServidorPiloto(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { databaseUrl, telefone } = validarConfiguracaoPiloto(env);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    // Defesa adicional: o próprio role deve ter SOMENTE SELECT por GRANT.
    // Não usar a chave Supabase service role neste processo.
    options: '-c default_transaction_read_only=on',
    ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1')
      ? false : { rejectUnauthorized: true },
    max: 3, connectionTimeoutMillis: 5000, statement_timeout: 15000
  });
  try {
    // A aplicação não começa a ouvir webhooks até provar a política read-only.
    await validarBancoPilotoSomenteLeitura(pool);
    const diretorio = env['COFRE_DIRETORIO'] || env['TRIBEMD_TESTE_DIRETORIO'];
    const chave = env['COFRE_CHAVE'] || env['TRIBEMD_TESTE_CHAVE'];
    const raiz = diretorio ? join(diretorio, 'cofres-contas-v1') : '';
    // Volume compartilhado deve ser montado SOMENTE LEITURA, e as chaves apenas
    // para descriptografar o estado. Sem volume, informa indisponibilidade.
    const disponivel = Boolean(raiz && chave && existsSync(raiz));
    const cofreTribemd = disponivel ? new CofreTribemd({ diretorio: raiz, chave: chave!, chromium: '/nao-usar-chromium' }) : undefined;
    const cofreAmplimed = disponivel ? new CofreAmplimed({ diretorio: raiz, chave: chave! }) : undefined;
    const evolution = new EvolutionApiClient(config.evolutionAssistantUrl,
      config.evolutionAssistantApiKey, config.evolutionAssistantInstanceName,
      config.evolutionOfficialInstanceName);
    const app = criarAppPilotoLeitura({
      pool, segredo: env['EVOLUTION_ASSISTANT_WEBHOOK_SECRET']!,
      instancia: config.evolutionAssistantInstanceName, telefoneAutorizado: telefone,
      apiKey: config.openaiApiKey, modeloNome: config.openaiTextoModel, painelUrl: config.appPublicOrigin,
      tracesAtivos: config.notoAgentTracesAtivos, diagnosticoAtivo: config.notoAgentDiagnosticoAtivo,
      consultarStatus: medicoId => consultarStatusAgendasInterno({
        medicoId, cofreTribemd, cofreAmplimed,
        resolver: (id, agenda) => resolverReferenciaAgendaConta(pool, id, agenda)
      }),
      enviar: async (destinatario, texto) => {
        if (destinatario !== telefone) return false;
        const r = await evolution.enviarTexto({
          instanciaNome: config.evolutionAssistantInstanceName, contatoTelefone: telefone, texto
        });
        return r.sucesso;
      }
    });
    const servidor = app.listen(config.porta, config.host, () =>
      console.info('[Noto piloto] HTTP somente webhook/health; worker fiscal ausente; role read-only validado.'));
    const encerrar = () => {
      servidor.close(() => { void (async () => {\n        await cofreTribemd?.encerrar().catch(() => {});\n        await pool.end();\n      })(); });
      servidor.closeIdleConnections();
    };
    process.once('SIGINT', encerrar);
    process.once('SIGTERM', encerrar);
  } catch {
    await pool.end();
    throw new Error('PILOTO_FALHA_VALIDACAO_BANCO_OU_INICIALIZACAO');
  }
}

if (process.env['NODE_ENV'] !== 'test') {
  void iniciarServidorPiloto().catch((erro: Error) => {
    console.error('[Noto piloto]', erro.message);
    process.exitCode = 1;
  });
}
