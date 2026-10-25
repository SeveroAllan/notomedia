/**
 * Gerenciador de conexão da instância individual do WhatsApp do médico na Evolution API.
 * Cria a instância dedicada, configura os webhooks da aplicação Notomed e devolve
 * o QR Code (para desktop) ou Pairing Code (para celular) nativo (seção 1 e 7 do plano).
 */

import type pg from 'pg';
import { configurarSincronizacaoHistorico } from './configurar-sincronizacao-historico.js';

export type IniciarConexaoWhatsappInput = {
  medicoId: string;
  telefoneConsultorio?: string;
  modoConexao?: 'codigo' | 'qrcode';
  evolutionUrl: string;
  evolutionApiKey: string;
  appWebhookUrl: string;
  webhookSecret: string;
  aoConectar?: (medicoId: string) => void;
};

export type ResultadoConexaoWhatsapp = {
  ok: boolean;
  nomeInstancia: string;
  status: string;
  qrcodeBase64?: string | null;
  pairingCode?: string | null;
  detalhe?: string;
  diagnostico?: {
    etapa: 'instance/create' | 'instance/connect' | 'settings/set';
    codigo: 'HTTP_ERRO' | 'CONEXAO_FALHOU' | 'CODIGO_NAO_GERADO';
    statusHttp?: number;
  };
};

function formatarTelefonePareamento(telefone?: string): string | undefined {
  const digitos = telefone?.replace(/\D/g, '') || '';
  if (!digitos) return undefined;
  if ((digitos.length === 10 || digitos.length === 11) && !digitos.startsWith('55')) {
    return `55${digitos}`;
  }
  return digitos;
}

export async function conectarInstanciaWhatsappMedico(
  pool: pg.Pool,
  input: IniciarConexaoWhatsappInput
): Promise<ResultadoConexaoWhatsapp> {
  const { medicoId, evolutionUrl, evolutionApiKey, appWebhookUrl, webhookSecret } = input;
  const baseUrl = evolutionUrl.replace(/\/+$/, '');
  const contextoConta=(await pool.query(`
    select m.conta_id,
      (select w.nome_instancia from whatsapp_instancias w
       where w.conta_id=m.conta_id and w.oficial=false
       order by w.conectado_em desc nulls last, w.id
       limit 1) as nome_instancia,
      (select u.telefone from usuarios u
       where u.conta_id=m.conta_id and u.ativo=true and nullif(regexp_replace(coalesce(u.telefone,''),'\\D','','g'),'') is not null
       order by case when u.id=m.usuario_id then 0 else 1 end, u.id
       limit 1) as telefone_conta
    from medicos m where m.id=$1
  `,[medicoId])).rows[0];
  if(!contextoConta)throw new Error('MEDICO_NAO_ENCONTRADO');
  const nomeInstancia = contextoConta.nome_instancia ?? `medico_${medicoId.replace(/-/g, '').slice(0, 12)}`;
  const porQrCode = input.modoConexao === 'qrcode';
  const falhar = (diagnostico: NonNullable<ResultadoConexaoWhatsapp['diagnostico']>): ResultadoConexaoWhatsapp => ({
    ok: false, nomeInstancia, status: 'erro', diagnostico,
    detalhe: porQrCode
      ? 'Não foi possível gerar o QR Code. Tente novamente. Se continuar, contate o suporte.'
      : 'Não foi possível gerar o código de conexão. Tente conectar por QR Code.'
  });
  let diagnostico: ResultadoConexaoWhatsapp['diagnostico'];
  let telefonePareamento = porQrCode ? undefined : formatarTelefonePareamento(input.telefoneConsultorio);

  if (!porQrCode && !telefonePareamento)
    telefonePareamento = formatarTelefonePareamento(contextoConta.telefone_conta);

  let qrcodeBase64: string | null = null;
  let pairingCode: string | null = null;
  let status = 'connecting';
  let instanciaCriadaComHistorico = false;

  // 1. Tenta criar a instância na Evolution API (ou conectar se já existir)
  try {
    const bodyCreate: Record<string, any> = {
      instanceName: nomeInstancia,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: !telefonePareamento,
      syncFullHistory: true
    };
    if (telefonePareamento) {
      bodyCreate.number = telefonePareamento;
    }

    const resCreate = await fetch(`${baseUrl}/instance/create`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'Content-Type': 'application/json',
        apikey: evolutionApiKey
      },
      body: JSON.stringify(bodyCreate)
    });

    const dataCreate = await resCreate.json().catch(() => ({}));
    instanciaCriadaComHistorico = resCreate.ok;
    if (!resCreate.ok) diagnostico = { etapa: 'instance/create', codigo: 'HTTP_ERRO', statusHttp: resCreate.status };
    if (resCreate.ok && dataCreate.qrcode?.base64) {
      qrcodeBase64 = dataCreate.qrcode.base64;
    }
    if (resCreate.ok && !porQrCode && dataCreate.pairingCode) {
      pairingCode = dataCreate.pairingCode;
    }
  } catch (err) {
    diagnostico = { etapa: 'instance/create', codigo: 'CONEXAO_FALHOU' };
    // Continua para tentar /instance/connect caso já exista
  }

  // Garante a opção também em instâncias criadas antes desta implementação.
  let historicoConfigurado = false;
  try {
    historicoConfigurado = await configurarSincronizacaoHistorico({
      baseUrl,
      nomeInstancia,
      apiKey: evolutionApiKey
    });
  } catch {
    historicoConfigurado = false;
  }
  if (!instanciaCriadaComHistorico && !historicoConfigurado) {
    return falhar(diagnostico?.statusHttp === 409
      ? { etapa: 'settings/set', codigo: 'CONEXAO_FALHOU' }
      : diagnostico || { etapa: 'settings/set', codigo: 'CONEXAO_FALHOU' });
  }

  // 2. Com telefone cadastrado, solicita explicitamente o codigo de pareamento.
  // Sem telefone, preserva o QR Code como alternativa.
  if ((telefonePareamento && !pairingCode) || (!telefonePareamento && !qrcodeBase64 && !pairingCode)) {
    try {
      const urlConnect = telefonePareamento
        ? `${baseUrl}/instance/connect/${nomeInstancia}?number=${telefonePareamento}`
        : `${baseUrl}/instance/connect/${nomeInstancia}`;

      const resConnect = await fetch(urlConnect, {
        method: 'GET',
        signal: AbortSignal.timeout(15_000),
        headers: { apikey: evolutionApiKey }
      });
      const dataConnect = await resConnect.json().catch(() => ({}));
      if (!resConnect.ok) {
        diagnostico = { etapa: 'instance/connect', codigo: 'HTTP_ERRO', statusHttp: resConnect.status };
      } else {
        diagnostico = undefined;
        pairingCode = porQrCode ? null : (dataConnect.pairingCode || null);
        qrcodeBase64 = pairingCode ? null : (dataConnect.base64 || dataConnect.qrcode?.base64 || qrcodeBase64);
        if (dataConnect.instance?.state === 'open') status = 'open';
      }
    } catch (err) {
      diagnostico = { etapa: 'instance/connect', codigo: 'CONEXAO_FALHOU' };
    }
  }

  // 3. Normaliza prefixo base64 se presente
  if (qrcodeBase64 && !qrcodeBase64.startsWith('data:image')) {
    qrcodeBase64 = `data:image/png;base64,${qrcodeBase64}`;
  }

  // 4. Se não veio QR code, verifica se já está conectado na Evolution
  if (!qrcodeBase64 && !pairingCode && status !== 'open') {
    try {
      const resState = await fetch(`${baseUrl}/instance/connectionState/${nomeInstancia}`, {
        headers: { apikey: evolutionApiKey },
        signal: AbortSignal.timeout(15_000)
      });
      const dataState = await resState.json().catch(() => ({}));
      if (resState.ok && dataState.instance?.state === 'open') {
        status = 'open';
      }
    } catch {
      // Ignora erro de rede momentâneo
    }
  }

  // 5. Configura o webhook na Evolution para receber os comandos /agendado e /emissao
  let webhookConfigurado = false;
  try {
    const resWebhook = await fetch(`${baseUrl}/webhook/set/${nomeInstancia}`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'Content-Type': 'application/json',
        apikey: evolutionApiKey
      },
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: `${appWebhookUrl.replace(/\/+$/, '')}/webhook/evolution`,
          headers: {
            'apikey': evolutionApiKey,
            'x-webhook-secret': webhookSecret || evolutionApiKey
          },
          webhookByEvents: false,
          events: [
            'MESSAGES_SET',
            'MESSAGES_UPSERT',
            'CHATS_SET',
            'CONTACTS_SET',
            'CONNECTION_UPDATE'
          ]
        }
      })
    });
    webhookConfigurado = resWebhook.ok || resWebhook.status === 201;
  } catch (err) {
    // Falha silenciosa no setWebhook
  }

  // 6. Salva ou atualiza a instância em whatsapp_instancias (coluna status com enum status_conexao_whatsapp)
  const statusDb = status === 'open' ? 'conectado' : 'pendente';
  const conectadoEm = status === 'open' ? new Date() : null;
  const sql = `
    insert into whatsapp_instancias (
      medico_id, conta_id, nome_instancia, oficial, status, conectado_em, webhook_configurado
    ) values (
      $1, (select conta_id from medicos where id = $1), $2, false, $3::status_conexao_whatsapp, $4, $5
    )
    on conflict (nome_instancia) do update set
      status = excluded.status,
      medico_id = coalesce(whatsapp_instancias.medico_id, excluded.medico_id),
      conta_id = coalesce(excluded.conta_id, whatsapp_instancias.conta_id),
      conectado_em = coalesce(excluded.conectado_em, whatsapp_instancias.conectado_em),
      webhook_configurado = excluded.webhook_configurado
    returning id
  `;
  await pool.query(sql, [medicoId, nomeInstancia, statusDb, conectadoEm, webhookConfigurado]);


  if (!qrcodeBase64 && !pairingCode && status !== 'open') {
    return falhar(diagnostico || { etapa: 'instance/connect', codigo: 'CODIGO_NAO_GERADO' });
  }

  if (status === 'open') input.aoConectar?.(medicoId);

  return {
    ok: true,
    nomeInstancia,
    status,
    qrcodeBase64,
    pairingCode
  };
}
