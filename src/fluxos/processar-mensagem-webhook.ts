import { createHash } from 'node:crypto';
/**
 * Orquestrador central do webhook da Evolution API.
 * Valida autenticidade e payload, extrai contato e direciona para:
 * Conexão, histórico e persistência de mensagens.
 * Não aprova notas, não inicia IA e não responde por fluxos antigos.
 */

import { validarWebhookSecret } from '../whatsapp/validar-webhook-secret.js';
import { conexaoWebhookSchema } from '../whatsapp/payload-conexao-webhook-schema.js';
import { extrairTelefoneJid } from '../whatsapp/extrair-telefone-jid.js';
import {
  webhookEvolutionSchema,
  extrairTextoMensagem,
  extrairTipoMensagem,
  type DadosMensagemEvolution
} from '../whatsapp/payload-webhook-schema.js';
import type { AtendimentoRepositorio } from '../atendimento/atendimento-repositorio.js';
import type { ConsultaCpfProvider } from '../paciente/consulta-cpf-provider.js';
import {
  ehEventoHistorico,
  ehEventoSincronizacaoAuxiliar
} from '../whatsapp/payload-historico-webhook-schema.js';
import { processarHistoricoWebhook } from './processar-historico-webhook.js';


export interface ProcessarWebhookDeps {
  repositorio: AtendimentoRepositorio;
  consultaCpfProvider?: ConsultaCpfProvider;
  segredoConfigurado: string;
  pepper: string;
  instanciaOficialNome?: string;
  instanciaAssistenteNome?: string;
  comunicacaoMedicoAtiva?: boolean;
  reservarMensagemMedico?: (medicoId: string, instancia: string, mensagemId: string) => Promise<boolean>;
  aoReceberMensagemMedico?: (contexto: { medicoId: string; texto: string; chaveMensagem: string; chaveWhatsApp: import('../whatsapp/marcar-mensagem-lida.js').ChaveMensagemLeitura; chavePergunta?: string; chaveConversa: string; dataMensagem: string | null }) => Promise<unknown>;
  aoAtualizarConexao?: (evento: { instancia: string; state: 'open' | 'close' | 'connecting' }) => Promise<void>;
  aoReceberComprovante?: (contexto: { medicoId: string; pacienteId: string; mensagem: DadosMensagemEvolution }) => Promise<unknown>;
}

export type ResultadoProcessarWebhook =
  | {
      ok: true;
      acao: 'mensagem_registrada' | 'historico_sincronizado' | 'conexao_atualizada' | 'descartada';
      detalhe?: any;
      motivoDescarte?: 'sem_tratador_conexao' | 'sincronizacao_auxiliar' | 'contato_nao_identificado' | 'mensagem_sem_texto' | 'mensagem_enviada_pelo_oficial' | 'mensagem_enviada_pelo_assistente' | 'mensagem_recebida_do_paciente' | 'gatilho_nao_reconhecido' | 'canal_oficial_somente_otp' | 'historico_assistente_ignorado' | 'medico_nao_identificado' | 'mensagem_duplicada';
    }
  | { ok: false; motivo: 'autenticacao_invalida' | 'payload_invalido' | 'instancia_nao_encontrada' };

export async function processarMensagemWebhook(
  payloadBruto: unknown,
  tokenRecebido: string | undefined | null,
  deps: ProcessarWebhookDeps
): Promise<ResultadoProcessarWebhook> {
  if (!deps.segredoConfigurado || !validarWebhookSecret(tokenRecebido, deps.segredoConfigurado)) {
    return { ok: false, motivo: 'autenticacao_invalida' };
  }

  const instanciaRecebida=payloadBruto&&typeof payloadBruto==='object'?(payloadBruto as Record<string,unknown>).instance:null;
  if(instanciaRecebida===(deps.instanciaOficialNome||'notomed_oficial'))return {ok:true,acao:'descartada',motivoDescarte:'canal_oficial_somente_otp'};
  if(instanciaRecebida===deps.instanciaAssistenteNome&&ehEventoHistorico(payloadBruto))return {ok:true,acao:'descartada',motivoDescarte:'historico_assistente_ignorado'};

  const conexao = conexaoWebhookSchema.safeParse(payloadBruto);
  if (conexao.success) {
    if (!deps.segredoConfigurado) return { ok: false, motivo: 'autenticacao_invalida' };
    if (!deps.aoAtualizarConexao) return { ok: true, acao: 'descartada', motivoDescarte: 'sem_tratador_conexao' };
    await deps.aoAtualizarConexao({ instancia: conexao.data.instance, state: conexao.data.data.state });
    return { ok: true, acao: 'conexao_atualizada' };
  }

  if (ehEventoHistorico(payloadBruto)) {
    const resultado = await processarHistoricoWebhook(payloadBruto, deps);
    if (!resultado.ok) return resultado;
    return { ok: true, acao: resultado.acao, detalhe: resultado };
  }
  if (ehEventoSincronizacaoAuxiliar(payloadBruto)) {
    return { ok: true, acao: 'descartada', motivoDescarte: 'sincronizacao_auxiliar' };
  }

  const parsed = webhookEvolutionSchema.safeParse(payloadBruto);
  if (!parsed.success) return { ok: false, motivo: 'payload_invalido' };

  const payload = parsed.data;
  const jidPrincipal = payload.data.key.remoteJid;
  if (jidPrincipal.endsWith('@g.us')) return { ok: true, acao: 'descartada', motivoDescarte: 'contato_nao_identificado' };
  const jidAlternativo = payload.data.key.remoteJidAlt;
  const telefone =
    extrairTelefoneJid(jidAlternativo) ||
    extrairTelefoneJid(jidPrincipal);
  const tipo = extrairTipoMensagem(payload.data);
  const texto = extrairTextoMensagem(payload.data) || '';
  if (!telefone) return { ok: true, acao: 'descartada', motivoDescarte: 'contato_nao_identificado' };
  if (!texto && tipo === 'texto') return { ok: true, acao: 'descartada', motivoDescarte: 'mensagem_sem_texto' };

  if (payload.instance === deps.instanciaAssistenteNome) {
    if (deps.comunicacaoMedicoAtiva && !payload.data.key.fromMe && tipo === 'texto' && deps.aoReceberMensagemMedico) {
      try {
        const medico = await deps.repositorio.buscarMedicoPorTelefone(telefone);
        if (medico) {
          if (deps.reservarMensagemMedico && !await deps.reservarMensagemMedico(medico.id, payload.instance, payload.data.key.id)) return { ok: true, acao: 'descartada', motivoDescarte: 'mensagem_duplicada' };
          const bruto = payload.data.messageTimestamp;
          const numero = typeof bruto === 'number' ? bruto : typeof bruto === 'string' && bruto.trim() ? Number(bruto) : NaN;
          const data = new Date(numero > 1e11 ? numero : numero * 1000);
          const dataMensagem = Number.isFinite(data.getTime()) ? data.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }) : null;
          const chaveConversa = createHash('sha256').update(JSON.stringify([payload.instance, telefone])).digest('hex');
          const referencia = payload.data.message?.extendedTextMessage?.contextInfo;
          const chavePergunta = referencia && typeof referencia === 'object' && 'stanzaId' in referencia && typeof referencia.stanzaId === 'string' ? referencia.stanzaId : undefined;
          await deps.aoReceberMensagemMedico({ medicoId: medico.id, texto, chaveMensagem: payload.data.key.id, chaveWhatsApp: payload.data.key, chaveConversa, dataMensagem, ...(chavePergunta ? { chavePergunta } : {}) });
        }
      } catch { console.error('COMUNICACAO_MEDICO_CICLO_FALHOU'); }
    }
    return { ok: true, acao: 'descartada', motivoDescarte: 'gatilho_nao_reconhecido' };
  }

  const instancia = await deps.repositorio.buscarInstanciaPorNome(payload.instance);
  if (!instancia) return { ok: false, motivo: 'instancia_nao_encontrada' };

  if(instancia.oficial)return {ok:true,acao:'descartada',motivoDescarte:'canal_oficial_somente_otp'};
  const medico=await deps.repositorio.buscarMedicoPorTelefone(telefone);
  const medicoId = instancia.medicoId || medico?.id || null;

  const conversa = await deps.repositorio.buscarOuCriarConversa(instancia.id, medicoId, telefone);
  if (conversa.medicoId) {
    const paciente = await deps.repositorio.criarPacienteMinimo({
      medicoId: conversa.medicoId,
      telefone,
      nome: null, // Nunca salvar o nome do paciente pelo nome/pushName do WhatsApp
      origemCadastro: 'conversa_whatsapp'
    });
    if (conversa.pacienteId !== paciente.id) {
      await deps.repositorio.vincularPacienteConversa(conversa.id, paciente.id);
      conversa.pacienteId = paciente.id;
    }
  }
  // Documentos são analisados uma vez pelo localizador em segundo plano.

  if (deps.repositorio.salvarMensagem) {
    await deps.repositorio.salvarMensagem({
      conversaId: conversa.id,
      direcao: payload.data.key.fromMe ? 'enviada' : 'recebida',
      tipoMensagem: tipo,
      conteudo: texto,
      payloadBruto: payload.data
    });
  }
  const midiaComprovante = !!payload.data.message?.imageMessage || payload.data.message?.documentMessage?.mimetype === 'application/pdf';
  if (deps.aoReceberComprovante && !payload.data.key.fromMe && midiaComprovante && conversa.medicoId && conversa.pacienteId) {
    try {
      await deps.aoReceberComprovante({ medicoId: conversa.medicoId, pacienteId: conversa.pacienteId, mensagem: payload.data });
    } catch {
      console.error('COMPROVANTE_CICLO_FALHOU');
    }
  }
  return {ok:true,acao:'mensagem_registrada'};
}
