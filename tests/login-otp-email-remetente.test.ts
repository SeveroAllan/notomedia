import { expect, it, vi } from 'vitest';
import { EnviarOtpEmailResend } from '../src/io/resend/enviar-otp-email.js';

it.each([['', 'Noto <teste@example.invalid>'], ['chave-falsa', '']])('sem credencial ou remetente configurado não chama provedor', async (apiKey, remetente) => {
  const transporte = vi.fn<typeof fetch>();
  expect(await new EnviarOtpEmailResend(apiKey, remetente, transporte).enviar({ email: 'severoallan2019@gmail.com', codigo: '123456' })).toEqual({ sucesso: false });
  expect(transporte).not.toHaveBeenCalled();
});
it.each([true, false])('integração Resend com HTTP inteiramente falso, sucesso=%s', async sucesso => {
  const transporte = vi.fn<typeof fetch>(async () => Response.json({ id: 'mensagem-ficticia' }, { status: sucesso ? 200 : 403 }));
  const remetente = new EnviarOtpEmailResend('chave-falsa', 'Noto <teste@example.invalid>', transporte);
  expect(await remetente.enviar({ email: 'severoallan2019@gmail.com', codigo: '123456' })).toEqual({ sucesso });
  expect(transporte).toHaveBeenCalledTimes(1);
  const [url, opcoes] = transporte.mock.calls[0]; expect(url).toBe('https://api.resend.com/emails');
  expect(opcoes!.method).toBe('POST'); expect(opcoes!.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.parse(opcoes!.body as string)).toEqual({ from: 'Noto <teste@example.invalid>', to: ['severoallan2019@gmail.com'], subject: 'Seu código de acesso ao Noto', text: 'Seu código de verificação é 123456. Válido por 5 minutos.' });
});
it('erro do HTTP falso não expõe corpo ou credenciais', async () => {
  const transporte = vi.fn<typeof fetch>(async () => { throw Error('SEGREDO_EMAIL_CODIGO'); });
  expect(await new EnviarOtpEmailResend('chave-falsa', 'teste@example.invalid', transporte).enviar({ email: 'severoallan2019@gmail.com', codigo: '123456' })).toEqual({ sucesso: false });
});
