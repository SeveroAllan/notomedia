import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { AuthAdminService, UsuarioAutenticadoInfo, SessaoUsuarioResult } from '../auth/auth-admin-service.js';
import { gerarCodigoOtp } from './gerar-codigo-otp.js';
import { gerarHashOtp, compararHashOtp } from './hash-otp.js';
import { calcularDataExpiracao, estaEmCooldownReenvio, excedeuTentativasOtp, otpEstaExpirado } from './limite-otp.js';
import { COOLDOWN_REENVIO_SEGUNDOS, TTL_OTP_MINUTOS, LIMITE_TENTATIVAS_OTP } from './otp-config.js';

type ConfigEmail = Pick<AppConfig, 'loginOtpEmailEnabled' | 'loginOtpEmailAllowlist' | 'appPepper'>;
type MotivoOtpEmail = 'canal_desativado' | 'email_invalido' | 'email_nao_permitido' | 'em_cooldown' | 'falha_envio'
  | 'identidade_indisponivel' | 'codigo_invalido' | 'nao_encontrado' | 'bloqueado_tentativas' | 'expirado'
  | 'envio_nao_confirmado' | 'incorreto' | 'falha_sessao';
export type EventoOtpEmail = MotivoOtpEmail | 'solicitado' | 'enviado' | 'verificado';
type FalhaOtpEmail = { ok: false; motivo: MotivoOtpEmail; tentativasRestantes?: number };
export interface EnviarOtpEmail { enviar(entrada: { email: string; codigo: string }): Promise<{ sucesso: boolean }> }
export interface RegistroOtpEmail {
  id: string; authUserId: string; codigoHash: string; criadoEm: Date; expiraEm: Date;
  tentativas: number; verificadoEm: Date | null; envioConfirmado: boolean;
}
export interface DadosOtpEmail {
  buscarUltimo(): Promise<RegistroOtpEmail | null>;
  salvar(entrada: Pick<RegistroOtpEmail, 'authUserId' | 'codigoHash' | 'criadoEm' | 'expiraEm'>): Promise<RegistroOtpEmail>;
  confirmarEnvio(id: string): Promise<void>;
  incrementarTentativas(id: string): Promise<void>;
  marcarVerificado(id: string, quando: Date): Promise<void>;
  auditar(evento: EventoOtpEmail, quando: Date): Promise<void>;
}
export interface OtpEmailRepositorio {
  /** Serializa solicitação e verificação do mesmo destinatário, incluindo auditoria. */
  comBloqueio<T>(emailHash: string, operacao: (dados: DadosOtpEmail) => Promise<T>): Promise<T>;
}
export interface LoginOtpEmailDeps {
  config: ConfigEmail; repositorio: OtpEmailRepositorio; enviador: EnviarOtpEmail; agora?: () => Date;
  authAdminService: Pick<AuthAdminService, 'gerarSessaoParaUsuario'> & {
    buscarPorEmail(email: string): Promise<UsuarioAutenticadoInfo | null>;
  };
}
const falha = (motivo: MotivoOtpEmail): FalhaOtpEmail => ({ ok: false, motivo });

function admitirEmail(entrada: unknown, config: ConfigEmail) {
  if (config.loginOtpEmailEnabled !== true) return falha('canal_desativado');
  const validado = z.string().trim().max(254).email().safeParse(entrada);
  if (!validado.success) return falha('email_invalido');
  const email = validado.data.toLowerCase();
  // Limite fixo deste experimento: ampliar a configuração não amplia o público autorizado.
  if (email !== 'severoallan2019@gmail.com' || !config.loginOtpEmailAllowlist?.some(e => e.trim().toLowerCase() === email)) return falha('email_nao_permitido');
  const emailHash = createHmac('sha256', config.appPepper).update(JSON.stringify(['login_otp_email', email])).digest('hex');
  return { ok: true as const, email, emailHash };
}
const conteudoHashCodigo = (emailHash: string, codigo: string) => JSON.stringify(['login_otp_email', emailHash, codigo]);

export async function solicitarOtpEmail(entrada: unknown, deps: LoginOtpEmailDeps): Promise<{ ok: true; expiraEm: Date } | FalhaOtpEmail> {
  const destino = admitirEmail(entrada, deps.config);
  if (!destino.ok) return destino;
  return deps.repositorio.comBloqueio(destino.emailHash, async dados => {
    const agora = deps.agora?.() ?? new Date();
    const ultimo = await dados.buscarUltimo();
    if (ultimo && estaEmCooldownReenvio(ultimo.criadoEm, COOLDOWN_REENVIO_SEGUNDOS, agora)) {
      await dados.auditar('em_cooldown', agora); return falha('em_cooldown');
    }
    const usuario = await deps.authAdminService.buscarPorEmail(destino.email);
    if (!usuario) { await dados.auditar('identidade_indisponivel', agora); return falha('identidade_indisponivel'); }
    const codigo = gerarCodigoOtp();
    const expiraEm = calcularDataExpiracao(TTL_OTP_MINUTOS, agora);
    const registro = await dados.salvar({ authUserId: usuario.authUserId, codigoHash: gerarHashOtp(conteudoHashCodigo(destino.emailHash, codigo), deps.config.appPepper), criadoEm: agora, expiraEm });
    await dados.auditar('solicitado', agora);
    let enviado = false;
    try { enviado = (await deps.enviador.enviar({ email: destino.email, codigo })).sucesso; } catch { /* Erros do transporte nunca entram em log ou auditoria. */ }
    if (!enviado) { await dados.auditar('falha_envio', agora); return falha('falha_envio'); }
    await dados.confirmarEnvio(registro.id);
    await dados.auditar('enviado', agora);
    return { ok: true as const, expiraEm };
  });
}

export async function autenticarComOtpEmail(entrada: unknown, codigo: unknown, deps: LoginOtpEmailDeps): Promise<{ ok: true; sessao: SessaoUsuarioResult } | FalhaOtpEmail> {
  const destino = admitirEmail(entrada, deps.config);
  if (!destino.ok) return destino;
  const validacao = await deps.repositorio.comBloqueio(destino.emailHash, async dados => {
    const agora = deps.agora?.() ?? new Date();
    const negar = async (motivo: MotivoOtpEmail) => { await dados.auditar(motivo, agora); return falha(motivo); };
    if (typeof codigo !== 'string' || !/^\d{4,8}$/.test(codigo.trim())) return negar('codigo_invalido');
    const registro = await dados.buscarUltimo();
    if (!registro || registro.verificadoEm) return negar('nao_encontrado');
    if (excedeuTentativasOtp(registro.tentativas)) return negar('bloqueado_tentativas');
    if (otpEstaExpirado(registro.expiraEm, agora)) return negar('expirado');
    if (!registro.envioConfirmado) return negar('envio_nao_confirmado');
    if (!compararHashOtp(conteudoHashCodigo(destino.emailHash, codigo.trim()), registro.codigoHash, deps.config.appPepper)) {
      await dados.incrementarTentativas(registro.id); await dados.auditar('incorreto', agora);
      return { ...falha('incorreto'), tentativasRestantes: Math.max(0, LIMITE_TENTATIVAS_OTP - registro.tentativas - 1) };
    }
    const usuario = await deps.authAdminService.buscarPorEmail(destino.email);
    if (!usuario || usuario.authUserId !== registro.authUserId) return negar('identidade_indisponivel');
    await dados.marcarVerificado(registro.id, agora); await dados.auditar('verificado', agora);
    return { ok: true as const, usuario };
  });
  if (!validacao.ok) return validacao;
  try {
    const sessao = await deps.authAdminService.gerarSessaoParaUsuario(validacao.usuario.authUserId);
    return { ok: true, sessao: { usuario: validacao.usuario, ...sessao } };
  } catch {
    await deps.repositorio.comBloqueio(destino.emailHash, dados => dados.auditar('falha_sessao', deps.agora?.() ?? new Date()));
    return falha('falha_sessao');
  }
}
