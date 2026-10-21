/**
 * Implementação PostgreSQL da porta `EmissaoApiRepositorio`.
 * Isola o acesso a banco para a API pública de NFS-e, gerenciando idempotência,
 * criptografia simétrica de CPF via pgcrypto e enfileiramento transacional na tabela `solicitacoes_nota`.
 */

import type pg from 'pg';
import { gerarHashCpf } from '../../paciente/hash-cpf.js';
import type {
  EmissaoApiRepositorio,
  SolicitacaoRefRegistro,
  PerfilFiscalMedicoRegistro,
  CriarSolicitacaoEmissaoParams
} from '../../api/nfse/emissao-api-repositorio.js';

export class PostgresEmissaoApiRepositorio implements EmissaoApiRepositorio {
  constructor(
    private readonly pool: pg.Pool,
    private readonly chaveCriptografia: string,
    private readonly pepper: string
  ) {}

  async buscarPorReferencia(medicoId: string, ref: string): Promise<SolicitacaoRefRegistro | null> {
    const sql = `
      select
        s.id, s.medico_id, s.referencia_externa, s.status, s.fila, s.erro, s.criado_em,
        n.chave_acesso, n.ndps, n.serie, n.data_emissao, n.xml_storage_path, n.pdf_storage_path
      from solicitacoes_nota s
      left join notas_fiscais n on n.solicitacao_id = s.id
      where s.medico_id = $1 and s.referencia_externa = $2
      limit 1
    `;
    const { rows } = await this.pool.query(sql, [medicoId, ref]);
    if (rows.length === 0) return null;
    const r = rows[0];

    return {
      id: r.id,
      medicoId: r.medico_id,
      referenciaExterna: r.referencia_externa,
      status: r.status,
      fila: r.fila,
      erro: r.erro,
      criadoEm: new Date(r.criado_em),
      notaFiscal: r.chave_acesso ? {
        chaveAcesso: r.chave_acesso,
        ndps: Number(r.ndps),
        serie: r.serie,
        dataEmissao: new Date(r.data_emissao),
        xmlStoragePath: r.xml_storage_path,
        pdfStoragePath: r.pdf_storage_path
      } : null
    };
  }

  async buscarPerfilFiscalMedico(medicoId: string, client?: pg.PoolClient): Promise<PerfilFiscalMedicoRegistro | null> {
    const sql = `
      select
        m.id as medico_id, m.nome_completo, m.especialidade, m.crm, m.rqe,
        p.confirmado_pelo_medico, p.cclass_trib_padrao, p.cind_op_padrao,
        s.ctrib_nac, s.cnbs
      from medicos m
      left join medico_perfil_fiscal p on p.medico_id = m.id
      left join lateral (
        select ctrib_nac, cnbs from medico_servicos_fiscais
        where medico_id = m.id and ativo = true and padrao = true
        order by id limit 1
      ) s on true
      where m.id = $1
      limit 1
    `;
    const { rows } = await (client ?? this.pool).query(sql, [medicoId]);
    if (rows.length === 0) return null;
    const r = rows[0];
    const completo = Boolean(r.confirmado_pelo_medico) && Boolean(r.ctrib_nac);

    return {
      medicoId: r.medico_id,
      nomeCompleto: r.nome_completo,
      especialidade: r.especialidade,
      crm: r.crm,
      rqe: r.rqe,
      ctribNacPadrao: r.ctrib_nac ?? '',
      cnbs: r.cnbs,
      cclassTrib: r.cclass_trib_padrao,
      cindOp: r.cind_op_padrao,
      configuracaoCompleta: completo
    };
  }

  async buscarOuCriarPaciente(
    medicoId: string,
    paciente: { cpfLimpo: string; nome: string; email?: string | null; telefone?: string | null }
  ): Promise<{ id: string }> {
    const cpfHash = gerarHashCpf(paciente.cpfLimpo, this.pepper);
    const existente = await this.buscarPacientePorHash(medicoId, cpfHash);
    if (existente) {
      await this.atualizarPacienteBasico(existente.id, paciente.nome, paciente.email);
      return { id: existente.id };
    }
    return this.inserirNovoPaciente(medicoId, cpfHash, paciente);
  }

  async enfileirarSolicitacao(params: CriarSolicitacaoEmissaoParams, clientExterno?: pg.PoolClient): Promise<{ id: string }> {
    const client = clientExterno ?? await this.pool.connect();
    try {
      if (!clientExterno) await client.query('begin');
      const contatoLote = params.origem === 'lote';
      if (contatoLote && params.contatoPaciente && !/^\d{10,13}$/.test(params.contatoPaciente)) throw Error('CONTATO_PACIENTE_INVALIDO');
      const sql = `
        insert into solicitacoes_nota (
          referencia_externa, medico_id, paciente_id, valor_servico_centavos,
          xdesc_serv, ctrib_nac, cnbs, cclass_trib, cind_op,
          datas_consulta_texto, origem, status, fila, tentativas${contatoLote ? ', contato_paciente_encriptado' : ''}
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pronta', 'pronta', 0${contatoLote ? ', case when $12::text is null then null else pgp_sym_encrypt($12,$13) end' : ''})
        returning id
      `;
      const values = [
        params.ref, params.medicoId, params.pacienteId, params.valorServicoCentavos,
        params.xdescServ, params.ctribNac, params.cnbs ?? null, params.cclassTrib ?? null,
        params.cindOp ?? null, params.datasConsultaTexto ?? null, params.origem ?? 'api'
      ];
      if (contatoLote) values.push(params.contatoPaciente ?? null, this.chaveCriptografia);
      const { rows } = await client.query(sql, values);
      const solicitacaoId = rows[0].id;
      await client.query(`
        update solicitacoes_nota s set servico_fiscal_id = f.id
        from medico_servicos_fiscais f
        where s.id = $1 and f.medico_id = $2 and f.padrao = true and f.ativo = true
      `, [solicitacaoId, params.medicoId]);
      if (!clientExterno) await client.query('commit');
      return { id: solicitacaoId };
    } catch (erro) {
      if (!clientExterno) await client.query('rollback');
      throw erro;
    } finally {
      if (!clientExterno) client.release();
    }
  }

  private async buscarPacientePorHash(medicoId: string, cpfHash: string): Promise<{ id: string } | null> {
    const sql = `select id from pacientes where medico_id = $1 and cpf_cnpj_hash = $2 limit 1`;
    const { rows } = await this.pool.query(sql, [medicoId, cpfHash]);
    return rows.length > 0 ? { id: rows[0].id } : null;
  }

  private async atualizarPacienteBasico(pacienteId: string, nome: string, email?: string | null): Promise<void> {
    const sql = `
      update pacientes
      set nome = coalesce(nullif($2, ''), nome),
          email = coalesce($3, email),
          atualizado_em = now()
      where id = $1
    `;
    await this.pool.query(sql, [pacienteId, nome, email ?? null]);
  }

  private async inserirNovoPaciente(
    medicoId: string,
    cpfHash: string,
    p: { cpfLimpo: string; nome: string; email?: string | null; telefone?: string | null }
  ): Promise<{ id: string }> {
    const telefone = p.telefone?.trim() || `api-${p.cpfLimpo}`;
    const sql = `
      insert into pacientes (
        medico_id, telefone, nome, email, cpf_cnpj_hash, cpf_cnpj_encriptado,
        origem_cadastro, nome_validado
      )
      values ($1, $2, $3, $4, $5, pgp_sym_encrypt($6, $7), 'api', true)
      on conflict (medico_id, telefone) do update set
        cpf_cnpj_hash = excluded.cpf_cnpj_hash,
        cpf_cnpj_encriptado = excluded.cpf_cnpj_encriptado,
        nome = excluded.nome,
        email = coalesce(excluded.email, pacientes.email),
        atualizado_em = now()
      returning id
    `;
    const { rows } = await this.pool.query(sql, [
      medicoId, telefone, p.nome, p.email ?? null, cpfHash, p.cpfLimpo, this.chaveCriptografia
    ]);
    return { id: rows[0].id };
  }
}
