/**
 * Regra pura que define se uma emissão em homologação pode cair em contingência
 * local (gerando DANFSe tarjado "SEM VALOR FISCAL" a partir da DPS já assinada
 * com o Certificado A1 real). Mantida sem I/O para garantir trava absoluta
 * contra uso em produção, no piloto restrito ou diante de erros fiscais reais.
 */

const CODIGOS_INDISPONIBILIDADE_SEFIN = new Set([
  'SEFIN_HTTP_403_IIS',
  'SEFIN_TIMEOUT',
  'SEFIN_INDISPONIVEL'
]);

export interface EntradaDecisaoContingenciaHomologacao {
  permitirContingenciaHomologacao: boolean;
  pilotoWhatsApp: boolean;
  ambiente: 1 | 2;
  xmlAssinadoPresente: boolean;
  codigoErroSefin?: string;
  httpStatus?: number;
  falhaAntesDoEnvio?: string;
}

export function podeUsarContingenciaHomologacao(
  entrada: EntradaDecisaoContingenciaHomologacao
): boolean {
  if (!entrada.permitirContingenciaHomologacao) return false;
  if (entrada.pilotoWhatsApp) return false;
  // Trava absoluta: contingência local jamais pode rodar em produção (ambiente 1).
  if (entrada.ambiente !== 2) return false;
  // Exige que toda validação fiscal e a assinatura digital com o A1 real já tenham ocorrido.
  if (!entrada.xmlAssinadoPresente) return false;

  if (entrada.falhaAntesDoEnvio) return true;
  if (entrada.codigoErroSefin && CODIGOS_INDISPONIBILIDADE_SEFIN.has(entrada.codigoErroSefin)) return true;
  if (entrada.httpStatus && (entrada.httpStatus >= 500 || entrada.httpStatus === 408 || entrada.httpStatus === 429)) {
    return true;
  }
  return false;
}
