import { randomUUID } from 'node:crypto';
import { setTimeout as aguardar } from 'node:timers/promises';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { EvolutionApiClient } from '../io/evolution/evolution-api-client.js';
import { PostgresEmissorDpsService } from '../io/fiscal/postgres-emissor-dps-service.js';
import { SefinNacionalClient } from '../io/fiscal/sefin-nacional-client.js';
import { PostgresFilaRepositorio } from '../io/postgres/postgres-fila-repositorio.js';
import { entregarEmissaoWhatsApp } from './entregar-emissao-whatsapp.js';
import { processarItemFila } from './processar-item-fila.js';

async function iniciar():Promise<void> {
  const escopo = config.emissaoWhatsAppWorker;
  if (!escopo) return;
  const telefone = config.envioRealAllowlist?.[0];
  if (!telefone || !config.supabaseUrl || !config.supabaseServiceRoleKey || !config.encryptionKey)
    throw new Error('WORKER_WHATSAPP_INTEGRACOES_INCOMPLETAS');

  const pool = new pg.Pool({connectionString:config.databaseUrl,max:2,connectionTimeoutMillis:5000});
  const storage = createClient(config.supabaseUrl,config.supabaseServiceRoleKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const evolution = new EvolutionApiClient(config.evolutionAssistantUrl,config.evolutionAssistantApiKey,
    config.evolutionAssistantInstanceName,config.evolutionOfficialInstanceName);
  const filaRepositorio = new PostgresFilaRepositorio(pool,true,true,escopo);
  const emissorDps = new PostgresEmissorDpsService(pool,config.encryptionKey,undefined,undefined,storage,
    new SefinNacionalClient(),true,true,false,true);
  const workerId = 'whatsapp-homologacao-'+randomUUID();
  const parada = new AbortController();
  const parar = () => parada.abort();
  process.once('SIGINT',parar);
  process.once('SIGTERM',parar);
  try {
    while (!parada.signal.aborted) {
      const item = await filaRepositorio.buscarETravarProximoItem(workerId);
      if (item) {
        await processarItemFila(item,{
          filaRepositorio,emissorDps,enviarPdfDanfse:evolution,
          notificadorAlertas:{notificarMedicoWhatsApp:async()=>{},notificarDesenvolvedorEmail:async()=>{}},
          aoAutorizarComprovante: item => entregarEmissaoWhatsApp(pool,storage,evolution,escopo,item.id,
            config.evolutionAssistantInstanceName,telefone)
        });
      } else {
        await aguardar(5000,undefined,{signal:parada.signal}).catch(erro=>{if(!parada.signal.aborted)throw erro;});
      }
    }
  } finally {
    process.removeListener('SIGINT',parar);
    process.removeListener('SIGTERM',parar);
    await pool.end();
  }
}

void iniciar().catch(()=>{
  console.error('WORKER_WHATSAPP_FALHOU');
  process.exitCode=1;
});
