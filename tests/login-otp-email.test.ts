import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { carregarConfig } from '../src/config.js';
import { solicitarOtpEmail, autenticarComOtpEmail, type OtpEmailRepositorio, type RegistroOtpEmail, type DadosOtpEmail, type LoginOtpEmailDeps } from '../src/otp/login-otp-email.js';

const email = 'severoallan2019@gmail.com';
const pepper = 'pepper-ficticio-email';
const inicio = new Date('2026-10-19T12:00:00Z');
const usuario = { usuarioId: 'usuario-ficticio', authUserId: 'auth-ficticio', medicoId: 'medico-ficticio', papel: 'medico' as const, ehNovoUsuario: false };
const emailHash = createHmac('sha256', pepper).update(JSON.stringify(['login_otp_email', email])).digest('hex');

function cenario() {
  let registro: RegistroOtpEmail | null = null, agora = inicio;
  let fila = Promise.resolve();
  const auditoria: Array<{ evento: string; emailHash: string; quando: Date }> = [];
  const enviar = vi.fn(async (_entrada: { email: string; codigo: string }) => ({ sucesso: true }));
  const buscarPorEmail = vi.fn(async (_email: string) => usuario as typeof usuario | null);
  const gerarSessaoParaUsuario = vi.fn(async (_id: string) => ({ tokenAcesso: 'token-ficticio' }));
  const repositorio: OtpEmailRepositorio = {
    async comBloqueio(chave, operacao) {
      const anterior = fila; let liberar!: () => void;
      fila = new Promise<void>(r => { liberar = r; }); await anterior;
      const antes = structuredClone({ registro, auditoria });
      const dados: DadosOtpEmail = {
        buscarUltimo: async () => registro ? structuredClone(registro) : null,
        salvar: async entrada => { registro = { ...entrada, id: 'otp-ficticio', tentativas: 0, verificadoEm: null, envioConfirmado: false }; return structuredClone(registro); },
        confirmarEnvio: async () => { registro!.envioConfirmado = true; },
        incrementarTentativas: async () => { registro!.tentativas++; },
        marcarVerificado: async (_id, quando) => { registro!.verificadoEm = quando; },
        auditar: async (evento, quando) => { auditoria.push({ evento, emailHash: chave, quando }); }
      };
      try { return await operacao(dados); }
      catch (erro) { registro = antes.registro; auditoria.splice(0, auditoria.length, ...antes.auditoria); throw erro; }
      finally { liberar(); }
    }
  };
  const deps: LoginOtpEmailDeps = {
    config: { loginOtpEmailEnabled: true, loginOtpEmailAllowlist: [email], appPepper: pepper },
    repositorio, enviador: { enviar }, authAdminService: { buscarPorEmail, gerarSessaoParaUsuario }, agora: () => agora
  };
  const comBloqueio = vi.spyOn(repositorio, 'comBloqueio');
  return { deps, enviar, buscarPorEmail, gerarSessaoParaUsuario, comBloqueio, auditoria, registro: () => registro,
    codigo: () => enviar.mock.calls.at(-1)![0].codigo, avancar: (ms: number) => { agora = new Date(inicio.getTime() + ms); } };
}

describe('canal extra de e-mail, fechado por padrão', () => {
  it.each([undefined, 'false', 'TRUE', '1'])('configuração ausente ou não explícita %s mantém flag desligada', valor => {
    expect(carregarConfig({ LOGIN_OTP_EMAIL_ENABLED: valor })).toMatchObject({ loginOtpEmailEnabled: false, loginOtpEmailAllowlist: [] });
  });
  it.each([undefined, false])('flag %s não acessa persistência, identidade ou envio', async ativo => {
    const c = cenario(); c.deps.config.loginOtpEmailEnabled = ativo;
    expect(await solicitarOtpEmail(email, c.deps)).toEqual({ ok: false, motivo: 'canal_desativado' });
    expect(await autenticarComOtpEmail(email, '123456', c.deps)).toEqual({ ok: false, motivo: 'canal_desativado' });
    expect(c.comBloqueio).not.toHaveBeenCalled(); expect(c.enviar).not.toHaveBeenCalled(); expect(c.buscarPorEmail).not.toHaveBeenCalled(); expect(c.gerarSessaoParaUsuario).not.toHaveBeenCalled();
  });
  it.each(['outro@example.invalid', 'severoallan2019+teste@gmail.com', 'severo.allan2019@gmail.com'])('recusa %s mesmo se indevidamente acrescentado à allowlist', async endereco => {
    const c = cenario(); c.deps.config.loginOtpEmailAllowlist = [email, endereco];
    expect(await solicitarOtpEmail(endereco, c.deps)).toEqual({ ok: false, motivo: 'email_nao_permitido' });
    expect(await autenticarComOtpEmail(endereco, '123456', c.deps)).toEqual({ ok: false, motivo: 'email_nao_permitido' });
    expect(c.comBloqueio).not.toHaveBeenCalled(); expect(c.enviar).not.toHaveBeenCalled(); expect(c.buscarPorEmail).not.toHaveBeenCalled();
  });
  it('endereço autorizado ainda exige inclusão explícita na allowlist', async () => {
    const c = cenario(); c.deps.config.loginOtpEmailAllowlist = [];
    expect(await solicitarOtpEmail(email, c.deps)).toEqual({ ok: false, motivo: 'email_nao_permitido' });
    expect(c.enviar).not.toHaveBeenCalled();
  });
  it.each([null, {}, [], '', 'invalido', 'a\r\nb@example.invalid'])('recusa entrada inválida %j sem efeitos', async entrada => {
    const c = cenario(); expect((await solicitarOtpEmail(entrada, c.deps)).ok).toBe(false);
    expect(c.enviar).not.toHaveBeenCalled(); expect(c.comBloqueio).not.toHaveBeenCalled();
  });
});

describe('OTP por e-mail com remetente e identidade falsos', () => {
  it('normaliza caixa/espaços, envia seis dígitos, guarda HMAC vinculado ao canal e expira em cinco minutos', async () => {
    const c = cenario();
    expect(await solicitarOtpEmail(' SEVEROALLAN2019@GMAIL.COM ', c.deps)).toEqual({ ok: true, expiraEm: new Date('2026-10-19T12:05:00Z') });
    expect(c.enviar).toHaveBeenCalledExactlyOnceWith({ email, codigo: expect.stringMatching(/^\d{6}$/) });
    const esperado = createHmac('sha256', pepper).update(JSON.stringify(['login_otp_email', emailHash, c.codigo()])).digest('hex');
    expect(c.registro()).toMatchObject({ codigoHash: esperado, expiraEm: new Date('2026-10-19T12:05:00Z'), tentativas: 0, envioConfirmado: true });
    expect(c.comBloqueio.mock.calls[0][0]).toBe(emailHash);
    expect(JSON.stringify([c.registro(), c.auditoria])).not.toContain(email);
    expect(JSON.stringify([c.registro(), c.auditoria])).not.toContain(JSON.stringify(c.codigo()));
    expect(c.auditoria.map(a => a.evento)).toEqual(['solicitado', 'enviado']);
  });
  it('verifica código, consome antes da sessão e não o reutiliza', async () => {
    const c = cenario(); await solicitarOtpEmail(email, c.deps);
    c.gerarSessaoParaUsuario.mockImplementation(async () => { expect(c.registro()!.verificadoEm).toEqual(inicio); return { tokenAcesso: 'token-ficticio' }; });
    expect(await autenticarComOtpEmail(email, c.codigo(), c.deps)).toEqual({ ok: true, sessao: { usuario, tokenAcesso: 'token-ficticio' } });
    expect(await autenticarComOtpEmail(email, c.codigo(), c.deps)).toEqual({ ok: false, motivo: 'nao_encontrado' });
    expect(c.gerarSessaoParaUsuario).toHaveBeenCalledExactlyOnceWith('auth-ficticio');
    expect(JSON.stringify(c.auditoria)).not.toMatch(/gmail|token-ficticio/);
  });
  it('cooldown de 60s também impede duas solicitações concorrentes', async () => {
    const c = cenario(); const resultados = await Promise.all([solicitarOtpEmail(email, c.deps), solicitarOtpEmail(email, c.deps)]);
    expect(resultados.filter(r => r.ok)).toHaveLength(1); expect(c.enviar).toHaveBeenCalledTimes(1);
    c.avancar(59999); expect(await solicitarOtpEmail(email, c.deps)).toEqual({ ok: false, motivo: 'em_cooldown' });
    c.avancar(60000); expect((await solicitarOtpEmail(email, c.deps)).ok).toBe(true); expect(c.enviar).toHaveBeenCalledTimes(2);
  });
  it.each([300000, 300001])('mesma fronteira temporal do WhatsApp, aos %s ms', async tempo => {
    const c = cenario(); await solicitarOtpEmail(email, c.deps); c.avancar(tempo);
    const resultado = await autenticarComOtpEmail(email, c.codigo(), c.deps);
    expect(resultado.ok).toBe(tempo === 300000);
    if (tempo > 300000) expect(resultado).toEqual({ ok: false, motivo: 'expirado' });
  });
  it('cinco erros concorrentes bloqueiam o código correto e não geram sessão', async () => {
    const c = cenario(); await solicitarOtpEmail(email, c.deps);
    const errado = c.codigo() === '000000' ? '111111' : '000000';
    const resultados = await Promise.all(Array.from({ length: 5 }, () => autenticarComOtpEmail(email, errado, c.deps)));
    expect(resultados).toEqual([4, 3, 2, 1, 0].map(tentativasRestantes => ({ ok: false, motivo: 'incorreto', tentativasRestantes })));
    expect(c.registro()!.tentativas).toBe(5);
    expect(await autenticarComOtpEmail(email, c.codigo(), c.deps)).toEqual({ ok: false, motivo: 'bloqueado_tentativas' });
    expect(c.gerarSessaoParaUsuario).not.toHaveBeenCalled();
  });
  it('duas verificações concorrentes geram no máximo uma sessão', async () => {
    const c = cenario(); await solicitarOtpEmail(email, c.deps);
    const resultados = await Promise.all([autenticarComOtpEmail(email, c.codigo(), c.deps), autenticarComOtpEmail(email, c.codigo(), c.deps)]);
    expect(resultados.filter(r => r.ok)).toHaveLength(1); expect(c.gerarSessaoParaUsuario).toHaveBeenCalledTimes(1);
  });
  it('formato inválido é auditado sem consumir tentativa', async () => {
    const c = cenario(); await solicitarOtpEmail(email, c.deps);
    expect(await autenticarComOtpEmail(email, '12ab34', c.deps)).toEqual({ ok: false, motivo: 'codigo_invalido' });
    expect(c.registro()!.tentativas).toBe(0); expect(c.auditoria.at(-1)!.evento).toBe('codigo_invalido');
  });
  it.each([false, true])('falha do remetente, inclusive exceção=%s, não vaza PII/OTP e conserva cooldown', async excecao => {
    const c = cenario(); c.enviar.mockImplementation(async entrada => { if (excecao) throw Error(`${entrada.email} ${entrada.codigo} SEGREDO`); return { sucesso: false }; });
    expect(await solicitarOtpEmail(email, c.deps)).toEqual({ ok: false, motivo: 'falha_envio' });
    expect(await autenticarComOtpEmail(email, c.codigo(), c.deps)).toEqual({ ok: false, motivo: 'envio_nao_confirmado' });
    expect(await solicitarOtpEmail(email, c.deps)).toEqual({ ok: false, motivo: 'em_cooldown' });
    expect(JSON.stringify(c.auditoria)).not.toMatch(/gmail|SEGREDO/); expect(c.gerarSessaoParaUsuario).not.toHaveBeenCalled();
  });
  it('não cadastra conta por e-mail e não envia se identidade confirmada estiver ausente', async () => {
    const c = cenario(); c.buscarPorEmail.mockResolvedValue(null);
    expect(await solicitarOtpEmail(email, c.deps)).toEqual({ ok: false, motivo: 'identidade_indisponivel' });
    expect(c.enviar).not.toHaveBeenCalled(); expect(c.registro()).toBeNull();
  });
  it('recusa identidade que mudou entre solicitação e verificação', async () => {
    const c = cenario(); await solicitarOtpEmail(email, c.deps);
    c.buscarPorEmail.mockResolvedValue({ ...usuario, authUserId: 'outra-identidade' });
    expect(await autenticarComOtpEmail(email, c.codigo(), c.deps)).toEqual({ ok: false, motivo: 'identidade_indisponivel' });
    expect(c.gerarSessaoParaUsuario).not.toHaveBeenCalled();
  });
  it('falha ao gerar sessão conserva OTP consumido e audita só código fixo', async () => {
    const c = cenario(); await solicitarOtpEmail(email, c.deps);
    c.gerarSessaoParaUsuario.mockRejectedValue(Error(`${email} TOKEN_PRIVADO`));
    expect(await autenticarComOtpEmail(email, c.codigo(), c.deps)).toEqual({ ok: false, motivo: 'falha_sessao' });
    expect(await autenticarComOtpEmail(email, c.codigo(), c.deps)).toEqual({ ok: false, motivo: 'nao_encontrado' });
    expect(c.auditoria.some(a => a.evento === 'falha_sessao')).toBe(true);
    expect(JSON.stringify(c.auditoria)).not.toMatch(/gmail|TOKEN_PRIVADO/);
  });
});
