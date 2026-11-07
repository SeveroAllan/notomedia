/**
 * Consulta em tempo real o status de conexão da instância do médico na Evolution API.
 * Quando o médico lê o QR Code no celular, a Evolution transiciona o estado para 'open'.
 * Este módulo sincroniza o banco local (whatsapp_instancias) e avisa a UI para concluir o onboarding.
 */

import type pg from 'pg';

export type ConsultarStatusWhatsappInput = {
  medicoId: string;
  evolutionUrl: string;
  evolutionApiKey: string;
  consultarCodigo?: boolean;
  aoConectar?: (medicoId: string) => Promise<void> | void;
};

export type ResultadoStatusWhatsapp = {
  ok: boolean;
  conectado: boolean;
  status: 'conectado' | 'pendente' | 'desconectado' | 'erro';
  state?: string;
  pairingCode?: string;
  detalhe?: string;
};

export async function consultarStatusInstanciaWhatsapp(
  pool: pg.Pool,
  input: ConsultarStatusWhatsappInput
): Promise<ResultadoStatusWhatsapp> {
  const { medicoId, evolutionUrl, evolutionApiKey } = input;
  const baseUrl = evolutionUrl.replace(/\/+$/, '');
  const nomeInstancia = `medico_${medicoId.replace(/-/g, '').slice(0, 12)}`;

  try {
    const res = await fetch(`${baseUrl}/instance/connectionState/${nomeInstancia}`, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
      headers: { apikey: evolutionApiKey }
    });

    if (!res.ok) {
      return { ok: false, conectado: false, status: 'pendente', detalhe: `Status HTTP ${res.status}` };
    }

    const data = await res.json().catch(() => ({}));
    const state = data?.instance?.state;
    if (!['open', 'close', 'connecting'].includes(state)) {
      return { ok: false, conectado: false, status: 'erro', detalhe: 'Estado da conexão não reconhecido.' };
    }

    if (state === 'open') {
      await pool.query(
        `update whatsapp_instancias 
         set status = 'conectado', conectado_em = coalesce(conectado_em, now()) 
         where nome_instancia = $1`,
        [nomeInstancia]
      );
      await input.aoConectar?.(medicoId);
      return { ok: true, conectado: true, status: 'conectado', state: 'open' };
    }

    if (input.consultarCodigo) {
      if (state !== 'connecting') {
        return { ok: false, conectado: false, status: 'pendente', state,
          detalhe: 'A conexão foi encerrada. Gere uma conexão para tentar novamente.' };
      }
      const consulta = await fetch(`${baseUrl}/instance/connect/${nomeInstancia}`, {
        headers: { apikey: evolutionApiKey }, signal: AbortSignal.timeout(5_000), redirect: 'error'
      });
      const corpo = consulta.ok ? await consulta.json().catch(() => ({})) : {};
      if (typeof corpo.pairingCode !== 'string' || !/^[A-Z0-9-]{8,12}$/i.test(corpo.pairingCode)) {
        return { ok: false, conectado: false, status: 'pendente', state,
          detalhe: 'O código atual ainda não está disponível. Tente consultar novamente.' };
      }
      return { ok: true, conectado: false, status: 'pendente', state, pairingCode: corpo.pairingCode };
    }
    return { ok: true, conectado: false, status: 'pendente', state };
  } catch (err: any) {
    return { ok: false, conectado: false, status: 'erro', detalhe: err?.message || 'Erro ao consultar status' };
  }
}
