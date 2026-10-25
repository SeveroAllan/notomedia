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
  aoConectar?: (medicoId: string) => void;
};

export type ResultadoStatusWhatsapp = {
  ok: boolean;
  conectado: boolean;
  status: 'conectado' | 'pendente' | 'desconectado' | 'erro';
  state?: string;
  detalhe?: string;
};

export async function consultarStatusInstanciaWhatsapp(
  pool: pg.Pool,
  input: ConsultarStatusWhatsappInput
): Promise<ResultadoStatusWhatsapp> {
  const { medicoId, evolutionUrl, evolutionApiKey } = input;
  const baseUrl = evolutionUrl.replace(/\/+$/, '');
  let nomeInstancia = `medico_${medicoId.replace(/-/g, '').slice(0, 12)}`;

  try {
    const existente=await pool.query(`
      select w.nome_instancia
      from medicos m
      join whatsapp_instancias w on w.conta_id=m.conta_id and w.oficial=false
      where m.id=$1
      order by w.conectado_em desc nulls last,w.id
      limit 1
    `,[medicoId]);
    if(existente.rows[0]?.nome_instancia)nomeInstancia=existente.rows[0].nome_instancia;
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
      input.aoConectar?.(medicoId);
      return { ok: true, conectado: true, status: 'conectado', state: 'open' };
    }

    return { ok: true, conectado: false, status: 'pendente', state };
  } catch (err: any) {
    return { ok: false, conectado: false, status: 'erro', detalhe: err?.message || 'Erro ao consultar status' };
  }
}
