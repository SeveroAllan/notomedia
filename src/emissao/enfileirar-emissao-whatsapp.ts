/**
 * Caso de uso I/O transacional que transforma um `CasoEmissaoRegistro` validado
 * em uma solicitação real na fila (`solicitacoes_nota`), com trava de ambiente
 * fiscal, idempotência por referência externa e criptografia de CPF do paciente.
 */

import type pg from 'pg';
import { gerarHashCpf } from '../paciente/hash-cpf.js';
import { validarCpf } from '../paciente/validar-cpf.js';
import { montarDescricaoServico } from './montar-descricao-servico.js';
import { formatarDataBr } from '../agenda/filtrar-atendimentos-agenda.js';
import type { CasoEmissaoRegistro } from './caso-emissao-repositorio.js';

export type ResultadoEnfileirarEmissaoWhatsapp =
  | { ok: true; solicitacaoId: string; jaExistia: boolean; ambiente: 'homologacao' | 'producao' }
  | {
      ok: false;
      motivo:
        | 'CERTIFICADO_A1_PENDENTE'
        | 'DADOS_FISCAIS_PENDENTES'
        | 'PRODUCAO_NAO_LIBERADA'
        | 'DADOS_TOMADOR_INCOMPLETOS'
        | 'MEDICO_NAO_ENCONTRADO';
    };

export interface EnfileirarEmissaoWhatsappDeps {
  pool: pg.Pool;
  chaveCriptografia: string;
  pepper: string;
  permitirProducao?: boolean;
}

export async function enfileirarEmissaoWhatsapp(
  caso: CasoEmissaoRegistro,
  deps: EnfileirarEmissaoWhatsappDeps
): Promise<ResultadoEnfileirarEmissaoWhatsapp> {
  const cpfLimpo = caso.pacienteCpf?.replace(/\D/g, '') ?? '';
  if (!caso.pacienteNome?.trim() || !validarCpf(cpfLimpo) || !caso.valorCentavos || caso.valorCentavos <= 0 || !caso.dataConsulta) {
    return { ok: false, motivo: 'DADOS_TOMADOR_INCOMPLETOS' };
  }

  const client = await deps.pool.connect();
  try {
    await client.query('begin');

    // 1. Resolve o médico titular e confere prontidão fiscal + certificado ativo.
    const medRes = await client.query(
      `select m.id, m.nome_completo, m.especialidade, m.crm, m.rqe,
              pf.ambiente, pf.confirmado_pelo_medico, pf.serie_dps, pf.cclass_trib_padrao, pf.cind_op_padrao,
              sf.id as servico_id, sf.ctrib_nac, sf.cnbs, sf.parametros_emissao,
              exists(
                select 1 from public.medico_certificados c
                where c.medico_id = m.id and c.status = 'ativo'
                  and (c.valido_ate is null or c.valido_ate >= current_date)
              ) as cert_valido
       from public.medicos m
       left join public.medico_perfil_fiscal pf on pf.medico_id = m.id
       left join lateral (
         select id, ctrib_nac, cnbs, parametros_emissao from public.medico_servicos_fiscais
         where medico_id = m.id and ativo = true and padrao = true
         order by padrao desc, id asc limit 1
       ) sf on true
       where m.conta_id = $1 and ($2::uuid is null or m.id = $2::uuid)
       order by m.criado_em asc limit 1`,
      [caso.contaId, caso.medicoId]
    );
    const med = medRes.rows[0];
    if (!med) {
      await client.query('rollback');
      return { ok: false, motivo: 'MEDICO_NAO_ENCONTRADO' };
    }
    if (!med.cert_valido) {
      await client.query('rollback');
      return { ok: false, motivo: 'CERTIFICADO_A1_PENDENTE' };
    }
    const serieValida = /^\d{1,5}$/.test(String(med.serie_dps ?? '')) && Number(med.serie_dps) <= 49999;
    if (!med.confirmado_pelo_medico || !med.ctrib_nac || !med.parametros_emissao || !serieValida) {
      await client.query('rollback');
      return { ok: false, motivo: 'DADOS_FISCAIS_PENDENTES' };
    }
    const ambiente: 'homologacao' | 'producao' = med.ambiente === 'producao' ? 'producao' : 'homologacao';
    if (ambiente === 'producao' && !deps.permitirProducao) {
      await client.query('rollback');
      return { ok: false, motivo: 'PRODUCAO_NAO_LIBERADA' };
    }

    // 2. Idempotência pela referência externa do caso.
    const ref = `caso:${caso.chaveIdempotencia}`;
    const existente = await client.query(
      'select id from public.solicitacoes_nota where medico_id = $1 and referencia_externa = $2 limit 1',
      [med.id, ref]
    );
    if (existente.rows[0]?.id) {
      const solicitacaoId = String(existente.rows[0].id);
      await client.query(
        `update public.solicitacoes_nota
            set status = 'pronta',
                fila = 'pronta',
                erro = null,
                tentativas = 0,
                proxima_tentativa_em = null,
                bloqueada_por_worker = null,
                bloqueada_em = null,
                atualizado_em = now()
          where id = $1 and status <> 'emitida'`,
        [solicitacaoId]
      );
      await client.query(
        `update public.noto_casos_emissao
            set estado = 'enfileirada',
                medico_id = $2,
                solicitacao_id = $3,
                aprovado_pelo_medico = true,
                erro_motivo = null,
                atualizado_em = now()
          where id = $1`,
        [caso.id, med.id, solicitacaoId]
      );
      await client.query('commit');
      return { ok: true, solicitacaoId, jaExistia: true, ambiente };
    }

    // 3. Upsert seguro do paciente com CPF criptografado.
    const cpfHash = gerarHashCpf(cpfLimpo, deps.pepper);
    const pacExist = await client.query(
      'select id from public.pacientes where medico_id = $1 and cpf_cnpj_hash = $2 limit 1',
      [med.id, cpfHash]
    );
    let pacienteId: string;
    if (pacExist.rows[0]?.id) {
      pacienteId = String(pacExist.rows[0].id);
      await client.query(
        `update public.pacientes
         set nome = coalesce(nullif($2, ''), nome),
             telefone = coalesce(nullif($3, ''), telefone),
             nome_validado = true,
             atualizado_em = now()
         where id = $1`,
        [pacienteId, caso.pacienteNome.trim(), caso.pacienteTelefone ?? null]
      );
    } else {
      const telFallback = caso.pacienteTelefone?.replace(/\D/g, '') || `wpp-${cpfLimpo}`;
      const pacIns = await client.query(
        `insert into public.pacientes (
           medico_id, telefone, nome, cpf_cnpj_hash, cpf_cnpj_encriptado, origem_cadastro, nome_validado
         ) values ($1, $2, $3, $4, pgp_sym_encrypt($5, $6), 'whatsapp', true)
         on conflict (medico_id, telefone) do update set
           nome = excluded.nome,
           cpf_cnpj_hash = excluded.cpf_cnpj_hash,
           cpf_cnpj_encriptado = excluded.cpf_cnpj_encriptado,
           nome_validado = true,
           atualizado_em = now()
         returning id`,
        [med.id, telFallback, caso.pacienteNome.trim(), cpfHash, cpfLimpo, deps.chaveCriptografia]
      );
      pacienteId = String(pacIns.rows[0].id);
    }

    // 4. Monta descrição oficial e enfileira em solicitacoes_nota.
    const dataBr = formatarDataBr(caso.dataConsulta);
    const xdescServ = montarDescricaoServico(
      { nomeCompleto: med.nome_completo, especialidade: med.especialidade, crm: med.crm, rqe: med.rqe },
      dataBr
    );
    const solRes = await client.query(
      `insert into public.solicitacoes_nota (
         medico_id, paciente_id, servico_fiscal_id, referencia_externa,
         valor_servico_centavos, xdesc_serv, ctrib_nac, cnbs, cclass_trib, cind_op,
         datas_consulta_texto, competencia_emissao, origem, status, fila, tentativas
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date, 'whatsapp', 'pronta', 'pronta', 0
       )
       returning id`,
      [
        med.id, pacienteId, med.servico_id ?? null, ref,
        caso.valorCentavos, xdescServ, med.ctrib_nac, med.cnbs ?? null,
        med.cclass_trib_padrao ?? null, med.cind_op_padrao ?? null,
        dataBr, caso.dataConsulta
      ]
    );
    const solicitacaoId = String(solRes.rows[0].id);

    await client.query(
      `update public.noto_casos_emissao
       set estado = 'enfileirada', medico_id = $2, solicitacao_id = $3,
           ambiente = $4, aprovado_pelo_medico = true, erro_motivo = null, atualizado_em = now()
       where id = $1`,
      [caso.id, med.id, solicitacaoId, ambiente]
    );

    await client.query('commit');
    return { ok: true, solicitacaoId, jaExistia: false, ambiente };
  } catch (erro) {
    await client.query('rollback').catch(() => undefined);
    throw erro;
  } finally {
    client.release();
  }
}
