/**
 * Persistência Postgres das preferências de emissão da conta capturadas pela IA
 * na conversa do WhatsApp. Separado de `preferencias-emissao.ts` para manter as
 * regras de mesclagem e pendência puras e testáveis sem banco.
 */

import type pg from 'pg';
import {
  mesclarPreferenciasEmissao,
  PREFERENCIAS_EMISSAO_VAZIAS,
  preferenciasEmissaoCompletas,
  reconciliarPreferenciasComFalaDoMedico,
  type AtualizacaoPreferenciasEmissao,
  type PreferenciasEmissaoConta
} from './preferencias-emissao.js';

interface LinhaPreferenciasDb {
  emitir_apenas_com_comprovante: boolean | null;
  revisao_diaria_agenda: boolean | null;
  enviar_nota_para_paciente: boolean | null;
  pedir_aprovacao_antes_emitir: boolean | null;
  solicitar_cpf_direto_paciente: boolean | null;
}

function mapearLinha(row: LinhaPreferenciasDb | undefined): PreferenciasEmissaoConta {
  if (!row) return { ...PREFERENCIAS_EMISSAO_VAZIAS };
  return {
    emitirApenasComComprovante: row.emitir_apenas_com_comprovante ?? null,
    revisaoDiariaAgenda: row.revisao_diaria_agenda ?? null,
    enviarNotaParaPaciente: row.enviar_nota_para_paciente ?? null,
    pedirAprovacaoAntesDeEmitir: row.pedir_aprovacao_antes_emitir ?? null,
    solicitarCpfDiretoPaciente: row.solicitar_cpf_direto_paciente ?? null
  };
}

export async function consultarPreferenciasEmissaoConta(
  pool: Pick<pg.Pool, 'query'>,
  contaId: string
): Promise<PreferenciasEmissaoConta> {
  if (!contaId) return { ...PREFERENCIAS_EMISSAO_VAZIAS };
  try {
    const { rows } = await pool.query(
      `select emitir_apenas_com_comprovante,
              revisao_diaria_agenda,
              enviar_nota_para_paciente,
              pedir_aprovacao_antes_emitir,
              solicitar_cpf_direto_paciente
         from public.conta_preferencias_emissao
        where conta_id = $1
        limit 1`,
      [contaId]
    );
    return mapearLinha(rows[0] as LinhaPreferenciasDb | undefined);
  } catch {
    return { ...PREFERENCIAS_EMISSAO_VAZIAS };
  }
}

export async function salvarPreferenciasEmissaoConta(
  pool: Pick<pg.Pool, 'query'>,
  contaId: string,
  atualizacao: AtualizacaoPreferenciasEmissao,
  falaMedico?: string
): Promise<PreferenciasEmissaoConta> {
  if (!contaId) throw new Error('Conta não informada para salvar preferências de emissão.');

  const atual = await consultarPreferenciasEmissaoConta(pool, contaId);
  const reconciliada = reconciliarPreferenciasComFalaDoMedico(falaMedico, atual, atualizacao);
  const proximo = mesclarPreferenciasEmissao(atual, reconciliada);
  const completas = preferenciasEmissaoCompletas(proximo);

  const { rows } = await pool.query(
    `insert into public.conta_preferencias_emissao (
       conta_id,
       emitir_apenas_com_comprovante,
       revisao_diaria_agenda,
       enviar_nota_para_paciente,
       pedir_aprovacao_antes_emitir,
       solicitar_cpf_direto_paciente,
       configuracao_concluida_em,
       atualizado_em
     ) values ($1, $2, $3, $4, $5, $6, case when $7 then now() else null end, now())
     on conflict (conta_id) do update set
       emitir_apenas_com_comprovante = excluded.emitir_apenas_com_comprovante,
       revisao_diaria_agenda = excluded.revisao_diaria_agenda,
       enviar_nota_para_paciente = excluded.enviar_nota_para_paciente,
       pedir_aprovacao_antes_emitir = excluded.pedir_aprovacao_antes_emitir,
       solicitar_cpf_direto_paciente = excluded.solicitar_cpf_direto_paciente,
       configuracao_concluida_em = coalesce(
         public.conta_preferencias_emissao.configuracao_concluida_em,
         excluded.configuracao_concluida_em
       ),
       atualizado_em = now()
     returning emitir_apenas_com_comprovante,
               revisao_diaria_agenda,
               enviar_nota_para_paciente,
               pedir_aprovacao_antes_emitir,
               solicitar_cpf_direto_paciente`,
    [
      contaId,
      proximo.emitirApenasComComprovante,
      proximo.revisaoDiariaAgenda,
      proximo.enviarNotaParaPaciente,
      proximo.pedirAprovacaoAntesDeEmitir,
      proximo.solicitarCpfDiretoPaciente,
      completas
    ]
  );

  // Mantém a coluna legada dos médicos sincronizada quando a preferência de CPF é definida.
  if (typeof proximo.solicitarCpfDiretoPaciente === 'boolean') {
    await pool.query(
      `update public.medicos
          set solicitar_cpf_direto_paciente = $1,
              atualizado_em = now()
        where conta_id = $2`,
      [proximo.solicitarCpfDiretoPaciente, contaId]
    ).catch(() => undefined);
  }

  return mapearLinha(rows[0] as LinhaPreferenciasDb | undefined);
}
