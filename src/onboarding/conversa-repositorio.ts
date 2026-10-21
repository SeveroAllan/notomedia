import type pg from 'pg';
import { sanitizarTextoMedico } from './contexto-conversa-medico.js';
import { LIMITE_MENSAGENS_CONTEXTO_MEDICO } from './regras/decidir-proxima-acao.js';

export interface MemoriaConversa {
  ler(medicoId: string, conversa: string): string[] | Promise<string[]>;
  registrar(medicoId: string, conversa: string, id: string, texto: string, papel?: 'medico' | 'noto'): void | Promise<void>;
}
export type ResumoConversa = { resumo: string; ateId: string };

export class PostgresMemoriaConversaMedico implements MemoriaConversa {
  constructor(private readonly pool: pg.Pool) {}

  async ler(medicoId: string, conversa: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ texto: string }>(
      'select texto from conversa_mensagens where medico_id=$1 and conversa=$2 order by id desc limit $3',
      [medicoId, conversa, LIMITE_MENSAGENS_CONTEXTO_MEDICO]);
    return rows.reverse().map(mensagem => sanitizarTextoMedico(mensagem.texto));
  }

  async lerUltimaFalaNoto(medicoId: string, conversa: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ texto: string }>(
      "select texto from conversa_mensagens where medico_id=$1 and conversa=$2 and papel='noto' order by id desc limit 1", [medicoId, conversa]);
    return rows[0] ? sanitizarTextoMedico(rows[0].texto) : undefined;
  }

  async registrar(medicoId: string, conversa: string, id: string, texto: string, papel: 'medico' | 'noto' = 'medico'): Promise<void> {
    await this.pool.query(
      'insert into conversa_mensagens (medico_id, conversa, mensagem_id, texto, papel) values ($1,$2,$3,$4,$5) on conflict (medico_id, conversa, mensagem_id) do nothing',
      [medicoId, conversa, id, sanitizarTextoMedico(texto), papel]);
  }

  async temResposta(medicoId: string, conversa: string, chave: string): Promise<boolean> {
    const { rows } = await this.pool.query('select 1 from conversa_mensagens where medico_id=$1 and conversa=$2 and mensagem_id=$3 limit 1',
      [medicoId, conversa, `noto:${chave}`]);
    return rows.length > 0;
  }

  async temPedidoCofre(medicoId: string, conversa: string): Promise<boolean> {
    const { rows } = await this.pool.query('select 1 from conversa_mensagens where medico_id=$1 and conversa=$2 and mensagem_id=$3 limit 1',
      [medicoId, conversa, 'noto:cofre_agenda:solicitado']);
    return rows.length > 0;
  }

  async temBoasVindas(medicoId: string, conversa: string): Promise<boolean> {
    const { rows } = await this.pool.query('select 1 from conversa_mensagens where medico_id=$1 and conversa=$2 and mensagem_id=$3 limit 1',
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
      `select id::text, texto from (select id, texto from conversa_mensagens where medico_id=$1 and conversa=$2
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
