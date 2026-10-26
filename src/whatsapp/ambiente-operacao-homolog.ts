import { gerarVariantesTelefoneBrasileiro } from './variantes-telefone-brasileiro.js';

/** O ambiente de OPERAÇÃO (este deploy roda em homologação) é configurado
 *  explicitamente por NOTO_AMBIENTE_OPERACAO, separado do perfil fiscal do
 *  médico. Sem essa configuração explícita nada muda: perfil fiscal continua
 *  sendo a única fonte do ambiente. */
export function operacaoHomologacaoExplicita(config: { ambienteOperacao?: string }): boolean {
  return config.ambienteOperacao === 'homologacao';
}

/** Telefone conferido contra a allowlist de envio real: o escopo do canal autorizado. */
export function telefoneNaAllowlist(config: { envioRealAllowlist?: string[] }, telefone: unknown): boolean {
  if (typeof telefone !== 'string' || !/^\d{10,13}$/.test(telefone.replace(/\D/g, ''))) return false;
  const variantes = gerarVariantesTelefoneBrasileiro(telefone);
  return (config.envioRealAllowlist ?? []).some(t => gerarVariantesTelefoneBrasileiro(t).some(v => variantes.includes(v)));
}

/** Perfil fiscal é a fonte primária do ambiente. Somente em deploy com operação
 *  homolog explicitamente configurada, com envio real ativo e telefone na
 *  allowlist, a conversa de configuração responde antes do cadastro fiscal —
 *  sem fabricar perfil, sem copiar dados de outro médico e sem sair da allowlist.
 *  Emissão, certificado e dados fiscais continuam gated pelo estado fiscal. */
export function ambienteEfetivoConversa(
  config: { ambienteOperacao?: string; envioMedicoRealAtivo?: boolean; envioRealAllowlist?: string[] },
  ambientePerfil: unknown,
  telefone: unknown
): string | null {
  if (typeof ambientePerfil === 'string' && ambientePerfil) return ambientePerfil;
  if (!operacaoHomologacaoExplicita(config) || config.envioMedicoRealAtivo !== true) return null;
  return telefoneNaAllowlist(config, telefone) ? 'homologacao' : null;
}
