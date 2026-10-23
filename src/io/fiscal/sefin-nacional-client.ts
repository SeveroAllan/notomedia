/**
 * Cliente HTTP mTLS com a SEFIN Nacional (Convênio NFS-e Nacional / Receita Federal).
 * Transmite o payload JSON comprimido em GZip/Base64 para o endpoint oficial de produção
 * ou homologação, autenticando a conexão mutuamente com o certificado A1 (.p12) do prestador.
 */

import https from 'node:https';
import { rootCertificates } from 'node:tls';
import zlib from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { classificarStatusConsultaDps, type ResultadoConsultaDps } from '../../fiscal/retomada-recusa.js';

export interface EnviarDpsSefinInput {
  xmlAssinado: string;
  pfxBuffer: Buffer;
  senhaCertificado: string;
  ambiente: 1 | 2; // 1 = Produção Oficial, 2 = Homologação / Produção Restrita
  caBundlePath?: string;
}

export interface ResultadoSefinAutorizacao {
  sucesso: true;
  chaveAcesso: string;
  numeroNfse?: string;
  protocoloAutorizacao?: string;
  dataAutorizacao: Date;
  xmlAutorizado: string;
  respostaRaw: Record<string, unknown>;
}

export interface ResultadoSefinRejeicao {
  sucesso: false;
  falhaAntesDoEnvio?: 'EAI_AGAIN' | 'ECONNREFUSED';
  httpStatus?: number;
  codigoErro?: string;
  motivo: string;
  respostaRaw?: Record<string, unknown>;
}

export type ResultadoTransmissaoSefin = ResultadoSefinAutorizacao | ResultadoSefinRejeicao;

export type HttpMtlsTransmissor = (
  url: string,
  payload: string,
  pfx: Buffer,
  passphrase: string,
  caBundle?: Buffer
) => Promise<{ status: number; corpo: string }>;

export function combinarAutoridadesCertificadoras(caBundle?: Buffer): Array<string | Buffer> | undefined {
  if (!caBundle) return undefined;
  // Informar `ca` substitui as autoridades padrão do Node. Mantemos as raízes
  // públicas e acrescentamos a cadeia específica usada pela SEFIN restrita.
  return [...rootCertificates, caBundle];
}

export class SefinNacionalClient {
  private readonly defaultCaBundle: Buffer | undefined;

  constructor(
    private readonly transmissorHttp?: HttpMtlsTransmissor,
    caBundlePath?: string
  ) {
    const caminho = caBundlePath || join(import.meta.dirname, 'ca_bundle.crt');
    if (existsSync(caminho)) {
      this.defaultCaBundle = readFileSync(caminho);
    }
  }

  async transmitirDps(input: EnviarDpsSefinInput): Promise<ResultadoTransmissaoSefin> {
    const url = input.ambiente === 1
      ? 'https://sefin.nfse.gov.br/SefinNacional/nfse'
      : 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse';

    // 1. Compacta o XML assinado em GZip e converte em Base64 conforme especificação SEFIN
    const xmlBuffer = Buffer.from(input.xmlAssinado, 'utf-8');
    const gzipBuffer = zlib.gzipSync(xmlBuffer);
    const dpsXmlGZipB64 = gzipBuffer.toString('base64');

    const bodyPayload = JSON.stringify({ dpsXmlGZipB64 });

    try {
      const resp = this.transmissorHttp
        ? await this.transmissorHttp(url, bodyPayload, input.pfxBuffer, input.senhaCertificado, this.defaultCaBundle)
        : await this.executarRequisicaoMtls(url, bodyPayload, input.pfxBuffer, input.senhaCertificado, this.defaultCaBundle);

      return this.processarRespostaSefin(resp.status, resp.corpo, input.xmlAssinado);
    } catch (err: any) {
      return {
        sucesso: false,
        codigoErro: ['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(err?.code) || err?.name === 'AbortError' ? 'SEFIN_TIMEOUT' : 'SEFIN_INDISPONIVEL',
        falhaAntesDoEnvio: ['EAI_AGAIN', 'ECONNREFUSED'].includes(err?.code) ? err.code : undefined,
        motivo: `Falha de conexão com SEFIN Nacional (${url}): ${err?.message || err}`
      };
    }
  }

  private processarRespostaSefin(
    status: number,
    corpo: string,
    xmlAssinadoOriginal: string
  ): ResultadoTransmissaoSefin {
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(corpo);
    } catch {
      return {
        sucesso: false,
        httpStatus: status,
        motivo: `Resposta HTTP ${status} da SEFIN não é JSON válido: ${corpo.slice(0, 300)}`
      };
    }

    // 1. Tratamento de Rejeição e Erros retornados pela SEFIN
    if (status >= 400 || json['erros'] || json['mensagens']) {
      const erros = (json['erros'] || json['mensagens'] || []) as Array<{
        codigo?: string; descricao?: string; mensagem?: string;
        Codigo?: string; Descricao?: string; Mensagem?: string; Complemento?: string;
      }>;
      if (Array.isArray(erros) && erros.length > 0) {
        const primeiro = erros[0];
        const cod = primeiro.codigo || primeiro.Codigo || 'SEFIN_ERR';
        const descricao = primeiro.descricao || primeiro.Descricao || primeiro.mensagem || primeiro.Mensagem;
        const msg = descricao
          ? `${descricao}${primeiro.Complemento ? ` ${primeiro.Complemento}` : ''}`
          : JSON.stringify(primeiro);
        return {
          sucesso: false,
          codigoErro: cod,
          httpStatus: status,
          motivo: `SEFIN rejeitou a emissão [${cod}]: ${msg}`,
          respostaRaw: json
        };
      }

      if (json['motivo'] || json['message']) {
        return {
          sucesso: false,
          httpStatus: status,
          motivo: `SEFIN [HTTP ${status}]: ${json['motivo'] || json['message']}`,
          respostaRaw: json
        };
      }
    }

    // 2. Extração do XML autorizado devolvido pela SEFIN
    let xmlAutorizado = xmlAssinadoOriginal;
    const nfseGzipB64 = (json['nfseXmlGZipB64'] || json['xmlGZipB64']) as string | undefined;

    if (nfseGzipB64 && typeof nfseGzipB64 === 'string') {
      try {
        const decomp = zlib.gunzipSync(Buffer.from(nfseGzipB64, 'base64'));
        xmlAutorizado = decomp.toString('utf-8');
      } catch (err: any) {
        console.warn('[SefinNacionalClient] Falha ao descompactar nfseXmlGZipB64 retornado:', err?.message);
      }
    }

    // 3. Captura da Chave de Acesso oficial de 50 dígitos
    let chaveAcesso = (json['chNFSe'] || json['chaveAcesso']) as string | undefined;
    if (!chaveAcesso || !/^\d{50}$/.test(chaveAcesso)) {
      const matchChave = xmlAutorizado.match(/<chNFSe>(\d{50})<\/chNFSe>/) ||
                         xmlAutorizado.match(/Id="NFS(\d{50})"/);
      if (matchChave) {
        chaveAcesso = matchChave[1];
      }
    }

    if (!chaveAcesso || !/^\d{50}$/.test(chaveAcesso)) {
      return {
        sucesso: false,
        motivo: `SEFIN respondeu status ${status}, mas chave de acesso de 50 dígitos não foi localizada no retorno.`,
        respostaRaw: json
      };
    }

    // 4. Captura do número oficial da NFS-e e protocolo de autorização
    let numeroNfse: string | undefined = json['nNFSe'] ? String(json['nNFSe']) : undefined;
    if (!numeroNfse) {
      const matchNum = xmlAutorizado.match(/<nNFSe>(\d+)<\/nNFSe>/);
      if (matchNum) numeroNfse = matchNum[1];
    }

    let protocolo: string | undefined = json['nProt'] ? String(json['nProt']) : undefined;
    if (!protocolo) {
      const matchProt = xmlAutorizado.match(/<nProt>([^<]+)<\/nProt>/);
      if (matchProt) protocolo = matchProt[1];
    }

    return {
      sucesso: true,
      chaveAcesso,
      numeroNfse,
      protocoloAutorizacao: protocolo,
      dataAutorizacao: new Date(),
      xmlAutorizado,
      respostaRaw: json
    };
  }

  /**
   * Reconciliação somente-leitura (Manual dos Contribuintes v1.2 out/2025, seção 1.4.2):
   * HEAD /dps/{id} informa se uma NFS-e foi gerada a partir do identificador da DPS.
   * Usada para provar recusa definitiva antes de qualquer retomada. Nunca transmite nada.
   */
  async consultarDpsGerada(
    dpsId: string,
    input: { pfxBuffer: Buffer; senhaCertificado: string; ambiente: 1 | 2 }
  ): Promise<{ resultado: ResultadoConsultaDps; httpStatus?: number }> {
    if (!/^DPS\d{42}$/.test(dpsId)) return { resultado: 'indeterminado' };
    const base = input.ambiente === 1
      ? 'https://sefin.nfse.gov.br'
      : 'https://sefin.producaorestrita.nfse.gov.br';
    try {
      const resp = await this.executarRequisicaoMtls(`${base}/SefinNacional/dps/${dpsId}`, '', input.pfxBuffer, input.senhaCertificado, this.defaultCaBundle, 'HEAD');
      return { resultado: classificarStatusConsultaDps(resp.status), httpStatus: resp.status };
    } catch {
      return { resultado: 'indeterminado' };
    }
  }

  private executarRequisicaoMtls(
    urlStr: string,
    body: string,
    pfx: Buffer,
    passphrase: string,
    caBundle?: Buffer,
    metodo: 'POST' | 'HEAD' = 'POST'
  ): Promise<{ status: number; corpo: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: metodo,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Accept': 'application/json'
        },
        pfx,
        passphrase,
        ca: combinarAutoridadesCertificadoras(caBundle),
        timeout: 45000,
        rejectUnauthorized: true
      };

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            corpo: Buffer.concat(chunks).toString('utf-8')
          });
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error(`Timeout de 45s ao comunicar com SEFIN Nacional (${urlStr})`));
      });

      req.on('error', (err) => reject(err));
      req.write(body);
      req.end();
    });
  }
}
