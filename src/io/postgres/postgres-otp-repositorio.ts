import type { OtpEmailRepositorio, DadosOtpEmail, RegistroOtpEmail } from '../../otp/login-otp-email.js';
/**
 * Implementação PostgreSQL da porta `OtpRepositorio`.
 * Executa queries 100% parametrizadas na tabela `otp_verificacoes`,
 * garantindo atomicidade e persistência segura no banco do Supabase na VPS.
 */

import type pg from 'pg';
import type {
  OtpRepositorio,
  OtpRegistro,
  CriarOtpParams
} from '../../otp/otp-repositorio.js';

export class PostgresOtpRepositorio implements OtpRepositorio {
  constructor(private readonly pool: pg.Pool) {}

  async salvar(params: CriarOtpParams): Promise<OtpRegistro> {
    const sql = `
      insert into otp_verificacoes (telefone, codigo_hash, expira_em, criado_em)
      values ($1, $2, $3, coalesce($4, now()))
      returning id, telefone, codigo_hash, tentativas, expira_em, verificado_em, criado_em
    `;
    const values = [params.telefone, params.codigoHash, params.expiraEm, params.criadoEm];
    const { rows } = await this.pool.query(sql, values);
    const row = rows[0];

    return {
      id: row.id,
      telefone: row.telefone,
      codigoHash: row.codigo_hash,
      tentativas: row.tentativas,
      expiraEm: new Date(row.expira_em),
      verificadoEm: row.verificado_em ? new Date(row.verificado_em) : null,
      criadoEm: new Date(row.criado_em)
    };
  }

  async buscarUltimoPorTelefone(telefone: string): Promise<OtpRegistro | null> {
    const sql = `
      select id, telefone, codigo_hash, tentativas, expira_em, verificado_em, criado_em
      from otp_verificacoes
      where telefone = $1
      order by criado_em desc
      limit 1
    `;
    const { rows } = await this.pool.query(sql, [telefone]);
    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id,
      telefone: row.telefone,
      codigoHash: row.codigo_hash,
      tentativas: row.tentativas,
      expiraEm: new Date(row.expira_em),
      verificadoEm: row.verificado_em ? new Date(row.verificado_em) : null,
      criadoEm: new Date(row.criado_em)
    };
  }

  async incrementarTentativas(id: string): Promise<void> {
    const sql = `
      update otp_verificacoes
      set tentativas = tentativas + 1
      where id = $1
    `;
    await this.pool.query(sql, [id]);
  }

  async marcarVerificado(id: string, verificadoEm: Date = new Date()): Promise<void> {
    const sql = `
      update otp_verificacoes
      set verificado_em = $2
      where id = $1
    `;
    await this.pool.query(sql, [id, verificadoEm]);
  }
}

/** Canal de teste separado: toda chave persistida é HMAC, nunca o e-mail. */
export class PostgresOtpEmailRepositorio implements OtpEmailRepositorio {
  constructor(private readonly pool: pg.Pool) {}

  async comBloqueio<T>(emailHash: string, operacao: (dados: DadosOtpEmail) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`login_otp_email:${emailHash}`]);
      const resultado = await operacao(this.dados(client, emailHash));
      await client.query('commit');
      return resultado;
    } catch (erro) { await client.query('rollback').catch(() => {}); throw erro; }
    finally { client.release(); }
  }

  private dados(client: pg.PoolClient, emailHash: string): DadosOtpEmail {
    return {
      buscarUltimo: async () => {
        const { rows } = await client.query(`select id, auth_user_id, codigo_hash, tentativas, expira_em, verificado_em, criado_em, envio_confirmado
          from public.login_otp_email where email_hash = $1 order by criado_em desc, id desc limit 1 for update`, [emailHash]);
        return rows[0] ? this.registro(rows[0]) : null;
      },
      salvar: async entrada => {
        const { rows } = await client.query(`insert into public.login_otp_email (email_hash, auth_user_id, codigo_hash, expira_em, criado_em)
          values ($1, $2, $3, $4, $5) returning id, auth_user_id, codigo_hash, tentativas, expira_em, verificado_em, criado_em, envio_confirmado`,
          [emailHash, entrada.authUserId, entrada.codigoHash, entrada.expiraEm, entrada.criadoEm]);
        return this.registro(rows[0]);
      },
      confirmarEnvio: async id => { await client.query('update public.login_otp_email set envio_confirmado = true where id = $1', [id]); },
      incrementarTentativas: async id => { await client.query('update public.login_otp_email set tentativas = tentativas + 1 where id = $1', [id]); },
      marcarVerificado: async (id, quando) => { await client.query('update public.login_otp_email set verificado_em = $2 where id = $1', [id, quando]); },
      auditar: async (evento, quando) => {
        await client.query('insert into public.login_otp_email_auditoria (email_hash, evento, criado_em) values ($1, $2, $3)', [emailHash, evento, quando]);
      }
    };
  }

  private registro(row: Record<string, any>): RegistroOtpEmail {
    return { id: row.id, authUserId: row.auth_user_id, codigoHash: row.codigo_hash,
      tentativas: row.tentativas, expiraEm: new Date(row.expira_em), criadoEm: new Date(row.criado_em),
      verificadoEm: row.verificado_em ? new Date(row.verificado_em) : null, envioConfirmado: row.envio_confirmado };
  }
}
