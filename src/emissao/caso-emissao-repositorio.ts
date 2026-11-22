/**
 * Porta e implementação PostgreSQL para casos conversacionais de emissão pelo
 * WhatsApp (`noto_casos_emissao`) e vínculos aprendidos de pagadores
 * secundários (`conta_pagadores_secundarios`). Mantém CPF sempre criptografado
 * no banco e oferece verificação de consultas já emitidas sem acoplar regras.
 */

import type pg from 'pg';
import { gerarHashCpf } from '../paciente/hash-cpf.js';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';
import {
  chaveAtendimentoSemNota,
  normalizarNomeParaBusca,
  type PagadorSecundarioSalvo
} from './cruzar-comprovante-agenda.js';

export type OrigemCasoEmissao = 'comprovante_paciente' | 'comprovante_medico' | 'pedido_medico';

export type EstadoCasoEmissao =
  | 'aguardando_esclarecimento'
  | 'aguardando_cpf_paciente'
  | 'aguardando_cpf_medico'
  | 'aguardando_aprovacao_medico'
  | 'aguardando_prontidao_fiscal'
  | 'enfileirada'
  | 'emitida'
  | 'erro'
  | 'cancelada';

export interface ChaveMensagemCaso {
  id: string;
  remoteJid: string;
  fromMe: boolean;
}

export interface CasoEmissaoRegistro {
  id: string;
  contaId: string;
  medicoId: string | null;
  origem: OrigemCasoEmissao;
  chaveIdempotencia: string;
  estado: EstadoCasoEmissao;
  pacienteNome: string | null;
  pacienteTelefone: string | null;
  pacienteCpf: string | null;
  pagadorNome: string | null;
  pagadorCpfHash: string | null;
  atendimentoExternoId: string | null;
  dataConsulta: string | null;
  valorCentavos: number | null;
  aprovadoPeloMedico: boolean;
  ambiente: 'homologacao' | 'producao';
  origemMensagemChave: ChaveMensagemCaso | null;
  solicitacaoId: string | null;
  notaFiscalId: string | null;
  erroMotivo: string | null;
  criadoEm: string;
  atualizadoEm: string;
}

export interface EntradaCriarCasoEmissao {
  contaId: string;
  medicoId: string | null;
  origem: OrigemCasoEmissao;
  chaveIdempotencia: string;
  estado: EstadoCasoEmissao;
  pacienteNome?: string | null;
  pacienteTelefone?: string | null;
  pacienteCpf?: string | null;
  pagadorNome?: string | null;
  pagadorCpf?: string | null;
  atendimentoExternoId?: string | null;
  dataConsulta?: string | null;
  valorCentavos?: number | null;
  aprovadoPeloMedico?: boolean;
  ambiente?: 'homologacao' | 'producao';
  origemMensagemChave?: ChaveMensagemCaso | null;
}

export interface AtualizacaoCasoEmissao {
  medicoId?: string | null;
  estado?: EstadoCasoEmissao;
  pacienteNome?: string | null;
  pacienteTelefone?: string | null;
  pacienteCpf?: string | null;
  atendimentoExternoId?: string | null;
  dataConsulta?: string | null;
  valorCentavos?: number | null;
  aprovadoPeloMedico?: boolean;
  solicitacaoId?: string | null;
  notaFiscalId?: string | null;
  erroMotivo?: string | null;
}

export interface CasoEmissaoRepositorio {
  buscarPorChaveIdempotencia(contaId: string, chave: string): Promise<CasoEmissaoRegistro | null>;
  buscarPorId(contaId: string, casoId: string): Promise<CasoEmissaoRegistro | null>;
  buscarPorSolicitacaoId(solicitacaoId: string): Promise<CasoEmissaoRegistro | null>;
  buscarAbertoPorTelefonePaciente(contaId: string, telefone: string): Promise<CasoEmissaoRegistro | null>;
  listarAbertosOuRecentes(contaId: string, limite?: number): Promise<CasoEmissaoRegistro[]>;
  criar(entrada: EntradaCriarCasoEmissao): Promise<CasoEmissaoRegistro>;
  atualizar(contaId: string, casoId: string, delta: AtualizacaoCasoEmissao): Promise<CasoEmissaoRegistro | null>;
  listarChavesConsultasComNota(contaId: string): Promise<Set<string>>;
  listarPagadoresSecundarios(contaId: string): Promise<PagadorSecundarioSalvo[]>;
  salvarPagadorSecundario(entrada: {
    contaId: string;
    pagadorNome: string;
    pagadorCpf?: string | null;
    pacienteNome: string;
    pacienteTelefone?: string | null;
    emitirNoCpfDe?: 'paciente' | 'pagador';
  }): Promise<PagadorSecundarioSalvo>;
}

const SELECT_CASO = (paramChaveCripto: string) => `
  select id, conta_id, medico_id, origem, chave_idempotencia, estado,
         paciente_nome, paciente_telefone,
         case when paciente_cpf_encriptado is not null
           then pgp_sym_decrypt(paciente_cpf_encriptado, ${paramChaveCripto})
           else null end as paciente_cpf,
         pagador_nome, pagador_cpf_hash, atendimento_externo_id,
         to_char(data_consulta, 'YYYY-MM-DD') as data_consulta,
         valor_centavos, aprovado_pelo_medico, ambiente, origem_mensagem_chave,
         solicitacao_id, nota_fiscal_id, erro_motivo, criado_em, atualizado_em
  from public.noto_casos_emissao
`;

function mapearLinhaCaso(r: any): CasoEmissaoRegistro {
  return {
    id: String(r.id),
    contaId: String(r.conta_id),
    medicoId: r.medico_id ? String(r.medico_id) : null,
    origem: r.origem,
    chaveIdempotencia: String(r.chave_idempotencia),
    estado: r.estado,
    pacienteNome: r.paciente_nome ?? null,
    pacienteTelefone: r.paciente_telefone ?? null,
    pacienteCpf: r.paciente_cpf ?? null,
    pagadorNome: r.pagador_nome ?? null,
    pagadorCpfHash: r.pagador_cpf_hash ?? null,
    atendimentoExternoId: r.atendimento_externo_id ?? null,
    dataConsulta: r.data_consulta ?? null,
    valorCentavos: r.valor_centavos != null ? Number(r.valor_centavos) : null,
    aprovadoPeloMedico: Boolean(r.aprovado_pelo_medico),
    ambiente: r.ambiente === 'producao' ? 'producao' : 'homologacao',
    origemMensagemChave: r.origem_mensagem_chave ?? null,
    solicitacaoId: r.solicitacao_id ? String(r.solicitacao_id) : null,
    notaFiscalId: r.nota_fiscal_id ? String(r.nota_fiscal_id) : null,
    erroMotivo: r.erro_motivo ?? null,
    criadoEm: new Date(r.criado_em).toISOString(),
    atualizadoEm: new Date(r.atualizado_em).toISOString()
  };
}

export class PostgresCasoEmissaoRepositorio implements CasoEmissaoRepositorio {
  constructor(
    private readonly pool: pg.Pool,
    private readonly chaveCriptografia: string,
    private readonly pepper: string
  ) {}

  async buscarPorChaveIdempotencia(contaId: string, chave: string): Promise<CasoEmissaoRegistro | null> {
    const { rows } = await this.pool.query(
      `${SELECT_CASO('$3')} where conta_id = $1 and chave_idempotencia = $2 limit 1`,
      [contaId, chave, this.chaveCriptografia]
    );
    return rows[0] ? mapearLinhaCaso(rows[0]) : null;
  }

  async buscarPorId(contaId: string, casoId: string): Promise<CasoEmissaoRegistro | null> {
    const { rows } = await this.pool.query(
      `${SELECT_CASO('$3')} where conta_id = $1 and id = $2 limit 1`,
      [contaId, casoId, this.chaveCriptografia]
    );
    return rows[0] ? mapearLinhaCaso(rows[0]) : null;
  }

  async buscarPorSolicitacaoId(solicitacaoId: string): Promise<CasoEmissaoRegistro | null> {
    const { rows } = await this.pool.query(
      `${SELECT_CASO('$2')} where solicitacao_id = $1 limit 1`,
      [solicitacaoId, this.chaveCriptografia]
    );
    return rows[0] ? mapearLinhaCaso(rows[0]) : null;
  }

  async buscarAbertoPorTelefonePaciente(contaId: string, telefone: string): Promise<CasoEmissaoRegistro | null> {
    const variantes = gerarVariantesTelefoneBrasileiro(telefone);
    if (!variantes.length) return null;
    const { rows } = await this.pool.query(
      `${SELECT_CASO('$3')}
       where conta_id = $1
         and estado = 'aguardando_cpf_paciente'
         and regexp_replace(coalesce(paciente_telefone, ''), '[^0-9]', '', 'g') = any($2::text[])
       order by atualizado_em desc
       limit 1`,
      [contaId, variantes, this.chaveCriptografia]
    );
    return rows[0] ? mapearLinhaCaso(rows[0]) : null;
  }

  async listarAbertosOuRecentes(contaId: string, limite = 12): Promise<CasoEmissaoRegistro[]> {
    const { rows } = await this.pool.query(
      `${SELECT_CASO('$3')} where conta_id = $1 order by atualizado_em desc limit $2`,
      [contaId, Math.min(Math.max(limite, 1), 30), this.chaveCriptografia]
    );
    return rows.map(mapearLinhaCaso);
  }

  async criar(entrada: EntradaCriarCasoEmissao): Promise<CasoEmissaoRegistro> {
    const cpfLimpo = entrada.pacienteCpf?.replace(/\D/g, '') || null;
    const cpfHash = cpfLimpo ? gerarHashCpf(cpfLimpo, this.pepper) : null;
    const pagadorCpfLimpo = entrada.pagadorCpf?.replace(/\D/g, '') || null;
    const pagadorCpfHash = pagadorCpfLimpo ? gerarHashCpf(pagadorCpfLimpo, this.pepper) : null;
    const { rows } = await this.pool.query(
      `insert into public.noto_casos_emissao (
         conta_id, medico_id, origem, chave_idempotencia, estado,
         paciente_nome, paciente_telefone, paciente_cpf_hash, paciente_cpf_encriptado,
         pagador_nome, pagador_cpf_hash, atendimento_externo_id, data_consulta,
         valor_centavos, aprovado_pelo_medico, ambiente, origem_mensagem_chave
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8,
         case when $9::text is not null then pgp_sym_encrypt($9::text, $10) else null end,
         $11, $12, $13, $14::date, $15, $16, $17, $18::jsonb
       )
       on conflict (conta_id, chave_idempotencia) do update set atualizado_em = now()
       returning id`,
      [
        entrada.contaId, entrada.medicoId, entrada.origem, entrada.chaveIdempotencia, entrada.estado,
        entrada.pacienteNome ?? null, entrada.pacienteTelefone ?? null, cpfHash, cpfLimpo, this.chaveCriptografia,
        entrada.pagadorNome ?? null, pagadorCpfHash, entrada.atendimentoExternoId ?? null,
        entrada.dataConsulta ?? null, entrada.valorCentavos ?? null,
        Boolean(entrada.aprovadoPeloMedico), entrada.ambiente ?? 'homologacao',
        entrada.origemMensagemChave ? JSON.stringify(entrada.origemMensagemChave) : null
      ]
    );
    return (await this.buscarPorId(entrada.contaId, String(rows[0].id)))!;
  }

  async atualizar(contaId: string, casoId: string, delta: AtualizacaoCasoEmissao): Promise<CasoEmissaoRegistro | null> {
    const sets: string[] = ['atualizado_em = now()'];
    const params: unknown[] = [contaId, casoId];
    const push = (col: string, val: unknown, cast = '') => {
      params.push(val);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if (delta.medicoId !== undefined) push('medico_id', delta.medicoId);
    if (delta.estado !== undefined) push('estado', delta.estado);
    if (delta.pacienteNome !== undefined) push('paciente_nome', delta.pacienteNome);
    if (delta.pacienteTelefone !== undefined) push('paciente_telefone', delta.pacienteTelefone);
    if (delta.atendimentoExternoId !== undefined) push('atendimento_externo_id', delta.atendimentoExternoId);
    if (delta.dataConsulta !== undefined) push('data_consulta', delta.dataConsulta, '::date');
    if (delta.valorCentavos !== undefined) push('valor_centavos', delta.valorCentavos);
    if (delta.aprovadoPeloMedico !== undefined) push('aprovado_pelo_medico', delta.aprovadoPeloMedico);
    if (delta.solicitacaoId !== undefined) push('solicitacao_id', delta.solicitacaoId);
    if (delta.notaFiscalId !== undefined) push('nota_fiscal_id', delta.notaFiscalId);
    if (delta.erroMotivo !== undefined) push('erro_motivo', delta.erroMotivo);
    if (delta.pacienteCpf !== undefined) {
      const limpo = delta.pacienteCpf?.replace(/\D/g, '') || null;
      push('paciente_cpf_hash', limpo ? gerarHashCpf(limpo, this.pepper) : null);
      if (limpo) {
        params.push(limpo, this.chaveCriptografia);
        sets.push(`paciente_cpf_encriptado = pgp_sym_encrypt($${params.length - 1}, $${params.length})`);
      } else {
        sets.push('paciente_cpf_encriptado = null');
      }
    }

    await this.pool.query(
      `update public.noto_casos_emissao set ${sets.join(', ')} where conta_id = $1 and id = $2`,
      params
    );
    return this.buscarPorId(contaId, casoId);
  }

  async listarChavesConsultasComNota(contaId: string): Promise<Set<string>> {
    const chaves = new Set<string>();
    const { rows } = await this.pool.query(
      `select atendimento_externo_id, paciente_nome, to_char(data_consulta, 'YYYY-MM-DD') as data_consulta
       from public.noto_casos_emissao
       where conta_id = $1 and estado in ('enfileirada', 'emitida')`,
      [contaId]
    );
    for (const r of rows) {
      if (r.atendimento_externo_id) chaves.add(String(r.atendimento_externo_id));
      if (r.paciente_nome && r.data_consulta) {
        chaves.add(chaveAtendimentoSemNota(String(r.paciente_nome), String(r.data_consulta)));
      }
    }
    const notas = await this.pool.query(
      `select p.nome as paciente_nome,
              to_char(coalesce(n.competencia, s.competencia_emissao, n.data_emissao::date), 'YYYY-MM-DD') as data_ref
       from public.solicitacoes_nota s
       join public.medicos m on m.id = s.medico_id
       join public.pacientes p on p.id = s.paciente_id
       left join public.notas_fiscais n on n.solicitacao_id = s.id and n.status = 'autorizada'
       where m.conta_id = $1
         and (s.status in ('pronta', 'emitida') or n.id is not null)
         and s.criado_em > now() - interval '90 days'`,
      [contaId]
    ).catch(() => ({ rows: [] as any[] }));
    for (const r of notas.rows) {
      if (r.paciente_nome && r.data_ref) {
        chaves.add(chaveAtendimentoSemNota(String(r.paciente_nome), String(r.data_ref)));
      }
    }
    return chaves;
  }

  async listarPagadoresSecundarios(contaId: string): Promise<PagadorSecundarioSalvo[]> {
    const { rows } = await this.pool.query(
      `select id, pagador_nome_normalizado, pagador_cpf_hash, paciente_nome, paciente_telefone, emitir_no_cpf_de
       from public.conta_pagadores_secundarios
       where conta_id = $1
       order by atualizado_em desc`,
      [contaId]
    );
    return rows.map(r => ({
      id: String(r.id),
      pagadorNomeNormalizado: String(r.pagador_nome_normalizado),
      pagadorCpfHash: r.pagador_cpf_hash ?? null,
      pacienteNome: String(r.paciente_nome),
      pacienteTelefone: r.paciente_telefone ?? null,
      emitirNoCpfDe: r.emitir_no_cpf_de === 'pagador' ? 'pagador' : 'paciente'
    }));
  }

  async salvarPagadorSecundario(entrada: {
    contaId: string;
    pagadorNome: string;
    pagadorCpf?: string | null;
    pacienteNome: string;
    pacienteTelefone?: string | null;
    emitirNoCpfDe?: 'paciente' | 'pagador';
  }): Promise<PagadorSecundarioSalvo> {
    const norm = normalizarNomeParaBusca(entrada.pagadorNome);
    const cpfLimpo = entrada.pagadorCpf?.replace(/\D/g, '') || null;
    const cpfHash = cpfLimpo ? gerarHashCpf(cpfLimpo, this.pepper) : null;
    const emitirNoCpfDe = entrada.emitirNoCpfDe === 'pagador' ? 'pagador' : 'paciente';
    const { rows } = await this.pool.query(
      `insert into public.conta_pagadores_secundarios (
         conta_id, pagador_nome, pagador_nome_normalizado, pagador_cpf_hash,
         paciente_nome, paciente_telefone, emitir_no_cpf_de
       ) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (conta_id, pagador_nome_normalizado) do update set
         pagador_nome = excluded.pagador_nome,
         pagador_cpf_hash = coalesce(excluded.pagador_cpf_hash, conta_pagadores_secundarios.pagador_cpf_hash),
         paciente_nome = excluded.paciente_nome,
         paciente_telefone = coalesce(excluded.paciente_telefone, conta_pagadores_secundarios.paciente_telefone),
         emitir_no_cpf_de = excluded.emitir_no_cpf_de,
         atualizado_em = now()
       returning id, pagador_nome_normalizado, pagador_cpf_hash, paciente_nome, paciente_telefone, emitir_no_cpf_de`,
      [entrada.contaId, entrada.pagadorNome.trim(), norm, cpfHash, entrada.pacienteNome.trim(), entrada.pacienteTelefone ?? null, emitirNoCpfDe]
    );
    const r = rows[0];
    return {
      id: String(r.id),
      pagadorNomeNormalizado: String(r.pagador_nome_normalizado),
      pagadorCpfHash: r.pagador_cpf_hash ?? null,
      pacienteNome: String(r.paciente_nome),
      pacienteTelefone: r.paciente_telefone ?? null,
      emitirNoCpfDe: r.emitir_no_cpf_de === 'pagador' ? 'pagador' : 'paciente'
    };
  }
}
