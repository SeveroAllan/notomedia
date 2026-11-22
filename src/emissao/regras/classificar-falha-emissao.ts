/**
 * Regras puras de classificação e tradução humana de falhas de emissão NFS-e.
 * Separado de `worker-casos-emissao.ts` para manter decisões puras testáveis
 * sem Postgres/Storage e impedir jargão técnico excessivo nas mensagens ao médico.
 */

import type { ResultadoEmissaoDps } from '../../worker/emissor-dps-service.js';

export type FalhaEmissaoDps = Extract<ResultadoEmissaoDps, { sucesso: false }>;

const CODIGOS_INDISPONIBILIDADE_SEFIN = new Set([
  'SEFIN_HTTP_403_IIS',
  'SEFIN_TIMEOUT',
  'SEFIN_INDISPONIVEL'
]);

/** Identifica falhas transitórias de rede/servidor que merecem retentativa automática. */
export function ehFalhaTransitoriaSefin(falha: FalhaEmissaoDps): boolean {
  if (falha.falhaAntesDoEnvio) return true;
  if (falha.codigoErroSefin && ['SEFIN_TIMEOUT', 'SEFIN_INDISPONIVEL'].includes(falha.codigoErroSefin)) return true;
  if (falha.httpStatus && (falha.httpStatus >= 500 || falha.httpStatus === 408 || falha.httpStatus === 429)) return true;
  return false;
}

/** Identifica queda ou bloqueio global da SEFIN que afeta todo o lote da conta no ambiente. */
export function ehIndisponibilidadeGlobalSefin(codigoErro?: string): boolean {
  return Boolean(codigoErro && CODIGOS_INDISPONIBILIDADE_SEFIN.has(codigoErro));
}

/** Traduz códigos técnicos da SEFIN em explicação profissional, objetiva e sem jargão. */
export function explicarErroEmissaoHumano(entrada: {
  codigoErro?: string;
  erroSanitizado: string;
  pacienteNome: string | null;
}): string {
  const alvo = entrada.pacienteNome ? ` de ${entrada.pacienteNome}` : '';
  switch (entrada.codigoErro) {
    case 'CERTIFICADO_AUSENTE':
    case 'CERTIFICADO_INVALIDO':
      return 'Pausei a emissão porque não consegui validar o Certificado A1 agora. Quer que eu mande um novo link seguro para subir o certificado?';
    case 'PARAMETROS_FISCAIS_PENDENTES':
    case 'PERFIL_FISCAL_INCOMPLETO':
      return `Pausei a emissão${alvo} porque os parâmetros fiscais precisam de ajuste (${entrada.erroSanitizado}). Quer que eu tente reimportar pelo seu certificado agora?`;
    case 'PACIENTE_CPF_INVALIDO':
      return `A emissão${alvo} travou porque o CPF cadastrado está inválido. Pode confirmar o CPF certinho para eu reenviar?`;
    case 'PACIENTE_NOME_INVALIDO':
      return `Preciso do nome completo${alvo} para a prefeitura aceitar a nota. Pode me confirmar aqui?`;
    case 'SEFIN_HTTP_403_IIS':
      return 'Tentei transmitir agora na SEFIN de homologação, mas o servidor oficial segue recusando conexões (erro 403). Suas notas continuam salvas aqui e sigo monitorando para emitir automaticamente assim que o serviço voltar.';
    case 'SEFIN_TIMEOUT':
    case 'SEFIN_INDISPONIVEL':
      return 'Tentei transmitir agora no Ambiente Nacional da NFS-e, mas o servidor oficial está sem resposta no momento. Suas notas continuam salvas e eu emito automaticamente assim que estabilizar.';
    default:
      return `Não consegui concluir a nota${alvo} na prefeitura agora (${entrada.erroSanitizado}).`;
  }
}
