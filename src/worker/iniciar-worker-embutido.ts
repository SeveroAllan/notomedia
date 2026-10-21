import { categoriaFalhaEmissao } from './notificar-erro-medico.js';
import { registroErroNoto } from '../observabilidade/erros.js';
import { ComunicacaoHomologacao } from '../whatsapp/comunicacao-homologacao.js';
import { iniciarAvisosPendenciasProfissionais } from './avisar-pendencias-profissionais.js';
import { PostgresDadosProfissionaisService } from '../io/postgres/postgres-dados-profissionais-service.js';
/**
 * Ciclo de execução embutido do worker de emissão de NFS-e.
 * Permite que a aplicação em container único (Easypanel/VPS) processe
 * a fila 'pronta' sem depender de um processo daemon separado ou cron externo.
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AppConfig } from '../config.js';
import { PostgresFilaRepositorio } from '../io/postgres/postgres-fila-repositorio.js';
import { PostgresEmissorDpsService } from '../io/fiscal/postgres-emissor-dps-service.js';
import { MeuDanfeClient } from '../io/meudanfe/meu-danfe-client.js';
import { HubDesenvolvedorCpfClient } from '../io/hubdodesenvolvedor/hub-desenvolvedor-cpf-client.js';
import { EvolutionApiClient } from '../io/evolution/evolution-api-client.js';
import { createClient } from '@supabase/supabase-js';
import { SefinNacionalClient } from '../io/fiscal/sefin-nacional-client.js';
import { processarItemFila } from './processar-item-fila.js';
import { type NotificadorAlertas } from './notificar-erro-medico.js';

export function iniciarWorkerEmbutido(pool: pg.Pool, config: AppConfig, processarLote?: (executor: import('../io/postgres/postgres-emissao-lote.js').ExecutorFiscalLote) => Promise<boolean>) {
  const workerId = `embedded-${process.pid}-${randomUUID().slice(0, 6)}`;
  const filaRepo = new PostgresFilaRepositorio(pool, config.agenteFiscalAtivo, config.emissaoComprovanteHomologacaoAtiva);
  const meuDanfeClient = config.meuDanfeApiKey ? new MeuDanfeClient(config.meuDanfeApiKey) : undefined;
  const hubCpfClient = config.hubDesenvolvedorToken ? new HubDesenvolvedorCpfClient(config.hubDesenvolvedorToken) : undefined;
  const supabaseClient = config.supabaseUrl && config.supabaseServiceRoleKey
    ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false }
      })
    : undefined;
  const sefinClient = new SefinNacionalClient();

  const emissorDps = new PostgresEmissorDpsService(
    pool,
    config.encryptionKey,
    meuDanfeClient,
    hubCpfClient,
    supabaseClient,
    sefinClient,
    config.agenteFiscalAtivo,
    config.preparacaoFiscalAtiva
  );
  const emissorComprovante = config.emissaoComprovanteHomologacaoAtiva
    ? new PostgresEmissorDpsService(pool, config.encryptionKey, meuDanfeClient, hubCpfClient, supabaseClient, sefinClient, true, true)
    : undefined;
  const evolutionClient = new EvolutionApiClient(
    config.evolutionApiUrl,
    config.evolutionGlobalApiKey,
    config.evolutionOfficialInstanceName, config.evolutionOfficialInstanceName
  );

  const evolutionAssistantClient = new EvolutionApiClient(
    config.evolutionAssistantUrl,
    config.evolutionAssistantApiKey,
    config.evolutionAssistantInstanceName,
    config.evolutionOfficialInstanceName
  );
  const comunicacaoHomologacao = new ComunicacaoHomologacao(pool, config, evolutionAssistantClient);
  const notificadorAlertas: NotificadorAlertas = {
    async notificarMedicoWhatsApp(params) {
      console.warn(registroErroNoto(params.codigoErro ?? 'EMISSAO_FALHOU', categoriaFalhaEmissao(params.codigoErro), { medicoId: params.medicoId, solicitacaoId: params.solicitacaoId, etapa: 'emissao', detalhe: params.motivoErro }));
      if (!params.medicoId || !params.solicitacaoId) {
        throw new Error('Identificadores do médico ou da solicitação ausentes para envio de notificação.');
      }
      await comunicacaoHomologacao.medico({ medicoId: params.medicoId, acao: 'falha_emissao', chave: params.solicitacaoId, motivo: params.codigoErro ?? params.motivoErro });
    },
    async notificarDesenvolvedorEmail(params) {
      if (config.resendApiKey && config.devEmailAlerta) {
        console.error(`[ALERTA DEV] ${params.assunto}: ${params.detalhesErro}`);
      }
    }
  };

  const dadosProfissionais = new PostgresDadosProfissionaisService(pool);
  const avisosProfissionais = iniciarAvisosPendenciasProfissionais(dadosProfissionais);
  let ativo = true;

  const loop = async () => {
    while (ativo) {
      try {
        if (emissorComprovante && await processarLote?.({ emissorDps:emissorComprovante,
          entregar:(medicoId,solicitacaoId)=>comunicacaoHomologacao.paciente({medicoId,solicitacaoId},evolutionClient) })) continue;
        const item = await filaRepo.buscarETravarProximoItem(workerId);
        if (!item) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }

        console.log(`[WorkerEmbutido] Processando solicitação ${item.id} (tentativa ${item.tentativas + 1})...`);
        const res = await processarItemFila(item, {
          filaRepositorio: filaRepo,
          dadosProfissionais,
          emissorDps: item.emissaoComprovante && emissorComprovante ? emissorComprovante : emissorDps,
          enviarPdfDanfse: evolutionClient,
          notificadorAlertas,
          aoAutorizarComprovante: async item => {
            await comunicacaoHomologacao.medico({ medicoId: item.medicoId, acao: 'nota_gerada', chave: item.id });
            await comunicacaoHomologacao.paciente({ medicoId: item.medicoId, solicitacaoId: item.id }, evolutionClient);
          }
        });
        console.log(`[WorkerEmbutido] Solicitação ${item.id} finalizada com status: ${res.status}`);
      } catch (err: any) {
        console.error('[WorkerEmbutido] Erro no ciclo de fila:', err?.message || err);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  };

  const execucao = loop();

  return {
    parar: async () => {
      ativo = false;
      avisosProfissionais.parar();
      await execucao;
    }
  };
}
