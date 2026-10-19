import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { criarAppExpress } from '../src/server.js';
import { BancoOtpEmailFalso } from './fakes/banco-otp-email.js';
import { SupabaseAuthAdminService } from '../src/io/supabase/supabase-auth-admin-service.js';
import { EvolutionApiClient } from '../src/io/evolution/evolution-api-client.js';
import type { EnviarOtpEmail } from '../src/otp/login-otp-email.js';

const borda = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn() }));
vi.mock('../src/io/postgres/pool.js', () => ({ pool: borda }));
const email = 'severoallan2019@gmail.com', anterior = { ...config };
let banco: BancoOtpEmailFalso;
let enviar: ReturnType<typeof vi.fn<EnviarOtpEmail['enviar']>>, rede: ReturnType<typeof vi.spyOn>, whatsapp: ReturnType<typeof vi.spyOn>, erros: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks(); banco = new BancoOtpEmailFalso(); borda.connect.mockImplementation(() => banco.connect());
  borda.query.mockImplementation(async (sql: string, p: any[]) => {
    if (sql.includes('from otp_verificacoes')) return { rows: [] };
    if (sql.includes('insert into otp_verificacoes')) return { rows: [{ id: 'otp-whatsapp-ficticio', telefone: p[0], codigo_hash: p[1], expira_em: p[2], criado_em: p[3], tentativas: 0, verificado_em: null }] };
    throw Error('SQL_NAO_ESPERADO');
  });
  config.loginOtpEmailEnabled = false; config.loginOtpEmailAllowlist = []; config.resendApiKey = undefined;
  enviar = vi.fn<EnviarOtpEmail['enviar']>(async () => ({ sucesso: true }));
  vi.spyOn(SupabaseAuthAdminService.prototype, 'buscarPorEmail').mockResolvedValue({ usuarioId: 'usuario-ficticio', authUserId: 'auth-ficticio', medicoId: 'medico-ficticio', papel: 'medico', ehNovoUsuario: false });
  vi.spyOn(SupabaseAuthAdminService.prototype, 'gerarSessaoParaUsuario').mockResolvedValue({ tokenAcesso: 'token-ficticio' });
  whatsapp = vi.spyOn(EvolutionApiClient.prototype, 'enviar').mockResolvedValue({ sucesso: true });
  rede = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw Error('REDE_REAL_PROIBIDA'); });
  erros = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { expect(rede).not.toHaveBeenCalled(); Object.assign(config, anterior); vi.restoreAllMocks(); });
async function chamar(caminho: string, body: unknown, app = criarAppExpress({ enviadorOtpEmail: { enviar } })) {
  const handler = (app as any).router.stack.find((l: any) => l.route?.path === caminho)?.route.stack[0].handle;
  expect(handler).toBeTypeOf('function');
  let status = 200, resposta: any;
  const res = { status(valor: number) { status = valor; return res; }, json(valor: unknown) { resposta = valor; return res; } };
  await handler({ body }, res); return { status, resposta, app };
}
it.each([false, true])('WhatsApp continua padrão e intacto com flag de e-mail=%s', async ativo => {
  config.loginOtpEmailEnabled = ativo;
  const resultado = await chamar('/api/auth/otp/solicitar', { telefone: '5511999990000' });
  expect(resultado.status).toBe(200); expect(resultado.resposta.ok).toBe(true);
  expect(whatsapp).toHaveBeenCalledExactlyOnceWith({ telefone: '5511999990000', codigo: expect.stringMatching(/^\d{6}$/) });
  expect(enviar).not.toHaveBeenCalled(); expect(borda.connect).not.toHaveBeenCalled();
});
it('flag ausente/desligada bloqueia rotas extras sem banco ou envio', async () => {
  for (const caminho of ['/api/auth/otp/email/solicitar', '/api/auth/otp/email/verificar']) {
    expect(await chamar(caminho, { email, codigo: '123456' })).toMatchObject({ status: 404, resposta: { ok: false, motivo: 'canal_desativado' } });
  }
  expect(enviar).not.toHaveBeenCalled(); expect(borda.query).not.toHaveBeenCalled(); expect(borda.connect).not.toHaveBeenCalled();
});
it('flag ligada e endereço externo à allowlist bloqueiam solicitação e verificação', async () => {
  config.loginOtpEmailEnabled = true; config.loginOtpEmailAllowlist = [email];
  for (const caminho of ['/api/auth/otp/email/solicitar', '/api/auth/otp/email/verificar']) {
    expect(await chamar(caminho, { email: 'outra-pessoa@example.invalid', codigo: '123456' })).toMatchObject({ status: 403, resposta: { ok: false, motivo: 'email_nao_permitido' } });
  }
  expect(enviar).not.toHaveBeenCalled(); expect(whatsapp).not.toHaveBeenCalled(); expect(borda.connect).not.toHaveBeenCalled();
});
it('fluxo completo passa por banco/auditoria reais do adaptador e remetente falso até sessão falsa', async () => {
  config.loginOtpEmailEnabled = true; config.loginOtpEmailAllowlist = [email];
  const pedido = await chamar('/api/auth/otp/email/solicitar', { email });
  expect(pedido.status).toBe(200); expect(pedido.resposta).toMatchObject({ ok: true, expiraEm: expect.any(Date) });
  const codigo = enviar.mock.calls[0][0].codigo;
  expect(await chamar('/api/auth/otp/email/verificar', { email, codigo }, pedido.app)).toMatchObject({ status: 200, resposta: { ok: true, sessao: { tokenAcesso: 'token-ficticio' } } });
  expect(await chamar('/api/auth/otp/email/verificar', { email, codigo }, pedido.app)).toMatchObject({ status: 401, resposta: { ok: false, motivo: 'nao_encontrado' } });
  const dados = JSON.stringify([banco.registros, banco.auditoria, banco.comandos, erros.mock.calls]);
  expect(dados).not.toContain(email); expect(dados).not.toContain(JSON.stringify(codigo));
  expect(whatsapp).not.toHaveBeenCalled();
});
it('exceção no banco é devolvida e logada sem corpo, e-mail, OTP ou erro livre', async () => {
  config.loginOtpEmailEnabled = true; config.loginOtpEmailAllowlist = [email]; banco.falhar = /from public.login_otp_email/;
  expect(await chamar('/api/auth/otp/email/solicitar', { email })).toMatchObject({ status: 500, resposta: { ok: false, motivo: 'otp_email_indisponivel' } });
  expect(erros.mock.calls).toEqual([['LOGIN_OTP_EMAIL_FALHOU']]); expect(enviar).not.toHaveBeenCalled();
});
