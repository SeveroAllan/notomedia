import type { EnviarOtpEmail } from '../../otp/login-otp-email.js';
import { TTL_OTP_MINUTOS } from '../../otp/otp-config.js';

export class EnviarOtpEmailResend implements EnviarOtpEmail {
  constructor(private readonly apiKey = '', private readonly remetente = '', private readonly transporte: typeof fetch = fetch) {}

  async enviar(entrada: { email: string; codigo: string }): Promise<{ sucesso: boolean }> {
    if (!this.apiKey || !this.remetente) return { sucesso: false };
    try {
      const resposta = await this.transporte('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.remetente, to: [entrada.email], subject: 'Seu código de acesso ao Noto',
          text: `Seu código de verificação é ${entrada.codigo}. Válido por ${TTL_OTP_MINUTOS} minutos.` })
      });
      return { sucesso: resposta.ok };
    } catch { return { sucesso: false }; }
  }
}
