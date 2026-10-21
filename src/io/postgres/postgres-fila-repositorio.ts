/**
 * Implementação PostgreSQL da porta `FilaRepositorio` com lock otimista.
 * Consome solicitações de NFS-e prontas para emissão, garante exclusão mútua
 * entre workers e grava resultados na tabela `notas_fiscais` (seção 1 e 3.2 do plano).
 */

import type pg from 'pg';
import type {
  FilaRepositorio,
  ItemFilaComTentativas,
  RegistrarSucessoEmissaoParams,
  ContextoEnvioNota
} from '../../worker/fila-repositorio.js';

export class PostgresFilaRepositorio implements FilaRepositorio {
  constructor(private readonly pool: pg.Pool, private readonly modoAgente = false, private readonly emissaoComprovanteAtiva = false) {}

  async buscarETravarProximoItem(workerId: string): Promise<ItemFilaComTentativas | null> {
    const sql = `
      with proximo as (
        select id
        from solicitacoes_nota
        where fila = 'pronta'
          and ${this.emissaoComprovanteAtiva ? `(origem = 'api' or (origem = 'whatsapp' and exists (select 1 from public.noto_emissoes_comprovantes ec where ec.solicitacao_id = solicitacoes_nota.id and ec.medico_id = solicitacoes_nota.medico_id and ec.estado = 'enfileirada')))` : `origem = 'api'`}
          and not aguardando_dados_profissionais
          and not aguardando_confirmacao_medico
          and not aguardando_cpf_medico
          and status not in ('simulada', 'emitida')
          and (proxima_tentativa_em is null or proxima_tentativa_em <= now())
          and (bloqueada_em is null or (${this.emissaoComprovanteAtiva ? `origem = 'api' and ` : ''}not $2 and bloqueada_em < now() - interval '5 minutes'))
        order by criado_em asc
        limit 1
        for update skip locked
      )
      update solicitacoes_nota sn
      set bloqueada_por_worker = $1,
          bloqueada_em = now()
      from proximo
      where sn.id = proximo.id
      returning sn.id, sn.medico_id, sn.paciente_id, sn.xdesc_serv, sn.valor_servico_centavos,
                sn.ctrib_nac, sn.cnbs, sn.cclass_trib, sn.cind_op, sn.tentativas${this.emissaoComprovanteAtiva ? `, (sn.origem = 'whatsapp') as emissao_comprovante` : ''}
    `;
    const { rows } = await this.pool.query(sql, [workerId, this.modoAgente]);
    if (rows.length === 0) return null;

    const r = rows[0];
    return {
      id: r.id,
      medicoId: r.medico_id,
      pacienteId: r.paciente_id,
      xdescServ: r.xdesc_serv,
      valorServicoCentavos: r.valor_servico_centavos,
      ctribNac: r.ctrib_nac,
      cnbs: r.cnbs,
      cclassTrib: r.cclass_trib,
      cindOp: r.cind_op,
      tentativas: r.tentativas,
      ...(r.emissao_comprovante === true ? { emissaoComprovante: true as const } : {})
    };
  }

  async iniciarEmissaoComprovante(solicitacaoId: string): Promise<'iniciada' | 'ocupada' | 'bloqueada'> {
    if (!this.emissaoComprovanteAtiva) return 'bloqueada';
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(`select ec.estado, pf.ambiente, sn.aguardando_confirmacao_medico
        from public.noto_emissoes_comprovantes ec
        join solicitacoes_nota sn on sn.id = ec.solicitacao_id and sn.medico_id = ec.medico_id
        left join medico_perfil_fiscal pf on pf.medico_id = ec.medico_id
        where ec.solicitacao_id = $1 and sn.origem = 'whatsapp'
        for update of ec, sn`, [solicitacaoId]);
      if (rows[0]?.estado !== 'enfileirada' || rows[0]?.aguardando_confirmacao_medico === true) {
        await client.query('commit');
        return 'ocupada';
      }
      if (rows[0].ambiente !== 'homologacao') {
        await client.query(`update public.noto_emissoes_comprovantes set estado = 'bloqueada',
          erro_codigo = 'AMBIENTE_FISCAL_BLOQUEADO', atualizado_em = now() where solicitacao_id = $1`, [solicitacaoId]);
        await client.query(`update solicitacoes_nota set status = 'erro', fila = null,
          erro = 'AMBIENTE_FISCAL_BLOQUEADO', bloqueada_em = null, bloqueada_por_worker = null where id = $1`, [solicitacaoId]);
        await client.query('commit');
        return 'bloqueada';
      }
      const inicio = await client.query(`update public.noto_emissoes_comprovantes set estado = 'emitindo', atualizado_em = now()
        where solicitacao_id = $1 and estado = 'enfileirada'`, [solicitacaoId]);
      if (inicio.rowCount !== 1) throw new Error('Reserva de emissão indisponível.');
      await client.query('commit');
      return 'iniciada';
    } catch (erro) {
      await client.query('rollback');
      throw erro;
    } finally { client.release(); }
  }

  async registrarFalhaComprovante(params: { solicitacaoId: string; erroCodigo: string }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const resultado = await client.query(`update public.noto_emissoes_comprovantes
        set estado = 'erro', erro_codigo = $2, atualizado_em = now()
        where solicitacao_id = $1 and estado = 'emitindo'`, [params.solicitacaoId, params.erroCodigo]);
      if (resultado.rowCount !== 1) throw new Error('Reserva de emissão indisponível.');
      await client.query(`update solicitacoes_nota set status = 'erro', fila = null, erro = $2,
        bloqueada_em = null, bloqueada_por_worker = null where id = $1`, [params.solicitacaoId, params.erroCodigo]);
      await client.query('commit');
    } catch (erro) {
      await client.query('rollback');
      throw erro;
    } finally { client.release(); }
  }

  async suspenderPorDadosProfissionais(solicitacaoId: string): Promise<void> {
    await this.pool.query(`update solicitacoes_nota set aguardando_dados_profissionais = true,
      datas_consulta_texto = coalesce(datas_consulta_texto, substring(xdesc_serv from ' NAS DATAS (.*)$')),
      fila = null, bloqueada_por_worker = null, bloqueada_em = null, atualizado_em = now()
      where id = $1 and status not in ('simulada', 'emitida')`, [solicitacaoId]);
  }

  async buscarContextoEnvio(solicitacaoId: string): Promise<ContextoEnvioNota | null> {
    const sql = `
      select coalesce(wi.nome_instancia, (
               select w2.nome_instancia 
               from whatsapp_instancias w2 
               where w2.medico_id = m.id and w2.status = 'conectado' 
               order by w2.criado_em desc limit 1
             ), 'notomed_oficial') as nome_instancia,
             p.telefone as contato_telefone,
             u.telefone as telefone_medico, p.nome as nome_paciente
      from solicitacoes_nota sn
      join pacientes p on p.id = sn.paciente_id
      join medicos m on m.id = sn.medico_id
      join usuarios u on u.id = m.usuario_id
      left join whatsapp_conversas wc on wc.medico_id = m.id and wc.paciente_id = p.id
      left join whatsapp_instancias wi on wi.id = wc.instancia_id
      where sn.id = $1
      limit 1
    `;
    const { rows } = await this.pool.query(sql, [solicitacaoId]);
    if (rows.length === 0) return null;

    return {
      instanciaNome: rows[0].nome_instancia,
      contatoTelefone: rows[0].contato_telefone,
      telefoneMedico: rows[0].telefone_medico,
      nomePaciente: rows[0].nome_paciente
    };
  }

  async registrarSucesso(params: RegistrarSucessoEmissaoParams): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const sqlNota = `
        insert into notas_fiscais (
          medico_id, solicitacao_id, chave_acesso, ndps, serie, competencia,
          data_emissao, status, valor_servicos_centavos, xml_storage_path, pdf_storage_path, resposta_sefin_raw
        ) values ($1, $2, $3, $4, $5, $6, $7, 'autorizada', $8, $9, $10, $11)
        ${params.emissaoComprovante ? 'returning id' : ''}
      `;
      const nota = await client.query(sqlNota, [
        params.medicoId,
        params.solicitacaoId,
        params.chaveAcesso,
        params.ndps,
        params.serie,
        params.competencia,
        params.dataEmissao,
        params.valorServicosCentavos,
        params.xmlStoragePath,
        params.pdfStoragePath,
        params.respostaSefinRaw ? JSON.stringify(params.respostaSefinRaw) : null
      ]);

      if (params.emissaoComprovante) {
        const vinculo = await client.query(`update public.noto_emissoes_comprovantes
          set estado = 'nota_gerada', nota_fiscal_id = $2, erro_codigo = null, atualizado_em = now()
          where solicitacao_id = $1 and medico_id = $3 and estado = 'emitindo' and nota_fiscal_id is null`,
          [params.solicitacaoId, nota.rows[0]?.id, params.medicoId]);
        if (!nota.rows[0]?.id || vinculo.rowCount !== 1) throw new Error('Vínculo de emissão indisponível.');
      }
      const sqlAtualizaSolicitacao = `
        update solicitacoes_nota
        set status = 'emitida',
            fila = null,
            bloqueada_por_worker = null,
            bloqueada_em = null
        where id = $1
      `;
      await client.query(sqlAtualizaSolicitacao, [params.solicitacaoId]);
      await client.query(
        `update medico_perfil_fiscal
         set proximo_numero_dps = greatest(coalesce(proximo_numero_dps, 1), $2 + 1),
             atualizado_em = now()
         where medico_id = $1`,
        [params.medicoId, params.ndps]
      );
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  async reagendarTentativa(params: {
    solicitacaoId: string;
    tentativas: number;
    proximaTentativaEm: Date;
    erro: string;
  }): Promise<void> {
    const sql = `
      update solicitacoes_nota
      set tentativas = $2,
          proxima_tentativa_em = $3,
          erro = $4,
          bloqueada_por_worker = null,
          bloqueada_em = null
      where id = $1
    `;
    await this.pool.query(sql, [params.solicitacaoId, params.tentativas, params.proximaTentativaEm, params.erro]);
  }

  async marcarFalhaDefinitiva(params: {
    solicitacaoId: string;
    tentativas: number;
    erro: string;
  }): Promise<void> {
    const sql = `
      update solicitacoes_nota
      set status = 'erro',
          fila = null,
          tentativas = $2,
          erro = $3,
          bloqueada_por_worker = null,
          bloqueada_em = null
      where id = $1
    `;
    await this.pool.query(sql, [params.solicitacaoId, params.tentativas, params.erro]);
  }
}
