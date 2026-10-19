import { config } from '../../config.js';
import type { ResultadoFonteAgenda } from '../../agenda/fonte-agenda.js';
import type pg from 'pg';
import { HistoricoComunicacaoEmMemoria, type HistoricoComunicacaoRepositorio, type EntradaMedico,
  type HistoricoComunicacao, type ModoComunicacao } from '../../onboarding/historico-comunicacao-repositorio.js';
import { auditarComprovante, chaveComprovante, decidirPedidoComprovante, type AuditoriaComprovante, type EstadoPedidoComprovante,
  type ResultadoExtracaoComprovante } from '../../atendimento/comprovante.js';
import type { ProximaAcaoNoto } from '../../onboarding/regras/decidir-proxima-acao.js';

type Linha = Record<string, any>;
export class PostgresHistoricoComunicacao implements HistoricoComunicacaoRepositorio {
  constructor(private readonly pool: pg.Pool, private readonly pepper = config.appPepper) {}

  ler(medico: string, modo: ModoComunicacao) { return this.executar(medico, modo, h => h.ler(medico, modo)); }
  reservar(medico: string, modo: ModoComunicacao, chave: string) { return this.executar(medico, modo, h => h.reservar(medico, modo, chave), chave); }
  liberar(medico: string, modo: ModoComunicacao, chave: string) { return this.executar(medico, modo, h => h.liberar(medico, modo, chave), chave); }
  gravarAcao(medico: string, modo: ModoComunicacao, chave: string, acao: ProximaAcaoNoto, quando: string) {
    return this.executar(medico, modo, h => h.gravarAcao(medico, modo, chave, acao, quando), chave, acao);
  }
  gravarResposta(...args: Parameters<HistoricoComunicacaoRepositorio['gravarResposta']>) {
    return this.executar(args[0], args[1], h => h.gravarResposta(...args));
  }
  reservarEnvio(medico: string, chave: string, acao: ProximaAcaoNoto) {
    return this.executar(medico, 'real', h => h.reservarEnvio(medico, chave, acao), chave, acao);
  }
  confirmarBalao(medico: string, chave: string, indice: number) {
    return this.executar(medico, 'real', h => h.confirmarBalao(medico, chave, indice), chave);
  }

  async lerComprovantes(medico: string): Promise<AuditoriaComprovante[]> {
    return this.transacao(client => this.lerAuditoriaComprovantes(client, medico));
  }
  async registrarComprovante(estado: EstadoPedidoComprovante, lido: ResultadoExtracaoComprovante | null, agenda?: ResultadoFonteAgenda) {
    return this.transacao(async client => {
      // Serializa a leitura/deduplicação/gravação por médico inclusive entre processos.
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [estado.medicoId]);
      const anteriores = await this.lerAuditoriaComprovantes(client, estado.medicoId);
      const decisao = decidirPedidoComprovante(lido, estado, anteriores.some(r => r.lido?.tipo === 'extraido' && r.lido.campos.comprovanteHash === chaveComprovante(this.pepper, lido)) ? [lido] : [], agenda);
      const auditoria = auditarComprovante(this.pepper, estado, lido, decisao);
      await client.query('insert into public.noto_auditoria_comprovantes (medico_id, lido, estado, decisao) values ($1, $2::jsonb, $3::jsonb, $4::jsonb)',
        [estado.medicoId, auditoria.lido === null ? null : JSON.stringify(auditoria.lido), JSON.stringify(auditoria.estado), JSON.stringify(auditoria.decisao)]);
      return decisao;
    });
  }

  private async transacao<T>(operacao: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin'); const resultado = await operacao(client); await client.query('commit'); return resultado;
    } catch (erro) { await client.query('rollback').catch(() => {}); throw erro; }
    finally { client.release(); }
  }
  private async lerAuditoriaComprovantes(client: pg.PoolClient, medico: string): Promise<AuditoriaComprovante[]> {
    const { rows } = await client.query('select lido, estado, decisao from public.noto_auditoria_comprovantes where medico_id=$1 order by criado_em, id', [medico]);
    return rows;
  }

  private async executar<T>(medico: string, modo: ModoComunicacao, operacao: (h: HistoricoComunicacaoEmMemoria) => Promise<T>, chave?: string, acao?: ProximaAcaoNoto): Promise<T> {
    return this.transacao(async client => {
      await client.query('insert into public.noto_historico_comunicacao_medico (medico_id, modo) values ($1, $2) on conflict do nothing', [medico, modo]);
      const { rows: estados } = await client.query('select * from public.noto_historico_comunicacao_medico where medico_id=$1 and modo=$2 for update', [medico, modo]);
      if (!estados[0]) throw new Error('HISTORICO_AUSENTE');
      const { rows: tentativas } = await client.query('select * from public.noto_comunicacao_tentativas where medico_id=$1 and modo=$2 order by criado_em, chave_processamento', [medico, modo]);
      const { rows: envios } = modo === 'real' ? await client.query('select chave_processamento, tipo, baloes_enviados from public.noto_comunicacao_envios where medico_id=$1 and modo=$2 order by criado_em, chave_processamento', [medico, modo]) : { rows: [] };
      const { rows: reservas } = await client.query('select chave_processamento from public.noto_comunicacao_reservas where medico_id=$1 and modo=$2', [medico, modo]);
      const historico = this.montarHistorico(estados[0], tentativas, envios.map(envio => ({ chaveProcessamento: envio.chave_processamento, tipo: envio.tipo, baloesEnviados: envio.baloes_enviados })));
      const entrada: EntradaMedico = { historico, processamentos: new Set(tentativas.map(t => t.chave_processamento)),
        reserva: reservas[0] ? reservas[0].chave_processamento : tentativas.find(t => t.estado === 'reservado')?.chave_processamento ?? null };
      const antes = JSON.stringify(historico);
      const enviosAntes = JSON.stringify(historico.envios);
      const reservaAntes = entrada.reserva;
      const memoria = new HistoricoComunicacaoEmMemoria(new Map([[JSON.stringify([medico, modo]), entrada]]));
      const resultado = await operacao(memoria);
      if (antes !== JSON.stringify(entrada.historico)) await this.salvarHistorico(client, medico, modo, entrada.historico);
      if (chave && entrada.processamentos.has(chave)) await this.salvarTentativa(client, medico, modo, chave, entrada, tentativas, acao);
      // A ação concluída e a reserva ainda ativa são estados distintos na interface existente.
      if (reservaAntes !== entrada.reserva || (!reservas[0] && entrada.reserva !== null)) {
        await client.query(`insert into public.noto_comunicacao_reservas (medico_id, modo, chave_processamento) values ($1, $2, $3)
          on conflict (medico_id, modo) do update set chave_processamento=excluded.chave_processamento`, [medico, modo, entrada.reserva]);
      }
      if (enviosAntes !== JSON.stringify(entrada.historico.envios)) {
        await this.salvarEnvios(client, medico, entrada.historico.envios);
      }
      return resultado;
    });
  }

  private async salvarEnvios(client: pg.PoolClient, medico: string, envios: HistoricoComunicacao['envios']) {
    const registros = envios.map(envio => ({ chave_processamento: envio.chaveProcessamento, tipo: envio.tipo, baloes_enviados: envio.baloesEnviados }));
    await client.query(`insert into public.noto_comunicacao_envios (medico_id, modo, chave_processamento, tipo, baloes_enviados)
      select $1, 'real', envio.chave_processamento, envio.tipo, envio.baloes_enviados
      from jsonb_to_recordset($2::jsonb) as envio(chave_processamento text, tipo text, baloes_enviados integer[])
      on conflict (medico_id, modo, chave_processamento) do update set baloes_enviados=excluded.baloes_enviados`, [medico, JSON.stringify(registros)]);
  }

  private montarHistorico(linha: Linha, tentativas: Linha[], envios: HistoricoComunicacao['envios']): HistoricoComunicacao {
    const data = (valor: string | Date | null) => valor === null ? null : new Date(valor).toISOString();
    return {
      boasVindasComunicadas: linha.boas_vindas_em !== null, boasVindasEm: data(linha.boas_vindas_em),
      respostaRecebidaEm: data(linha.resposta_recebida_em), problemaFiscalComunicado: linha.problema_fiscal_em !== null,
      problemaFiscal: { feitaEm: data(linha.problema_fiscal_em), repeticoes: linha.problema_fiscal_repeticoes },
      perguntaNota: { feitaEm: data(linha.pergunta_nota_em), repeticoes: linha.pergunta_nota_repeticoes, resposta: linha.resposta_nota },
      perguntaAgenda: { feitaEm: data(linha.pergunta_agenda_em), repeticoes: linha.pergunta_agenda_repeticoes },
      agendasNaoAtendidasComunicadas: linha.agendas_nao_atendidas, consultasListadas: linha.consultas_listadas,
      aguardandoComprovanteComunicado: linha.aguardando_comprovante, envios,
      registros: tentativas.filter(t => t.estado === 'simulado' || t.estado === 'enviado').map(t => ({ modo: linha.modo,
        chaveProcessamento: t.chave_processamento, tipo: t.acao, quando: data(t.atualizado_em)!,
        ...(t.estado === 'enviado' ? { estado: 'enviado' as const } : {}), ...(t.pergunta ? { pergunta: t.pergunta } : {}) }))
    };
  }

  private async salvarHistorico(client: pg.PoolClient, medico: string, modo: ModoComunicacao, h: HistoricoComunicacao) {
    const linha = { boas_vindas_em: h.boasVindasEm, resposta_recebida_em: h.respostaRecebidaEm, resposta_nota: h.perguntaNota.resposta,
      pergunta_nota_em: h.perguntaNota.feitaEm, pergunta_nota_repeticoes: h.perguntaNota.repeticoes,
      pergunta_agenda_em: h.perguntaAgenda.feitaEm, pergunta_agenda_repeticoes: h.perguntaAgenda.repeticoes,
      problema_fiscal_em: h.problemaFiscal.feitaEm, problema_fiscal_repeticoes: h.problemaFiscal.repeticoes,
      agendas_nao_atendidas: h.agendasNaoAtendidasComunicadas, consultas_listadas: h.consultasListadas, aguardando_comprovante: h.aguardandoComprovanteComunicado };
    await client.query(`update public.noto_historico_comunicacao_medico h set
      boas_vindas_em=x.boas_vindas_em, resposta_recebida_em=x.resposta_recebida_em, resposta_nota=x.resposta_nota,
      pergunta_nota_em=x.pergunta_nota_em, pergunta_nota_repeticoes=x.pergunta_nota_repeticoes,
      pergunta_agenda_em=x.pergunta_agenda_em, pergunta_agenda_repeticoes=x.pergunta_agenda_repeticoes,
      problema_fiscal_em=x.problema_fiscal_em, problema_fiscal_repeticoes=x.problema_fiscal_repeticoes,
      agendas_nao_atendidas=x.agendas_nao_atendidas, consultas_listadas=x.consultas_listadas, aguardando_comprovante=x.aguardando_comprovante, atualizado_em=now()
      from jsonb_populate_record(null::public.noto_historico_comunicacao_medico, $3::jsonb) x
      where h.medico_id=$1 and h.modo=$2`, [medico, modo, JSON.stringify(linha)]);
  }
  private async salvarTentativa(client: pg.PoolClient, medico: string, modo: ModoComunicacao, chave: string, entrada: EntradaMedico, anteriores: Linha[], acao?: ProximaAcaoNoto) {
    const registro = entrada.historico.registros.find(r => r.chaveProcessamento === chave);
    const envio = entrada.historico.envios.find(e => e.chaveProcessamento === chave);
    const anterior = anteriores.find(t => t.chave_processamento === chave);
    const tentativa = { chave_processamento: chave, estado: registro ? (modo === 'real' ? 'enviado' : 'simulado') : entrada.reserva === chave ? 'reservado' : 'nenhuma',
      acao: registro?.tipo ?? envio?.tipo ?? null, pergunta: registro?.pergunta ?? null,
      agenda: anterior?.agenda ?? (acao?.tipo === 'agenda_nao_atendida' ? acao.agenda : null), atualizado_em: registro?.quando ?? anterior?.atualizado_em ?? null };
    await client.query(`insert into public.noto_comunicacao_tentativas (medico_id, modo, chave_processamento, estado, acao, pergunta, agenda, atualizado_em)
      select $1, $2, t.chave_processamento, t.estado, t.acao, t.pergunta, t.agenda, coalesce(t.atualizado_em, now())
      from jsonb_populate_record(null::public.noto_comunicacao_tentativas, $3::jsonb) t
      on conflict (medico_id, modo, chave_processamento) do update set estado=excluded.estado,
      acao=excluded.acao, pergunta=excluded.pergunta, agenda=excluded.agenda, atualizado_em=excluded.atualizado_em`, [medico, modo, JSON.stringify(tentativa)]);
  }
}
