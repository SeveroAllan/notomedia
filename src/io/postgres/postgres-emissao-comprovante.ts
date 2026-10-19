import { createHash } from 'node:crypto';
import type pg from 'pg';
import { decidirPedidoComprovante, type DecisaoPedidoComprovante, type ResultadoExtracaoComprovante, type EstadoPedidoComprovante } from '../../atendimento/comprovante.js';
import { montarDescricaoServico } from '../../emissao/montar-descricao-servico.js';
import { PostgresEmissaoApiRepositorio } from './postgres-emissao-api-repositorio.js';

type Pronto = Extract<DecisaoPedidoComprovante, { tipo: 'pedido_nota_pronto' }>;
interface EntradaEmissaoComprovante {
  consulta?: EstadoPedidoComprovante['consulta'];
  medicoId: string; pacienteId: string; lido: ResultadoExtracaoComprovante | null; decisao: DecisaoPedidoComprovante;
}
export type ResultadoEmissaoComprovante = { tipo: 'enfileirada'; solicitacaoId: string }
  | { tipo: 'nenhuma' } | { tipo: 'perguntar_medico'; motivo: string };
const perguntar = (motivo: string): ResultadoEmissaoComprovante => ({ tipo: 'perguntar_medico', motivo });

export class PostgresEmissaoComprovante {
  private readonly emissao: PostgresEmissaoApiRepositorio;
  constructor(private readonly pool: pg.Pool, private readonly chaveCriptografia: string, pepper: string) {
    this.emissao = new PostgresEmissaoApiRepositorio(pool, chaveCriptografia, pepper);
  }

  async enfileirar(entrada: EntradaEmissaoComprovante): Promise<ResultadoEmissaoComprovante> {
    const { decisao, lido } = entrada;
    if (decisao.tipo !== 'pedido_nota_pronto' && !(decisao.tipo === 'nenhuma' && decisao.motivo === 'COMPROVANTE_JA_PROCESSADO')) return { tipo: 'nenhuma' };
    if (lido?.tipo !== 'extraido') return perguntar('COMPROVANTE_SEM_AUDITORIA_PRONTA');
    let client: pg.PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('begin');
      // Compartilha o mesmo bloqueio da auditoria, inclusive em processos distintos.
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [entrada.medicoId]);
      const resultado = await this.preparar(client, entrada, lido);
      await client.query('commit');
      return resultado;
    } catch {
      await client?.query('rollback').catch(() => {});
      return perguntar('ENFILEIRAMENTO_COMPROVANTE_FALHOU');
    } finally { client?.release(); }
  }

  private async preparar(client: pg.PoolClient, entrada: EntradaEmissaoComprovante, lido: Extract<ResultadoExtracaoComprovante, { tipo: 'extraido' }>): Promise<ResultadoEmissaoComprovante> {
    const { medicoId, pacienteId } = entrada;
    const { valorCentavos, dataPagamento, nomePagador } = lido.campos;
    const { rows: auditorias } = await client.query(`select id, decisao from public.noto_auditoria_comprovantes
      where medico_id = $1 and lido->>'tipo' = 'extraido'
        and lido->'campos'->>'valorCentavos' = $2::text and lido->'campos'->>'dataPagamento' = $3
        and lido->'campos'->>'nomePagador' = $4 and decisao->>'tipo' = 'pedido_nota_pronto'
      order by criado_em desc, id desc limit 1`, [medicoId, valorCentavos, dataPagamento, nomePagador]);
    if (!auditorias[0]) return perguntar('COMPROVANTE_SEM_AUDITORIA_PRONTA');
    const { rows: pacientes } = await client.query(`select p.nome, case when p.cpf_cnpj_encriptado is not null
      then pgp_sym_decrypt(p.cpf_cnpj_encriptado, $3) end as cpf from pacientes p
      where p.medico_id = $1 and p.id = $2 for share`, [medicoId, pacienteId, this.chaveCriptografia]);
    const consulta = entrada.consulta ? { fonte: entrada.consulta.fonte, id_externo: entrada.consulta.idExterno,
      data_hora: entrada.consulta.dataHora, valor_consulta_centavos: entrada.consulta.valorConsultaCentavos } : null;
    if (!consulta) return perguntar('CONSULTA_AMBIGUA_OU_AUSENTE');
    const atual = decidirPedidoComprovante(lido, { medicoId, paciente: pacientes[0] ?? { nome: null, cpf: null },
      ultimaConsulta: consulta ? { valorConsultaCentavos: consulta.valor_consulta_centavos } : null }, []);
    const auditada = auditorias[0].decisao as DecisaoPedidoComprovante;
    if (atual.tipo !== 'pedido_nota_pronto' || auditada.tipo !== 'pedido_nota_pronto' || !this.mesmoPedido(atual, auditada)) return perguntar('CADASTRO_OU_CONSULTA_DIVERGENTE');
    if (entrada.decisao.tipo === 'pedido_nota_pronto' && !this.mesmoPedido(atual, entrada.decisao)) return perguntar('PEDIDO_DIVERGENTE');
    return this.reservarEEnfileirar(client, entrada, atual, consulta, auditorias[0].id);
  }

  private mesmoPedido(a: Pronto, b: Pronto): boolean {
    return a.pedido.medicoId === b.pedido.medicoId && a.pedido.valorCentavos === b.pedido.valorCentavos &&
      a.pedido.dataPagamento === b.pedido.dataPagamento && a.pedido.paciente.nome === b.pedido.paciente.nome &&
      a.pedido.paciente.cpf === b.pedido.paciente.cpf && a.pedido.observacao?.pagador === b.pedido.observacao?.pagador;
  }

  private async reservarEEnfileirar(client: pg.PoolClient, entrada: EntradaEmissaoComprovante, pronto: Pronto,
    consulta: { fonte: string; id_externo: string; data_hora: string | Date }, auditoriaId: string): Promise<ResultadoEmissaoComprovante> {
    const { medicoId, pacienteId, lido } = entrada;
    if (lido?.tipo !== 'extraido') return perguntar('COMPROVANTE_SEM_AUDITORIA_PRONTA');
    const chave = createHash('sha256').update(JSON.stringify([lido.campos.valorCentavos, lido.campos.dataPagamento, lido.campos.nomePagador])).digest('hex');
    const { rows: existentes } = await client.query(`select estado, solicitacao_id from public.noto_emissoes_comprovantes
      where medico_id = $1 and (comprovante_chave = $2 or (fonte = $3 and consulta_id_externo = $4)) for update`,
    [medicoId, chave, consulta.fonte, consulta.id_externo]);
    if (existentes[0]) return ['bloqueada', 'erro'].includes(existentes[0].estado) ? perguntar('EMISSAO_COMPROVANTE_BLOQUEADA') : { tipo: 'nenhuma' };
    const { rows: ambientes } = await client.query('select ambiente from medico_perfil_fiscal where medico_id = $1 for share', [medicoId]);
    const perfil = await this.emissao.buscarPerfilFiscalMedico(medicoId, client);
    const erro = ambientes[0]?.ambiente !== 'homologacao' ? 'AMBIENTE_NAO_HOMOLOGACAO' : !perfil?.configuracaoCompleta ? 'PERFIL_FISCAL_INCOMPLETO' : null;
    const { rows: reservas } = await client.query(`insert into public.noto_emissoes_comprovantes
      (medico_id, fonte, consulta_id_externo, comprovante_chave, auditoria_comprovante_id, estado, erro_codigo)
      values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [medicoId, consulta.fonte, consulta.id_externo, chave, auditoriaId, erro ? 'bloqueada' : 'enfileirada', erro]);
    if (erro || !perfil) return perguntar(erro ?? 'PERFIL_FISCAL_INCOMPLETO');
    const datas = new Date(consulta.data_hora).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const observacao = pronto.pedido.observacao ? `. Pagamento realizado por ${pronto.pedido.observacao.pagador}.` : '';
    const solicitacao = await this.emissao.enfileirarSolicitacao({ ref: `comprovante:${reservas[0].id}`, medicoId, pacienteId,
      valorServicoCentavos: pronto.pedido.valorCentavos, xdescServ: montarDescricaoServico(perfil, datas) + observacao,
      ctribNac: perfil.ctribNacPadrao, cnbs: perfil.cnbs, cclassTrib: perfil.cclassTrib, cindOp: perfil.cindOp,
      datasConsultaTexto: datas, origem: 'whatsapp' }, client);
    await client.query(`update public.noto_emissoes_comprovantes set solicitacao_id = $2, atualizado_em = now() where id = $1`, [reservas[0].id, solicitacao.id]);
    return { tipo: 'enfileirada', solicitacaoId: solicitacao.id };
  }
}
