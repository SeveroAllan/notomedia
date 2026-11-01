import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';

/** Apenas após login OTP VERIFICADO, somente para conta preexistente e um único
 * número de teste autorizado. A mensagem é um convite, não cria cadastro,
 * não exige acesso ao banco e nunca é enviada a pacientes ou terceiros. */
export async function enviarBoasVindasOtpTeste(deps: {
  ativo: boolean;
  telefoneVerificado: string;
  ehNovoUsuario: boolean;
  authUserId?: string;
  allowlist: readonly string[];
  enviar: (telefone: string, texto: string) => Promise<boolean>;
}): Promise<boolean> {
  if (!deps.ativo || deps.ehNovoUsuario || !deps.authUserId || deps.allowlist.length !== 1) return false;
  const permitido = gerarVariantesTelefoneBrasileiro(deps.allowlist[0]!);
  const variantes = gerarVariantesTelefoneBrasileiro(deps.telefoneVerificado);
  if (!variantes.some(v => permitido.includes(v))) return false;
  const numero = variantes.find(v => /^55\d{10,11}$/.test(v));
  if (!numero) return false;
  try {
    return await deps.enviar(numero,
      'Olá! Eu sou o Noto, seu assistente fiscal. Seu acesso ao Noto foi confirmado. ' +
      'Podemos começar a organizar suas agendas: você utiliza TribeMD, Amplimed ou outra?');
  } catch { return false; }
}
