import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { enviarBoasVindasOtpTeste } from '../src/agente/boas-vindas-otp.js';
import { localizarContaExistentePorTelefone } from '../src/agente/conta-existente.js';
import { carregarConfig } from '../src/config.js';
import { solicitarOtp } from '../src/otp/solicitar-otp.js';
import { autenticarComOtp } from '../src/auth/autenticar-com-otp.js';
import type { OtpRegistro } from '../src/otp/otp-repositorio.js';

describe('piloto: conta real via OTP e mensagem restrita ao número autorizado', () => {
  const numero = '5511999990000';
  it('busca identidade Auth da conta existente somente por SELECT e não cadastra', async () => {
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      expect(sql.trim().toLowerCase().startsWith('select')).toBe(true);
      expect(sql).toContain('auth_user_id is not null');
      expect(params).toHaveLength(1);
      return { rows: [{
        usuario_id: 'u-1', auth_user_id: 'auth-1', papel: 'medico', nome: 'Profissional Teste', medico_id: 'm-1'
      }] };
    });
    expect(await localizarContaExistentePorTelefone({ query } as unknown as pg.Pool, numero)).toMatchObject({
      authUserId: 'auth-1', usuarioId: 'u-1', medicoId: 'm-1', ehNovoUsuario: false
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('duplicidade ou ausência de Auth falha fechada, sem adivinhar a conta', async () => {
    for (const rows of [[], [{ usuario_id: 'u-1', auth_user_id: null, papel: 'medico' }], [
      { usuario_id: 'u-1', auth_user_id: 'a-1', papel: 'medico' },
      { usuario_id: 'u-2', auth_user_id: 'a-2', papel: 'medico' }
    ]]) {
      const query = vi.fn().mockResolvedValue({ rows });
      expect(await localizarContaExistentePorTelefone({ query } as unknown as pg.Pool, numero)).toBeNull();
    }
  });

  it('envia boas-vindas uma única vez ao destinatário do OTP validado, não a terceiros', async () => {
    const enviar = vi.fn().mockResolvedValue(true);
    const base = { ativo: true, telefoneVerificado: numero, ehNovoUsuario: false,
      authUserId: 'auth-1', allowlist: ['11999990000'], enviar };
    expect(await enviarBoasVindasOtpTeste(base)).toBe(true);
    expect(enviar).toHaveBeenCalledExactlyOnceWith(numero, expect.stringContaining('Sou o Noto'));
    for (const op of [
      { ...base, telefoneVerificado: '5521999990000' },
      { ...base, ativo: false },
      { ...base, ehNovoUsuario: true },
      { ...base, authUserId: undefined },
      { ...base, allowlist: ['11999990000', '21999990000'] },
      { ...base, allowlist: [] }
    ]) expect(await enviarBoasVindasOtpTeste(op)).toBe(false);
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it('login OTP validado em modo piloto não chama o cadastro automático se não existe conta', async () => {
    const agora = new Date('2026-11-01T12:00:00Z');
    let codigo = '';
    let registro: OtpRegistro | null = null;
    const repositorio = {
      salvar: async (r: any) => { registro = { ...r, id: 'otp-1', tentativas: 0, verificadoEm: null }; return registro; },
      buscarUltimoPorTelefone: async () => registro,
      incrementarTentativas: vi.fn(), marcarVerificado: vi.fn()
    };
    const enviador = { enviar: vi.fn(async (v: { telefone: string; codigo: string }) => {
      codigo = v.codigo; return { sucesso: true };
    }) };
    expect((await solicitarOtp(numero, { repositorio, enviador, pepper: 'pepper-teste', agora: () => agora })).ok).toBe(true);
    const cadastrarNovoMedico = vi.fn();
    const buscarPorTelefone = vi.fn();
    const gerarSessaoParaUsuario = vi.fn();
    const localizarContaExistente = vi.fn().mockResolvedValue(null);
    const resposta = await autenticarComOtp(numero, codigo, {
      otpRepositorio: repositorio, pepper: 'pepper-teste', agora: () => agora,
      authAdminService: { buscarPorTelefone, cadastrarNovoMedico, gerarSessaoParaUsuario },
      localizarContaExistente
    });
    expect(resposta).toMatchObject({ ok: false, motivo: 'conta_existente_nao_encontrada' });
    expect(localizarContaExistente).toHaveBeenCalledExactlyOnceWith(numero);
    expect(buscarPorTelefone).not.toHaveBeenCalled();
    expect(cadastrarNovoMedico).not.toHaveBeenCalled();
    expect(gerarSessaoParaUsuario).not.toHaveBeenCalled();
  });

  it('boas-vindas desligadas por padrão e não habilitáveis sem login existente', () => {
    expect(carregarConfig({})).toMatchObject({
      notoAgentBoasVindasOtpTesteAtivas: false,
      notoAgentLoginContaExistenteApenas: false
    });
    expect(() => carregarConfig({ NOTO_AGENT_BOAS_VINDAS_OTP_TESTE_ATIVAS: 'true' }))
      .toThrow('Boas-vindas do piloto exigem');
  });
});
