import type { InterpretacaoConfirmacao } from '../../onboarding/confirmacao-emissao-medico.js';
import type pg from 'pg';
import { chaveComprovante, chaveConsulta, hashPedidoComprovante, decidirPedidoComprovante, type DecisaoPedidoComprovante, type ResultadoExtracaoComprovante, type EstadoPedidoComprovante } from '../../atendimento/comprovante.js';
import { montarDescricaoServico } from '../../emissao/montar-descricao-servico.js';
import { PostgresEmissaoApiRepositorio } from './postgres-emissao-api-repositorio.js';

type Pronto = Extract<DecisaoPedidoComprovante, { tipo: 'pedido_nota_pronto' }>;
interface EntradaEmissaoComprovante {
  consulta?: EstadoPedidoComprovante['consulta'];
  dataEnvioPagamento?: string | null;
  medicoId: string; pacienteId: string; lido: ResultadoExtracaoComprovante | null; decisao: DecisaoPedidoComprovante;
}
export type ResultadoEmissaoComprovante = { tipo: 'enfileirada'; solicitacaoId: string }
  | { tipo: 'nenhuma' } | { tipo: 'perguntar_medico'; motivo: string };
const perguntar = (motivo: string): ResultadoEmissaoComprovante => ({ tipo: 'perguntar_medico', motivo });

export class PostgresEmissaoComprovante {
  private readonly emissao: PostgresEmissaoApiRepositorio;
  constructor(private readonly pool: pg.Pool, private readonly chaveCriptografia: string, private readonly pepper: string) {
    this.emissao = new PostgresEmissaoApiRepositorio(pool, chaveCriptografia, pepper);
  }

  async consultaJaFaturada(medicoId: string, fonte: string, idExterno: string): Promise<boolean> {
    const { rows } = await this.pool.query(`select 1 from public.noto_emissoes_comprovantes
      where medico_id = $1 and consulta_chave = $2 and estado = 'nota_gerada'`,
      [medicoId, chaveConsulta(this.pepper, medicoId, fonte, idExterno)]);
    return rows.length > 0;
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
    if (!entrada.consulta) return perguntar('CONSULTA_AMBIGUA_OU_AUSENTE');
    const consultaChave = chaveConsulta(this.pepper, medicoId, entrada.consulta.fonte, entrada.consulta.idExterno);
    const { rows: auditorias } = await client.query(`select id, decisao from public.noto_auditoria_comprovantes
      where medico_id = $1 and lido->>'tipo' = 'extraido'
        and lido->'campos'->>'comprovanteHash' = $2 and estado->>'consultaChave' = $3
        and decisao->>'tipo' = 'pedido_nota_pronto'
      order by criado_em desc, id desc limit 1`, [medicoId, chaveComprovante(this.pepper, lido), consultaChave]);
    if (!auditorias[0]) return perguntar('COMPROVANTE_SEM_AUDITORIA_PRONTA');
    const { rows: pacientes } = await client.query(`select p.nome, case when p.cpf_cnpj_encriptado is not null
      then pgp_sym_decrypt(p.cpf_cnpj_encriptado, $3) end as cpf from pacientes p
      where p.medico_id = $1 and p.id = $2 for share`, [medicoId, pacienteId, this.chaveCriptografia]);
    const consulta = entrada.consulta ? { fonte: entrada.consulta.fonte, id_externo: entrada.consulta.idExterno,
      data_hora: entrada.consulta.dataHora, valor_consulta_centavos: entrada.consulta.valorConsultaCentavos } : null;
    if (!consulta) return perguntar('CONSULTA_AMBIGUA_OU_AUSENTE');
    const atual = decidirPedidoComprovante(lido, { medicoId, paciente: pacientes[0] ?? { nome: null, cpf: null },
      ultimaConsulta: consulta ? { valorConsultaCentavos: consulta.valor_consulta_centavos } : null }, []);
    const auditada = auditorias[0].decisao as { tipo: string; pedidoHash?: string };
    if (atual.tipo !== 'pedido_nota_pronto' || auditada.tipo !== 'pedido_nota_pronto' || hashPedidoComprovante(this.pepper, atual.pedido) !== auditada.pedidoHash) return perguntar('CADASTRO_OU_CONSULTA_DIVERGENTE');
    if (entrada.decisao.tipo === 'pedido_nota_pronto' && !this.mesmoPedido(atual, entrada.decisao)) return perguntar('PEDIDO_DIVERGENTE');
    return this.reservarEEnfileirar(client, entrada, atual, consulta, auditorias[0].id);
  }

  async buscarConfirmacoes(medicoId: string, client: Pick<pg.Pool, 'query'> = this.pool) {
    const { rows } = await client.query<{ id: string; auditoria_id: string; confirmacao: any; ambiente: string; estado_emissao: string; comprovante_chave: string; consulta_chave: string }>(
      `select s.id, a.id as auditoria_id, a.estado->'confirmacaoMedico' as confirmacao, pf.ambiente,
        e.estado as estado_emissao, e.comprovante_chave, e.consulta_chave
      from solicitacoes_nota s left join public.noto_emissoes_comprovantes e on e.solicitacao_id=s.id and e.medico_id=s.medico_id
      left join public.noto_auditoria_comprovantes a on a.id=e.auditoria_comprovante_id and a.medico_id=s.medico_id
      left join medico_perfil_fiscal pf on pf.medico_id=s.medico_id
      where s.medico_id=$1 and s.aguardando_confirmacao_medico=true
      order by s.id${client === this.pool ? '' : ' for update of s'}`, [medicoId]);
    return rows;
  }

  /** Libera sem pergunta quando a permissão gravada emitir_autonomo='autonomo' autoriza. Fica na auditoria. */
  async liberarPorPreferencia(medicoId: string, solicitacaoId: string, agora: Date): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [medicoId]);
      const liberada = await client.query(`update solicitacoes_nota set aguardando_confirmacao_medico=false, atualizado_em=now()
        where id=$1 and medico_id=$2 and aguardando_confirmacao_medico=true returning id`, [solicitacaoId, medicoId]);
      if (liberada.rows.length !== 1) { await client.query('rollback'); return false; }
      await client.query(`update public.noto_auditoria_comprovantes a set estado = jsonb_set(a.estado, '{confirmacaoMedico}',
        jsonb_build_object('eventos', coalesce(a.estado#>'{confirmacaoMedico,eventos}', '[]'::jsonb) || $3::jsonb))
        from public.noto_emissoes_comprovantes e where e.auditoria_comprovante_id=a.id and e.medico_id=$1 and e.solicitacao_id=$2`,
        [medicoId, solicitacaoId, JSON.stringify([{ tipo: 'preferencia_autonoma', origem: 'noto_permissoes:emitir_autonomo=autonomo', em: agora.toISOString() }])]);
      await client.query('commit');
      return true;
    } catch { await client.query('rollback'); return false; }
    finally { client.release(); }
  }

  async registrarPergunta(medicoId: string, solicitacaoId: string, resultado: string, chaveMensagem: string | undefined, agora: Date) {
    await this.pool.query(`update public.noto_auditoria_comprovantes a set estado = jsonb_set(a.estado, '{confirmacaoMedico}',
      (a.estado->'confirmacaoMedico') || $3::jsonb || jsonb_build_object('eventos', coalesce(a.estado#>'{confirmacaoMedico,eventos}', '[]'::jsonb) || $4::jsonb))
      from public.noto_emissoes_comprovantes e where e.auditoria_comprovante_id=a.id and e.medico_id=$1 and e.solicitacao_id=$2`,
      [medicoId, solicitacaoId, JSON.stringify({ envio: resultado, perguntaChave: resultado === 'enviado' ? chaveMensagem ?? null : null,
        perguntadaEm: agora.toISOString(), expiraEm: new Date(agora.getTime() + 48 * 60 * 60 * 1000).toISOString() }),
        JSON.stringify([{ tipo: 'pergunta', resultado, chaveMensagem: chaveMensagem ?? null, em: agora.toISOString() }])]);
  }

  /** TTL: 48 horas contadas do envio confirmado da pergunta. Silêncio mantém a flag ligada indefinidamente. */
  async confirmar(medicoId: string, chaveResposta: string, interpretacao: InterpretacaoConfirmacao, agora: Date,
    permitido: boolean, perguntaEsperada: string, chavePerguntaRespondida?: string): Promise<{ liberada: boolean; motivo: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [medicoId]);
      const pendentes = await this.buscarConfirmacoes(medicoId, client);
      const p = pendentes[0], c = p?.confirmacao;
      let motivo = pendentes.length !== 1 ? pendentes.length ? 'MULTIPLAS_PENDENTES' : 'SEM_PENDENTE'
        : !permitido || p.ambiente !== 'homologacao' ? 'ENVIO_BLOQUEADO'
        : !c || c.solicitacaoId !== p.id || c.comprovanteChave !== p.comprovante_chave || c.consultaChave !== p.consulta_chave || p.estado_emissao !== 'enfileirada' ? 'VINCULO_INVALIDO'
        : c.decisao === 'recusada' ? 'RECUSADA'
        : c.envio !== 'enviado' || !c.perguntaChave || c.perguntaChave !== perguntaEsperada || chavePerguntaRespondida && c.perguntaChave !== chavePerguntaRespondida ? 'PERGUNTA_NAO_CONFIRMADA'
        : !Number.isFinite(Date.parse(c.expiraEm)) || !Number.isFinite(Date.parse(c.perguntadaEm)) || agora.getTime() >= Math.min(Date.parse(c.expiraEm), Date.parse(c.perguntadaEm) + 48 * 60 * 60 * 1000) || agora.getTime() < Date.parse(c.perguntadaEm) ? 'EXPIRADA'
        : interpretacao.intencao === 'nao' && interpretacao.confianca >= 0.9 && interpretacao.confianca <= 1 ? 'RECUSADA'
        : interpretacao.intencao !== 'sim' || !Number.isFinite(interpretacao.confianca) || interpretacao.confianca < 0.9 || interpretacao.confianca > 1 ? 'CONFIRMACAO_INSUFICIENTE' : 'CONFIRMADA';
      for (const pendente of pendentes) {
        if (!pendente.confirmacao || !pendente.auditoria_id) continue;
        const eventos = pendente.confirmacao.eventos ?? [];
        if (eventos.some((e: any) => e.chaveResposta === chaveResposta)) { motivo = 'REPETIDA'; continue; }
        const atualizada = { ...pendente.confirmacao, decisao: motivo === 'CONFIRMADA' ? 'confirmada' : motivo === 'RECUSADA' ? 'recusada' : pendente.confirmacao.decisao,
          eventos: [...eventos, { tipo: 'interpretacao', chaveResposta, ...interpretacao, motivo, em: agora.toISOString() }] };
        await client.query(`update public.noto_auditoria_comprovantes set estado = jsonb_set(estado, '{confirmacaoMedico}', $2::jsonb) where id = $1`, [pendente.auditoria_id, JSON.stringify(atualizada)]);
      }
      if (motivo === 'CONFIRMADA') {
        const liberada = await client.query(`update solicitacoes_nota set aguardando_confirmacao_medico=false, atualizado_em=now()
          where id=$1 and medico_id=$2 and aguardando_confirmacao_medico=true returning id`, [p.id, medicoId]);
        if (liberada.rows.length !== 1) throw Error('CONFIRMACAO_CONCORRENTE');
      }
      await client.query('commit');
      return { liberada: motivo === 'CONFIRMADA', motivo };
    } catch { await client.query('rollback'); return { liberada: false, motivo: 'CONFIRMACAO_INDISPONIVEL' }; }
    finally { client.release(); }
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
    const chave = chaveComprovante(this.pepper, lido);
    const consultaChave = chaveConsulta(this.pepper, medicoId, consulta.fonte, consulta.id_externo);
    const { rows: existentes } = await client.query(`select estado, solicitacao_id from public.noto_emissoes_comprovantes
      where medico_id = $1 and (comprovante_chave = $2 or consulta_chave = $3) for update`,
    [medicoId, chave, consultaChave]);
    if (existentes[0]) return ['bloqueada', 'erro'].includes(existentes[0].estado) ? perguntar('EMISSAO_COMPROVANTE_BLOQUEADA') : { tipo: 'nenhuma' };
    const { rows: ambientes } = await client.query('select ambiente from medico_perfil_fiscal where medico_id = $1 for share', [medicoId]);
    const perfil = await this.emissao.buscarPerfilFiscalMedico(medicoId, client);
    const erro = ambientes[0]?.ambiente !== 'homologacao' ? 'AMBIENTE_NAO_HOMOLOGACAO' : !perfil?.configuracaoCompleta ? 'PERFIL_FISCAL_INCOMPLETO' : null;
    const { rows: reservas } = await client.query(`insert into public.noto_emissoes_comprovantes
      (medico_id, consulta_chave, comprovante_chave, auditoria_comprovante_id, estado, erro_codigo)
      values ($1, $2, $3, $4, $5, $6) returning id`,
    [medicoId, consultaChave, chave, auditoriaId, erro ? 'bloqueada' : 'enfileirada', erro]);
    if (erro || !perfil) return perguntar(erro ?? 'PERFIL_FISCAL_INCOMPLETO');
    const dataConsulta = typeof consulta.data_hora === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(consulta.data_hora) ? `${consulta.data_hora}T12:00:00Z` : consulta.data_hora;
    const datas = new Date(dataConsulta).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const observacao = pronto.pedido.observacao ? `. Pagamento realizado por ${pronto.pedido.observacao.pagador}.` : '';
    const solicitacao = await this.emissao.enfileirarSolicitacao({ ref: `comprovante:${reservas[0].id}`, medicoId, pacienteId,
      valorServicoCentavos: pronto.pedido.valorCentavos, xdescServ: montarDescricaoServico(perfil, datas) + observacao,
      ctribNac: perfil.ctribNacPadrao, cnbs: perfil.cnbs, cclassTrib: perfil.cclassTrib, cindOp: perfil.cindOp,
      datasConsultaTexto: datas, origem: 'whatsapp' }, client);
    // A fila já exclui este campo. Nunca há janela de commit liberada antes da confirmação.
    await client.query('update solicitacoes_nota set aguardando_confirmacao_medico = true where id = $1', [solicitacao.id]);
    await client.query(`update public.noto_auditoria_comprovantes set estado = jsonb_set(estado, '{confirmacaoMedico}', $2::jsonb) where id = $1`,
      [auditoriaId, JSON.stringify({ solicitacaoId: solicitacao.id, paciente: pronto.pedido.paciente.nome,
        dataConsulta: new Date(dataConsulta).toISOString(), dataEnvioPagamento: entrada.dataEnvioPagamento ?? null,
        comprovanteChave: chave, consultaChave, decisao: 'aguardando', eventos: [] })]);
    await client.query(`update public.noto_emissoes_comprovantes set solicitacao_id = $2, atualizado_em = now() where id = $1`, [reservas[0].id, solicitacao.id]);
    return { tipo: 'enfileirada', solicitacaoId: solicitacao.id };
  }
}
