import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { PostgresOtpEmailRepositorio } from '../src/io/postgres/postgres-otp-repositorio.js';
import { solicitarOtpEmail, autenticarComOtpEmail } from '../src/otp/login-otp-email.js';
import { BancoOtpEmailFalso } from './fakes/banco-otp-email.js';

const email = 'severoallan2019@gmail.com', pepper = 'pepper-ficticio';
const inicio = new Date('2026-10-19T12:00:00Z');
const usuario = { usuarioId: 'usuario-ficticio', authUserId: 'auth-ficticio', papel: 'medico' as const, ehNovoUsuario: false };
function cenario() {
  const banco = new BancoOtpEmailFalso();
  const enviar = vi.fn(async (_entrada: { email: string; codigo: string }) => ({ sucesso: true }));
  const gerarSessaoParaUsuario = vi.fn(async () => ({ tokenAcesso: 'sessao-ficticia' }));
  const deps = { config: { appPepper: pepper, loginOtpEmailEnabled: true, loginOtpEmailAllowlist: [email] },
    repositorio: new PostgresOtpEmailRepositorio(banco.pool), enviador: { enviar },
    authAdminService: { buscarPorEmail: async () => usuario, gerarSessaoParaUsuario }, agora: () => inicio };
  return { banco, deps, enviar, gerarSessaoParaUsuario };
}
it('auditoria SQL só recebe hash, evento e data; OTP/cadastro nunca aparecem em claro', async () => {
  const c = cenario(); await solicitarOtpEmail(email, c.deps); const codigo = c.enviar.mock.calls[0][0].codigo;
  expect(await autenticarComOtpEmail(email, codigo, c.deps)).toMatchObject({ ok: true });
  const hash = createHmac('sha256', pepper).update(JSON.stringify(['login_otp_email', email])).digest('hex');
  expect(c.banco.registros[0].email_hash).toBe(hash);
  expect(c.banco.auditoria).toEqual(['solicitado', 'enviado', 'verificado'].map(evento => ({ email_hash: hash, evento, criado_em: inicio })));
  const gravado = JSON.stringify([c.banco.registros, c.banco.auditoria, c.banco.comandos]);
  expect(gravado).not.toContain(email); expect(gravado).not.toContain(JSON.stringify(codigo)); expect(gravado).not.toContain('sessao-ficticia');
  expect(c.banco.comandos.some(c => c.sql.includes('otp_verificacoes'))).toBe(false);
  expect(c.banco.comandos.every(c => !/^(create|alter|drop)/.test(c.sql))).toBe(true);
});
it('bloqueio PostgreSQL por destinatário impede envio e consumo duplicados entre instâncias do serviço', async () => {
  const c = cenario(); const outra = { ...c.deps, repositorio: new PostgresOtpEmailRepositorio(c.banco.pool) };
  const pedidos = await Promise.all([solicitarOtpEmail(email, c.deps), solicitarOtpEmail(email, outra)]);
  expect(pedidos.filter(r => r.ok)).toHaveLength(1); expect(c.enviar).toHaveBeenCalledTimes(1);
  const codigo = c.enviar.mock.calls[0][0].codigo;
  const sessoes = await Promise.all([autenticarComOtpEmail(email, codigo, c.deps), autenticarComOtpEmail(email, codigo, outra)]);
  expect(sessoes.filter(r => r.ok)).toHaveLength(1); expect(c.gerarSessaoParaUsuario).toHaveBeenCalledTimes(1);
  expect(c.banco.comandos.filter(c => c.sql.includes('pg_advisory_xact_lock')).length).toBe(4);
});
it('falha da auditoria anterior ao envio causa rollback e impede transporte', async () => {
  const c = cenario(); c.banco.falhar = /^insert into public.login_otp_email_auditoria/;
  await expect(solicitarOtpEmail(email, c.deps)).rejects.toThrow();
  expect(c.enviar).not.toHaveBeenCalled(); expect(c.banco.registros).toEqual([]); expect(c.banco.auditoria).toEqual([]);
  expect(c.banco.comandos.at(-1)!.sql).toBe('rollback');
});
it('migração fica apenas proposta, isolada do OTP WhatsApp e sem colunas para e-mail/OTP em claro', () => {
  const sql = readFileSync('scripts/migrations/20261022-login-otp-email.sql', 'utf8').toLowerCase();
  for (const tabela of ['login_otp_email', 'login_otp_email_auditoria']) {
    expect(sql).toContain(`create table if not exists public.${tabela}`);
    expect(sql).toContain(`alter table public.${tabela} enable row level security`);
    expect(sql).toContain(`revoke all on table public.${tabela} from public`);
  }
  expect(sql).toContain("email_hash ~ '^[a-f0-9]{64}$'"); expect(sql).toContain('codigo_hash');
  expect(sql).not.toMatch(/\bemail\s+(text|varchar)|\bcodigo\s+(text|varchar)|alter table.*otp_verificacoes/);
});
