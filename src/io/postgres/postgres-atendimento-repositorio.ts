/**
 * Implementação PostgreSQL da porta `AtendimentoRepositorio`.
 * Executa queries parametrizadas com encriptação simétrica de CPF via pgcrypto
 * e gerencia conversas, agendamentos e fila de notas fiscais na VPS (seções 2, 3 e 4.1).
 */

import type pg from 'pg';
import type { EstadoPedidoComprovante, LeitorEstadoPedidoComprovante } from '../../atendimento/comprovante.js';
import type {
  AtendimentoRepositorio,
  InstanciaRegistro,
  ConversaRegistro,
  PacienteRegistro,
  MedicoDadosRegistro
} from '../../atendimento/atendimento-repositorio.js';
import { gerarVariantesTelefoneBrasileiro } from '../../whatsapp/variantes-telefone-brasileiro.js';

export class PostgresAtendimentoRepositorio implements AtendimentoRepositorio, LeitorEstadoPedidoComprovante {
  constructor(
    private readonly pool: pg.Pool,
    private readonly chaveCriptografia: string
  ) {}

  async lerEstado(medicoId: string, pacienteId: string): Promise<EstadoPedidoComprovante> {
    const { rows } = await this.pool.query(`
      select p.nome, case when p.cpf_cnpj_encriptado is not null
        then pgp_sym_decrypt(p.cpf_cnpj_encriptado, $3) end as cpf
      from pacientes p
      where p.medico_id = $1 and p.id = $2
    `, [medicoId, pacienteId, this.chaveCriptografia]);
    const linha = rows[0];
    return { medicoId, paciente: { nome: linha?.nome ?? null, cpf: linha?.cpf ?? null },
      ultimaConsulta: null };
  }

  async buscarInstanciaPorNome(nomeInstancia: string): Promise<InstanciaRegistro | null> {
    const sql = `
      select id, medico_id, nome_instancia, oficial
      from whatsapp_instancias
      where nome_instancia = $1
      limit 1
    `;
    const { rows } = await this.pool.query(sql, [nomeInstancia]);
    if (rows.length === 0) return null;
    return {
      id: rows[0].id,
      medicoId: rows[0].medico_id,
      nomeInstancia: rows[0].nome_instancia,
      oficial: rows[0].oficial
    };
  }

  async buscarOuCriarConversa(instanciaId: string, medicoId: string | null, contatoTelefone: string, contatoNome?: string | null): Promise<ConversaRegistro> {
    const sqlBusca = `
      select id, instancia_id, medico_id, contato_telefone, contato_nome, paciente_id, aguardando_cpf_desde
      from whatsapp_conversas
      where instancia_id = $1 and contato_telefone = $2
      limit 1
    `;
    const { rows: rowsBusca } = await this.pool.query(sqlBusca, [instanciaId, contatoTelefone]);
    if (rowsBusca.length > 0) {
      if (!rowsBusca[0].medico_id && medicoId) {
        await this.pool.query(`update whatsapp_conversas set medico_id = $2 where id = $1`, [rowsBusca[0].id, medicoId]);
        rowsBusca[0].medico_id = medicoId;
      }
      if (!rowsBusca[0].contato_nome && contatoNome) {
        await this.pool.query(`update whatsapp_conversas set contato_nome = $2 where id = $1`, [rowsBusca[0].id, contatoNome]);
        rowsBusca[0].contato_nome = contatoNome;
      }
      return {
        id: rowsBusca[0].id,
        instanciaId: rowsBusca[0].instancia_id,
        medicoId: rowsBusca[0].medico_id,
        contatoTelefone: rowsBusca[0].contato_telefone,
        contatoNome: rowsBusca[0].contato_nome,
        pacienteId: rowsBusca[0].paciente_id,
        aguardandoCpfDesde: rowsBusca[0].aguardando_cpf_desde ? new Date(rowsBusca[0].aguardando_cpf_desde) : null
      };
    }

    const sqlInsere = `
      insert into whatsapp_conversas (instancia_id, medico_id, contato_telefone, contato_nome, ultima_mensagem_em)
      values ($1, $2, $3, $4, now())
      returning id, instancia_id, medico_id, contato_telefone, contato_nome, paciente_id, aguardando_cpf_desde
    `;
    const { rows: rowsInsere } = await this.pool.query(sqlInsere, [instanciaId, medicoId, contatoTelefone, contatoNome ?? null]);
    return {
      id: rowsInsere[0].id,
      instanciaId: rowsInsere[0].instancia_id,
      medicoId: rowsInsere[0].medico_id,
      contatoTelefone: rowsInsere[0].contato_telefone,
      contatoNome: rowsInsere[0].contato_nome,
      pacienteId: rowsInsere[0].paciente_id,
      aguardandoCpfDesde: null
    };
  }

  async buscarPacientePorTelefone(medicoId: string, telefone: string): Promise<PacienteRegistro | null> {
    const sql = `
      select id, medico_id, telefone, nome, nome_validado, cpf_cnpj_hash, email, data_nascimento
      from pacientes
      where medico_id = $1 and telefone = $2
      limit 1
    `;
    const { rows } = await this.pool.query(sql, [medicoId, telefone]);
    if (rows.length === 0) return null;
    return {
      id: rows[0].id,
      medicoId: rows[0].medico_id,
      telefone: rows[0].telefone,
      nome: rows[0].nome,
      nomeValidado: Boolean(rows[0].nome_validado),
      cpfHash: rows[0].cpf_cnpj_hash,
      email: rows[0].email,
      dataNascimento: rows[0].data_nascimento ? new Date(rows[0].data_nascimento) : null
    };
  }

  async criarPacienteMinimo(params: {
    medicoId: string;
    telefone: string;
    nome?: string | null;
    email?: string | null;
    cpfHash?: string | null;
    cpf?: string | null;
    origemCadastro?: string;
  }): Promise<PacienteRegistro> {
    const sql = `
      insert into pacientes (medico_id, telefone, nome, email, cpf_cnpj_hash, cpf_cnpj_encriptado, origem_cadastro)
      values ($1, $2, $3, $4, $5, case when $7::text is not null then pgp_sym_encrypt($7, $8) else null end, coalesce($6, 'conversa'))
      on conflict (medico_id, telefone) do update set
        nome = case
          when pacientes.nome_validado = true then pacientes.nome
          when pacientes.nome is not null and trim(pacientes.nome) != '' and upper(trim(pacientes.nome)) != 'PACIENTE'
          then pacientes.nome
          else coalesce(excluded.nome, pacientes.nome)
        end,
        email = coalesce(excluded.email, pacientes.email),
        cpf_cnpj_hash = coalesce(excluded.cpf_cnpj_hash, pacientes.cpf_cnpj_hash),
        cpf_cnpj_encriptado = coalesce(excluded.cpf_cnpj_encriptado, pacientes.cpf_cnpj_encriptado)
      returning id, medico_id, telefone, nome, nome_validado, cpf_cnpj_hash, email
    `;
    const values = [
      params.medicoId,
      params.telefone,
      params.nome,
      params.email,
      params.cpfHash,
      params.origemCadastro,
      params.cpf ?? null,
      this.chaveCriptografia
    ];
    const { rows } = await this.pool.query(sql, values);
    return {
      id: rows[0].id,
      medicoId: rows[0].medico_id,
      telefone: rows[0].telefone,
      nome: rows[0].nome,
      nomeValidado: Boolean(rows[0].nome_validado),
      cpfHash: rows[0].cpf_cnpj_hash,
      email: rows[0].email
    };
  }

  async atualizarCpfPaciente(params: {
    pacienteId: string;
    cpfHash: string;
    cpf?: string | null;
    nome?: string | null;
    dataNascimento?: Date | null;
    nomeValidado?: boolean;
  }): Promise<void> {
    const sql = `
      update pacientes
      set cpf_cnpj_hash = $2,
          cpf_cnpj_encriptado = case when $5::text is not null then pgp_sym_encrypt($5, $6) else cpf_cnpj_encriptado end,
          nome = case
            when pacientes.nome_validado = true then pacientes.nome
            when $7::boolean = true then coalesce($3, pacientes.nome)
            else coalesce($3, pacientes.nome)
          end,
          nome_validado = case
            when pacientes.nome_validado = true then true
            else coalesce($7, false)
          end,
          data_nascimento = coalesce($4, data_nascimento),
          atualizado_em = now()
      where id = $1
    `;
    await this.pool.query(sql, [
      params.pacienteId,
      params.cpfHash,
      params.nome,
      params.dataNascimento,
      params.cpf ?? null,
      this.chaveCriptografia,
      Boolean(params.nomeValidado)
    ]);
  }


  async vincularPacienteConversa(conversaId: string, pacienteId: string): Promise<void> {
    const sql = `update whatsapp_conversas set paciente_id = $2 where id = $1`;
    await this.pool.query(sql, [conversaId, pacienteId]);
  }

  async buscarMedicoPorTelefone(telefone: string): Promise<MedicoDadosRegistro | null> {
    const variantes = gerarVariantesTelefoneBrasileiro(telefone);
    if (variantes.length === 0) return null;
    const sql = `
      select m.id, m.nome_completo, m.especialidade, m.crm, m.rqe,
             coalesce(msf.ctrib_nac, '') as ctrib_nac_padrao,
             u.telefone
      from medicos m
      join usuarios u on u.id = m.usuario_id
      left join medico_servicos_fiscais msf on msf.medico_id = m.id and msf.padrao = true and msf.ativo = true
      where regexp_replace(u.telefone, '\\D', '', 'g') = any($1::text[])
      limit 2
    `;
    const { rows } = await this.pool.query(sql, [variantes]);
    if (rows.length !== 1) return null;
    return {
      id: rows[0].id,
      nomeCompleto: rows[0].nome_completo,
      especialidade: rows[0].especialidade,
      crm: rows[0].crm,
      rqe: rows[0].rqe,
      ctribNacPadrao: rows[0].ctrib_nac_padrao,
      telefone: rows[0].telefone
    };
  }

  async salvarMensagem(params: {
    conversaId: string;
    direcao: 'recebida' | 'enviada';
    tipoMensagem?: string;
    conteudo: string;
    payloadBruto?: unknown;
    comandoDetectado?: string | null;
    criadoEm?: Date;
  }): Promise<void> {
    const keyId = (params.payloadBruto as any)?.key?.id;
    if (keyId) {
      const sqlComChave = `
        insert into whatsapp_mensagens (conversa_id, direcao, tipo_mensagem, conteudo, payload_bruto, comando_detectado, criado_em)
        select $1, $2, coalesce($3, 'texto'), $4, $5, $6, coalesce($7, now())
        where not exists (
          select 1 from whatsapp_mensagens
          where conversa_id = $1 and payload_bruto->'key'->>'id' = $8
        )
      `;
      await this.pool.query(sqlComChave, [
        params.conversaId,
        params.direcao,
        params.tipoMensagem || 'texto',
        params.conteudo,
        params.payloadBruto ? JSON.stringify(params.payloadBruto) : null,
        params.comandoDetectado || null,
        params.criadoEm || null,
        keyId
      ]);
      return;
    }

    const sql = `
      insert into whatsapp_mensagens (conversa_id, direcao, tipo_mensagem, conteudo, payload_bruto, comando_detectado, criado_em)
      values ($1, $2, coalesce($3, 'texto'), $4, $5, $6, coalesce($7, now()))
    `;
    await this.pool.query(sql, [
      params.conversaId,
      params.direcao,
      params.tipoMensagem || 'texto',
      params.conteudo,
      params.payloadBruto ? JSON.stringify(params.payloadBruto) : null,
      params.comandoDetectado || null,
      params.criadoEm || null
    ]);
  }

  async salvarMensagensEmLote(mensagens: Array<{
    conversaId: string;
    direcao: 'recebida' | 'enviada';
    tipoMensagem?: string;
    conteudo: string;
    payloadBruto?: unknown;
    comandoDetectado?: string | null;
    criadoEm?: Date;
  }>): Promise<void> {
    if (!mensagens?.length) return;

    const porConversa = agruparPorConversa(mensagens);
    for (const [conversaId, msgs] of porConversa.entries()) {
      await this.salvarLoteConversa(conversaId, msgs);
    }
  }

  private async salvarLoteConversa(conversaId: string, msgs: any[]): Promise<void> {
    const unicas = new Map<string, any>();
    const semKey: any[] = [];
    for (const m of msgs) {
      const keyId = (m.payloadBruto as any)?.key?.id;
      if (keyId) {
        if (!unicas.has(keyId)) unicas.set(keyId, m);
      } else {
        semKey.push(m);
      }
    }

    const chaves = Array.from(unicas.keys());
    const existentes = chaves.length > 0 ? await this.buscarChavesExistentes(conversaId, chaves) : new Set<string>();
    const paraInserir = [...Array.from(unicas.entries()).filter(([k]) => !existentes.has(k)).map(([, m]) => m), ...semKey];
    if (!paraInserir.length) return;

    await this.executarBatchInsertMensagens(paraInserir);
  }

  private async buscarChavesExistentes(conversaId: string, chaves: string[]): Promise<Set<string>> {
    const sql = `
      select payload_bruto->'key'->>'id' as key_id
      from whatsapp_mensagens
      where conversa_id = $1 and payload_bruto->'key'->>'id' = any($2::text[])
    `;
    const { rows } = await this.pool.query(sql, [conversaId, chaves]);
    return new Set(rows.map((r: { key_id: string }) => r.key_id));
  }

  private async executarBatchInsertMensagens(mensagens: any[]): Promise<void> {
    const TAMANHO = 50;
    for (let i = 0; i < mensagens.length; i += TAMANHO) {
      const chunk = mensagens.slice(i, i + TAMANHO);
      const placeholders: string[] = [];
      const params: any[] = [];
      let p = 1;
      for (const m of chunk) {
        placeholders.push(`($${p++}, $${p++}, coalesce($${p++}, 'texto'), $${p++}, $${p++}, $${p++}, coalesce($${p++}, now()))`);
        params.push(
          m.conversaId,
          m.direcao,
          m.tipoMensagem || 'texto',
          m.conteudo,
          m.payloadBruto ? JSON.stringify(m.payloadBruto) : null,
          m.comandoDetectado || null,
          m.criadoEm || null
        );
      }
      const sql = `
        insert into whatsapp_mensagens (conversa_id, direcao, tipo_mensagem, conteudo, payload_bruto, comando_detectado, criado_em)
        values ${placeholders.join(', ')}
      `;
      await this.pool.query(sql, params);
    }
  }
}

function agruparPorConversa<T extends { conversaId: string }>(itens: T[]): Map<string, T[]> {
  const mapa = new Map<string, T[]>();
  for (const item of itens) {
    const lista = mapa.get(item.conversaId) || [];
    lista.push(item);
    mapa.set(item.conversaId, lista);
  }
  return mapa;
}
