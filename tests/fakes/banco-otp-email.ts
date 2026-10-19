import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/** Modelo apenas das queries do OTP de e-mail; bloqueio ocorre na chamada advisory. */
export class BancoOtpEmailFalso {
  registros: Array<Record<string, any>> = [];
  auditoria: Array<Record<string, any>> = [];
  comandos: Array<{ sql: string; parametros: any[] }> = [];
  falhar: RegExp | null = null;
  private fila = Promise.resolve();
  pool = { connect: () => this.connect(), query: async () => { throw Error('SQL_FORA_DO_OTP_EMAIL'); } } as unknown as pg.Pool;
  async connect() {
    let liberar: (() => void) | undefined, snapshot: any, bloqueado = false;
    return { release: () => liberar?.(), query: async (texto: string, parametros: any[] = []) => {
      const sql = texto.replace(/\s+/g, ' ').trim().toLowerCase();
      this.comandos.push({ sql, parametros: structuredClone(parametros) });
      if (this.falhar?.test(sql)) throw Error('ERRO_COM_DADOS_PRIVADOS');
      if (sql === 'begin') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) {
        const anterior = this.fila; this.fila = new Promise<void>(r => { liberar = r; }); await anterior;
        bloqueado = true; snapshot = structuredClone([this.registros, this.auditoria]); return { rows: [] };
      }
      if (sql === 'rollback') { if (snapshot) [this.registros, this.auditoria] = snapshot; return { rows: [] }; }
      if (sql === 'commit') return { rows: [] };
      if (!bloqueado) throw Error('OTP_EMAIL_SEM_BLOQUEIO');
      if (sql.startsWith('select') && sql.includes('from public.login_otp_email')) {
        return { rows: structuredClone(this.registros.filter(r => r.email_hash === parametros[0]).sort((a, b) => b.criado_em.getTime() - a.criado_em.getTime()).slice(0, 1)) };
      }
      if (sql.startsWith('insert into public.login_otp_email_auditoria')) {
        this.auditoria.push({ email_hash: parametros[0], evento: parametros[1], criado_em: parametros[2] }); return { rows: [] };
      }
      if (sql.startsWith('insert into public.login_otp_email')) {
        const [email_hash, auth_user_id, codigo_hash, expira_em, criado_em] = parametros;
        const r = { id: randomUUID(), email_hash, auth_user_id, codigo_hash, expira_em, criado_em, tentativas: 0, verificado_em: null, envio_confirmado: false };
        this.registros.push(r); return { rows: structuredClone([r]) };
      }
      if (sql.startsWith('update public.login_otp_email')) {
        const r = this.registros.find(r => r.id === parametros[0]); if (!r) throw Error('OTP_AUSENTE');
        if (sql.includes('envio_confirmado')) r.envio_confirmado = true;
        else if (sql.includes('tentativas = tentativas + 1')) r.tentativas++;
        else if (sql.includes('verificado_em = $2')) r.verificado_em = parametros[1];
        else throw Error('UPDATE_NAO_MODELOU');
        return { rows: [], rowCount: 1 };
      }
      throw Error('SQL_NAO_MODELOU: ' + sql);
    } };
  }
}
