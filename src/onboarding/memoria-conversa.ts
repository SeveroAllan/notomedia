import type pg from 'pg';
import { sanitizarTextoMedico } from './contexto-conversa-medico.js';
import { LIMITE_MENSAGENS_CONTEXTO_MEDICO } from './regras/decidir-proxima-acao.js';

/**
 * Memória persistida por médico e conversa; histórico mantém os quatro textos recentes em ordem cronológica.
 * Falas são sanitizadas; boas-vindas e balões de agenda seguem o alcance legado entre conversas.
 * Marcas contexto:* são estado estruturado e nunca entram como fala no histórico.
 * Exceção legada preservada: a marca noto:cofre_agenda:solicitado também integra a leitura textual.
 * Resumo é sanitizado, avança por ateId e não é invalidado automaticamente por novas falas.
 * limparTudoDoMedico invalida resumo, falas e marcas de todas as conversas em uma instrução atômica.
 * Leituras granulares permanecem disponíveis para preservar ordem e momento das consultas existentes.
 */
export interface MemoriaConversa {
  ler(medicoId: string, conversa: string): string[] | Promise<string[]>;
  registrar(medicoId: string, conversa: string, id: string, texto: string, papel?: 'medico' | 'noto'): void | boolean | Promise<void | boolean>;
}
export type ResumoConversa = { resumo: string; ateId: string };

export class PostgresMemoriaConversaMedico implements MemoriaConversa {
  constructor(private readonly pool: pg.Pool) {}

  async lerContextoParaModelo(medicoId: string, conversa: string) {
    const historicoRecente = await this.ler(medicoId, conversa);
    const marcas = {
      semAgendaDigital: await this.semAgendaDigital(medicoId, conversa),
      linkAgendaSolicitado: await this.temPedidoCofre(medicoId, conversa),
      boasVindasComunicadas: await this.temBoasVindas(medicoId, conversa),
    };
    const resumo = await this.lerResumo(medicoId, conversa);
    return { historicoRecente, marcas, resumo };
  }

  registrarFala(medicoId: string, conversa: string, id: string, texto: string, papel: 'medico' | 'noto' = 'medico'): Promise<boolean> {
    return this.registrar(medicoId, conversa, id, texto, papel);
  }

  async registrarMarca(medicoId: string, conversa: string, marca: 'sem_agenda_digital' | 'link_agenda_solicitado'): Promise<void> {
    if (marca === 'sem_agenda_digital') return this.registrarSemAgendaDigital(medicoId, conversa);
    await this.registrar(medicoId, conversa, 'noto:cofre_agenda:solicitado',
      'O link seguro já foi solicitado nesta conversa; aguardo a conexão. Isso não confirma envio.', 'noto');
  }

  registrarResumo(medicoId: string, conversa: string, resumo: string, ateId: string): Promise<void> {
    return this.gravarResumo(medicoId, conversa, resumo, ateId);
  }

  async limparTudoDoMedico(medicoId: string): Promise<void> {
    await this.pool.query(`with mensagens_removidas as (
      delete from conversa_mensagens where medico_id=$1 returning medico_id
    ) delete from conversa_resumos where medico_id=$1`, [medicoId]);
  }

  async ler(medicoId: string, conversa: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ texto: string }>(
      "select texto from conversa_mensagens where medico_id=$1 and (conversa=$2 or papel='noto' and (mensagem_id='noto:boas_vindas:unica' or mensagem_id like 'noto:agenda:%')) and mensagem_id not like 'contexto:%' order by id desc limit $3",
      [medicoId, conversa, LIMITE_MENSAGENS_CONTEXTO_MEDICO]);
    return rows.reverse().map(mensagem => sanitizarTextoMedico(mensagem.texto));
  }

  async lerFalasRecentes(medicoId: string, conversa: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ texto: string }>(
      "select texto from conversa_mensagens where medico_id=$1 and conversa=$2 and papel='noto' and mensagem_id not like 'contexto:%' and criada_em > now() - interval '10 minutes' order by id desc", [medicoId, conversa]);
    return rows.map(m => sanitizarTextoMedico(m.texto));
  }

  async lerUltimaFalaNoto(medicoId: string, conversa: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ texto: string }>(
      "select texto from conversa_mensagens where medico_id=$1 and (conversa=$2 or mensagem_id='noto:boas_vindas:unica' or mensagem_id like 'noto:agenda:%') and papel='noto' and mensagem_id not like 'contexto:%' order by id desc limit 1", [medicoId, conversa]);
    return rows[0] ? sanitizarTextoMedico(rows[0].texto) : undefined;
  }

  async lerUltimasFalasNoto(medicoId: string, conversa: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ texto: string }>(
      "select texto from conversa_mensagens where medico_id=$1 and (conversa=$2 or mensagem_id='noto:boas_vindas:unica' or mensagem_id like 'noto:agenda:%') and papel='noto' and mensagem_id not like 'contexto:%' order by id desc limit 6", [medicoId, conversa]);
    return rows.flatMap(m => sanitizarTextoMedico(m.texto).split('\n')).slice(0, 6);
  }

  async registrar(medicoId: string, conversa: string, id: string, texto: string, papel: 'medico' | 'noto' = 'medico'): Promise<boolean> {
    const { rows } = await this.pool.query(
      'insert into conversa_mensagens (medico_id, conversa, mensagem_id, texto, papel) values ($1,$2,$3,$4,$5) on conflict do nothing returning id',
      [medicoId, conversa, id, sanitizarTextoMedico(texto), papel]);
    return rows.length === 1;
  }

  async temResposta(medicoId: string, conversa: string, chave: string): Promise<boolean> {
    const { rows } = await this.pool.query('select 1 from conversa_mensagens where medico_id=$1 and mensagem_id=$3 and $2::text is not null limit 1',
      [medicoId, conversa, `noto:${chave}`]);
    return rows.length > 0;
  }

  async temPedidoCofre(medicoId: string, conversa: string): Promise<boolean> {
    const { rows } = await this.pool.query('select 1 from conversa_mensagens where medico_id=$1 and mensagem_id=$3 and $2::text is not null limit 1',
      [medicoId, conversa, 'noto:cofre_agenda:solicitado']);
    return rows.length > 0;
  }

  async registrarSemAgendaDigital(medicoId: string, conversa: string): Promise<void> {
    // Marca de contexto, nunca uma fala. O upsert também corrige a marca legada no próximo reconhecimento.
    await this.pool.query(`insert into conversa_mensagens (medico_id, conversa, mensagem_id, texto, papel) values ($1,$2,$3,$4,$5)
      on conflict (medico_id, mensagem_id) do update set texto=excluded.texto, papel=excluded.papel`,
      [medicoId, conversa, 'contexto:sem_agenda_digital', JSON.stringify({ semAgendaDigital: true }), 'noto']);
  }

  async semAgendaDigital(medicoId: string, conversa: string): Promise<boolean> {
    const { rows } = await this.pool.query('select 1 from conversa_mensagens where medico_id=$1 and mensagem_id=$3 and $2::text is not null limit 1',
      [medicoId, conversa, 'contexto:sem_agenda_digital']);
    return rows.length > 0;
  }

  async temBoasVindas(medicoId: string, conversa: string): Promise<boolean> {
    const { rows } = await this.pool.query('select 1 from conversa_mensagens where medico_id=$1 and mensagem_id=$3 and $2::text is not null limit 1',
      [medicoId, conversa, 'noto:boas_vindas:unica']);
    return rows.length > 0;
  }

  async lerResumo(medicoId: string, conversa: string): Promise<ResumoConversa | null> {
    const { rows } = await this.pool.query<{ resumo: string; ate_id: string }>(
      'select resumo, ate_id::text from conversa_resumos where medico_id=$1 and conversa=$2', [medicoId, conversa]);
    return rows[0] ? { resumo: sanitizarTextoMedico(rows[0].resumo), ateId: rows[0].ate_id } : null;
  }

  async lerAntigas(medicoId: string, conversa: string, ateId: string): Promise<Array<{ id: string; texto: string }>> {
    const { rows } = await this.pool.query<{ id: string; texto: string }>(
      `select id::text, texto from (select id, texto from conversa_mensagens where medico_id=$1 and conversa=$2 and mensagem_id not like 'contexto:%'
        order by id desc offset $4) antigas where id > $3::bigint order by antigas.id asc`,
      [medicoId, conversa, ateId, LIMITE_MENSAGENS_CONTEXTO_MEDICO]);
    return rows.map(mensagem => ({ ...mensagem, texto: sanitizarTextoMedico(mensagem.texto) }));
  }

  async gravarResumo(medicoId: string, conversa: string, resumo: string, ateId: string): Promise<void> {
    await this.pool.query(
      `insert into conversa_resumos (medico_id, conversa, resumo, ate_id) values ($1,$2,$3,$4)
        on conflict (medico_id, conversa) do update set resumo=excluded.resumo, ate_id=excluded.ate_id, atualizado_em=now()
        where conversa_resumos.ate_id < excluded.ate_id`,
      [medicoId, conversa, sanitizarTextoMedico(resumo), ateId]);
  }
}
