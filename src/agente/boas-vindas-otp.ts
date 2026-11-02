/**
 * Compatibilidade para consumidores antigos: boas-vindas após OTP estão proibidas.
 * O único gatilho permitido é a conexão real da Evolution, com reserva durável
 * em boas-vindas-pareamento.ts. Mantido temporariamente para detecção de regressões.
 */
export async function enviarBoasVindasOtpTeste(_deps: {
  ativo: boolean;
  telefoneVerificado: string;
  ehNovoUsuario: boolean;
  authUserId?: string;
  allowlist: readonly string[];
  enviar: (telefone: string, texto: string) => Promise<boolean>;
}): Promise<boolean> {
  return false;
}
