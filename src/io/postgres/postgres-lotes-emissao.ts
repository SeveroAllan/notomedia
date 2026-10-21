import { createHmac } from 'node:crypto';
import type pg from 'pg';
import { chaveConsulta } from '../../atendimento/comprovante.js';
import type { InterpretacaoConfirmacao } from '../../onboarding/confirmacao-emissao-medico.js';
import type { ConsultaLote, ContagemPeriodo, LoteRetroativo, RepositorioLotes } from '../../onboarding/lote-retroativo.js';

const lote = (r: any): LoteRetroativo => ({ id: r.id, medicoId: r.medico_id, conversa: r.conversa,
  desde: r.desde ? String(r.desde).slice(0, 10) : null, ate: new Date(r.ate).toISOString(),
  totalConsultas: Number(r.total_consultas), totalCentavos: Number(r.total_centavos), semValor: Number(r.sem_valor), estado: r.estado,
  mensagemConfirmacaoId: r.mensagem_confirmacao_id, perguntaEm: r.pergunta_em ? new Date(r.pergunta_em).toISOString() : null });
export class PostgresLotesEmissao implements RepositorioLotes {
  private readonly reservas = new Map<string, pg.PoolClient>();
  constructor(private readonly pool: pg.Pool, private readonly pepper: string) {}
  assinatura(medicoId: string, fonte: string, idExterno: string, valor: number) {
    return createHmac('sha256', this.pepper).update(JSON.stringify([medicoId, fonte, idExterno, valor])).digest('hex');
  }
  async abrir(medicoId: string, conversa: string, chave: string, agora: Date) {
    const { rows } = await this.pool.query(`insert into public.noto_lotes_emissao
      (medico_id, conversa, chave_evento, ate, estado) values ($1,$2,$3,$4,'aguardando_data_inicio') on conflict do nothing returning *`, [medicoId, conversa, chave, agora.toISOString()]);
    return rows[0] ? lote(rows[0]) : null;
  }
  async ativo(medicoId: string) {
    const { rows } = await this.pool.query(`select *, desde::text as desde from public.noto_lotes_emissao where medico_id=$1
      and estado in ('aguardando_data_inicio','aguardando_confirmacao_lote','confirmado','processando')`, [medicoId]);
    return rows.length === 1 ? lote(rows[0]) : null;
  }
  async contarConsultasPeriodo(medicoId: string, desde: string, ate: string, valoresAoVivo: ReadonlyMap<string, number | null>): Promise<ContagemPeriodo> {
    if (!valoresAoVivo) throw Error('LEITURA_AO_VIVO_NECESSARIA');
    const { rows } = await this.pool.query<{ fonte: string; id_externo: string }>(`select fonte, id_externo
      from public.noto_consultas_sincronizadas where medico_id=$1 and fonte='tribemd' and status='realizada'
      and data_hora >= ($2::date::timestamp at time zone 'America/Sao_Paulo') and data_hora <= $3::timestamptz order by data_hora, id_externo`, [medicoId, desde, ate]);
    const consultas: ConsultaLote[] = []; let totalCentavos = 0, totalConsultas = 0, semValor = 0;
    for (const r of rows) {
      if (!valoresAoVivo.has(r.id_externo)) continue;
      const chave = chaveConsulta(this.pepper, medicoId, r.fonte, r.id_externo);
      const { rows: emitidas } = await this.pool.query(`select 1 from public.noto_emissoes_comprovantes where medico_id=$1 and consulta_chave=$2 and estado='nota_gerada'`, [medicoId, chave]);
      if (emitidas.length) continue;
      const valor = valoresAoVivo.get(r.id_externo) ?? null;
      const temValor = Number.isSafeInteger(valor) && valor! > 0;
      if (temValor) { totalConsultas++; totalCentavos += valor!; } else semValor++;
      if (!Number.isSafeInteger(totalCentavos)) throw Error('TOTAL_LOTE_INVALIDO');
      consultas.push({ fonte: r.fonte, idExterno: r.id_externo, chave, assinatura: temValor ? this.assinatura(medicoId, r.fonte, r.id_externo, valor!) : null });
    }
    return { consultas, totalConsultas, totalCentavos, semValor };
  }
  async preparar(id: string, desde: string, contagem: ContagemPeriodo) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(`update public.noto_lotes_emissao set desde=$2, total_consultas=$3, total_centavos=$4, sem_valor=$5,
        estado=$6 where id=$1 and estado='aguardando_data_inicio' returning *, desde::text as desde`, [id, desde, contagem.totalConsultas, contagem.totalCentavos, contagem.semValor, contagem.totalConsultas ? 'aguardando_confirmacao_lote' : 'recusado']);
      if (!rows[0]) throw Error('LOTE_ESTADO_DIVERGENTE');
      for (const c of contagem.consultas) await client.query(`insert into public.noto_lotes_itens
        (lote_id, medico_id, fonte, id_externo, consulta_chave, assinatura, estado) values ($1,$2,$3,$4,$5,$6,$7)`,
        [id, rows[0].medico_id, c.fonte, c.idExterno, c.chave, c.assinatura, c.assinatura ? 'pronto' : 'sem_valor']);
      await client.query('commit'); return lote(rows[0]);
    } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
  }
  async registrarPergunta(id: string, mensagemId: string, agora: Date) {
    await this.pool.query(`update public.noto_lotes_emissao set mensagem_confirmacao_id=$2, pergunta_em=$3
      where id=$1 and estado='aguardando_confirmacao_lote' and mensagem_confirmacao_id is null`, [id, mensagemId, agora.toISOString()]);
  }
  async confirmar(id: string, mensagemId: string, perguntaId: string, i: InterpretacaoConfirmacao, agora: Date) {
    if (!Number.isFinite(i.confianca) || i.confianca < .9 || i.confianca > 1 || !['sim','nao'].includes(i.intencao)) return false;
    const { rows } = await this.pool.query(`update public.noto_lotes_emissao set estado=$5, confirmado_em=$4, resposta_confirmacao_id=$2
      where id=$1 and estado='aguardando_confirmacao_lote' and mensagem_confirmacao_id=$3 and pergunta_em<=$4
      and pergunta_em > $4::timestamptz - interval '48 hours' returning id`, [id, mensagemId, perguntaId, agora.toISOString(), i.intencao === 'sim' ? 'confirmado' : 'recusado']);
    return rows.length === 1 && i.intencao === 'sim';
  }
  async reservar() {
    const client = await this.pool.connect();
    let id: string | undefined, reservada = false, mantida = false;
    try {
      await client.query('begin');
      const { rows } = await client.query(`select l.* from public.noto_lotes_emissao l join medico_perfil_fiscal pf on pf.medico_id=l.medico_id
        where (l.estado='confirmado' or (l.estado='processando' and l.confirmado_em < now() - interval '5 minutes'))
        and pf.ambiente='homologacao' order by (l.estado='confirmado') desc, l.confirmado_em limit 1 for update of l skip locked`);
      if (!rows[0]) { await client.query('commit'); return null; }
      id = rows[0].id;
      // A sessão conserva a trava durante todo o lote: idade não autoriza roubar um worker vivo.
      const { rows: trava } = await client.query(`select pg_try_advisory_lock(hashtextextended('lote-retroativo:' || $1, 0)) as reservada`, [id]);
      reservada = trava[0]?.reservada === true;
      if (!reservada) { await client.query('commit'); return null; }
      if (rows[0].estado === 'processando') {
        await client.query(`update public.noto_lotes_emissao set estado='confirmado' where id=$1 and estado='processando'`, [id]);
        await client.query(`update public.noto_lotes_itens set estado='pronto' where lote_id=$1 and estado='processando'`, [id]);
      }
      await client.query(`update public.noto_lotes_emissao set estado='processando' where id=$1 and estado='confirmado'`, [id]);
      const { rows: itens } = await client.query(`select i.id, i.fonte, i.id_externo, i.consulta_chave, i.assinatura,
        case when e.estado='nota_gerada' then 'emitida' else i.estado end as estado,
        exists (select 1 from public.noto_envios_homologacao v where v.medico_id=i.medico_id
          and v.acao='nota_paciente' and v.chave=e.nota_fiscal_id::text and v.estado='enviado') as entregue,
        (e.estado='nota_gerada' and s.contato_paciente_encriptado is null) as sem_contato
        from public.noto_lotes_itens i left join public.noto_emissoes_comprovantes e on e.lote_item_id=i.id
        left join public.solicitacoes_nota s on s.id=e.solicitacao_id where i.lote_id=$1 order by i.id`, [id]);
      await client.query('commit');
      this.reservas.set(id!, client); mantida = true;
      return { ...lote(rows[0]), itens: itens.map(r => ({ id: r.id, fonte: r.fonte, idExterno: r.id_externo, chave: r.consulta_chave,
        assinatura: r.assinatura, estado: r.estado, entregue: r.entregue, semContato: r.sem_contato })) };
    } catch (e) { await client.query('rollback'); throw e; }
    finally {
      if (!mantida) {
        try { if (reservada) await client.query(`select pg_advisory_unlock(hashtextextended('lote-retroativo:' || $1, 0))`, [id]); }
        finally { client.release(reservada); }
      }
    }
  }
  async liberarReserva(id: string) {
    const client = this.reservas.get(id);
    if (!client) return;
    this.reservas.delete(id);
    try { await client.query(`select pg_advisory_unlock(hashtextextended('lote-retroativo:' || $1, 0))`, [id]); }
    finally { client.release(true); }
  }
  async reservarItem(id: string) {
    try {
      const { rows } = await this.pool.query(`update public.noto_lotes_itens set estado='processando' where id=$1 and estado='pronto' returning id`, [id]);
      return rows.length === 1;
    } catch (e: any) { if (e.code === '23505') return false; throw e; }
  }
  async concluirItem(id: string, estado: string) {
    await this.pool.query(`update public.noto_lotes_itens set estado=$2 where id=$1 and estado in ('pronto','processando','sem_valor')`, [id, estado]);
  }
  async finalizar(id: string, bloqueado = false) {
    await this.pool.query(`update public.noto_lotes_emissao set estado=$2 where id=$1 and estado='processando'`, [id, bloqueado ? 'bloqueado' : 'concluido']);
  }
}
