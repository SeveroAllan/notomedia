/**
 * Cliente da API oficial de Distribuicao de DF-e do ADN da NFS-e Nacional.
 * A autenticacao ocorre por mTLS com o certificado A1 do contribuinte.
 */

import https from 'node:https';
import zlib from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';

export type DocumentoAdn = {
  nsu: number;
  chaveAcesso?: string;
  dataHoraGeracao?: string;
  dataHoraEmissao?: string;
  xml: string;
};

export type ResultadoConsultaAdn = {
  documento: DocumentoAdn;
  maxNsu: number;
  resumo: { lotesConsultados: number; documentosConsultados: number; notasDoTitular: number; dataEmissaoSelecionada: string | null };
};

type RespostaHttp = { status: number; corpo: string };

export type HttpMtlsAdn = (
  url: string,
  pfx: Buffer,
  passphrase: string
) => Promise<RespostaHttp>;

type LoteAdn = {
  documentos: DocumentoAdn[];
  maxNsu: number | null;
  ultimoNsu: number;
  quantidadeRecebida: number;
};

export class AdnNfseClient {
  constructor(
    private readonly transmissorHttp?: HttpMtlsAdn,
    private readonly baseUrl = 'https://adn.nfse.gov.br/contribuintes'
  ) {}

  async buscarNfseMaisRecente(
    pfxBuffer: Buffer,
    senhaCertificado: string,
    documentoTitular: string
  ): Promise<ResultadoConsultaAdn> {
    const titular = documentoTitular.replace(/\D/g, '');
    let cnpjConsulta: string | undefined;
    let loteInicial: LoteAdn;
    try {
      loteInicial = await this.consultarLote(0, pfxBuffer, senhaCertificado);
    } catch (erroInicial: any) {
      // Alguns certificados e-CNPJ são rejeitados em TipoConsulta=InscricaoCertificado
      // (HTTP 400 REJEICAO sem detalhes), mas respondem HTTP 200 ao informar cnpjConsulta.
      const msg = String(erroInicial?.message ?? '');
      const rejeicaoInscricao = /HTTP 400|REJEI/i.test(msg);
      if (!rejeicaoInscricao || titular.length !== 14) throw erroInicial;
      cnpjConsulta = titular;
      loteInicial = await this.consultarLote(0, pfxBuffer, senhaCertificado, cnpjConsulta);
    }
    const documentos = [...loteInicial.documentos];
    const limite = loteInicial.maxNsu;
    let cursor = loteInicial.ultimoNsu;
    const inicio = Date.now();
    let consultas = 1;
    let quantidadeRecebida = loteInicial.quantidadeRecebida;
    let documentosConsultados = quantidadeRecebida;
    while (quantidadeRecebida > 0 && (limite === null || cursor < limite)) {
      if (consultas >= 150 || Date.now() - inicio >= 90000) {
        throw new Error('Busca incompleta: o histórico é extenso. Nenhuma referência foi substituída; tente novamente mais tarde.');
      }
      const lote = await this.consultarLote(cursor, pfxBuffer, senhaCertificado, cnpjConsulta);
      consultas++;
      quantidadeRecebida = lote.quantidadeRecebida;
      documentosConsultados += quantidadeRecebida;
      if (!quantidadeRecebida) {
        if (limite !== null && cursor < limite) throw new Error('Busca incompleta: o ADN encerrou os lotes antes do total informado.');
        break;
      }
      if (lote.ultimoNsu <= cursor) throw new Error('Busca incompleta: o ADN não avançou no histórico. Tente novamente mais tarde.');
      documentos.push(...lote.documentos.filter(item => limite === null || item.nsu <= limite));
      cursor = lote.ultimoNsu;
    }

    const notasLocalizadas = documentos
      .filter((item) => /<(?:\w+:)?NFSe\b/i.test(item.xml));
    const notas = notasLocalizadas
      .filter((item) => this.extrairDocumentoPrestador(item.xml) === titular)
      .sort((a, b) => {
        const dataA = Date.parse(a.dataHoraEmissao || a.dataHoraGeracao || '') || 0;
        const dataB = Date.parse(b.dataHoraEmissao || b.dataHoraGeracao || '') || 0;
        return dataB - dataA || b.nsu - a.nsu;
      });

    if (notas.length === 0) {
      if (documentos.length === 0) {
        throw new Error('O ADN não retornou documentos fiscais para o titular deste certificado.');
      }
      if (notasLocalizadas.length === 0) {
        throw new Error(`O ADN retornou ${documentos.length} documento(s), mas nenhum deles é uma NFS-e.`);
      }
      throw new Error(`O ADN retornou ${notasLocalizadas.length} NFS-e(s), mas nenhuma foi emitida pelo titular deste certificado.`);
    }

    return { documento: notas[0], maxNsu: limite ?? cursor,
      resumo: { lotesConsultados: consultas, documentosConsultados, notasDoTitular: notas.length,
        dataEmissaoSelecionada: notas[0].dataHoraEmissao ?? null } };
  }

  private extrairDocumentoPrestador(xml: string): string | null {
    const grupos = ['prest', 'emit'];
    for (const grupo of grupos) {
      const regexGrupo = new RegExp(
        `<(?:\\w+:)?${grupo}\\b[\\s\\S]*?<(?:\\w+:)?(?:CNPJ|CPF)>(\\d{11,14})<\\/(?:\\w+:)?(?:CNPJ|CPF)>[\\s\\S]*?<\\/(?:\\w+:)?${grupo}>`,
        'i'
      );
      const match = xml.match(regexGrupo);
      if (match) return match[1];
    }
    return null;
  }

  private async consultarLote(
    ultimoNsu: number,
    pfxBuffer: Buffer,
    senhaCertificado: string,
    cnpjConsulta?: string
  ): Promise<LoteAdn> {
    const query = cnpjConsulta ? `cnpjConsulta=${encodeURIComponent(cnpjConsulta)}&lote=true` : 'lote=true';
    const url = `${this.baseUrl.replace(/\/$/, '')}/DFe/${ultimoNsu}?${query}`;
    const resposta = this.transmissorHttp
      ? await this.transmissorHttp(url, pfxBuffer, senhaCertificado)
      : await this.executarRequisicaoMtls(url, pfxBuffer, senhaCertificado);

    if (resposta.status === 429) {
      throw new Error('O ADN limitou temporariamente as consultas. Tente novamente em alguns minutos.');
    }

    let json: Record<string, any>;
    try {
      json = JSON.parse(resposta.corpo);
    } catch {
      throw new Error(`O ADN retornou uma resposta invalida (HTTP ${resposta.status}).`);
    }

    const statusProcessamento = String(
      json.StatusProcessamento ?? json.statusProcessamento ?? json.status ?? ''
    ).toUpperCase();
    // A API pode representar o fim da distribuição com HTTP 404 e status próprio.
    if (resposta.status >= 400 && !(resposta.status === 404 && statusProcessamento === 'NENHUM_DOCUMENTO_LOCALIZADO')) {
      throw new Error(`Consulta ao ADN recusada (HTTP ${resposta.status}): ${this.extrairErro(json)}`);
    }

    if (statusProcessamento.includes('REJEICAO') || statusProcessamento.includes('REJEIÇÃO')) {
      throw new Error(`Consulta ao ADN rejeitada: ${this.extrairErro(json)}`);
    }

    const loteRaw = json.LoteDFe ?? json.loteDFe ?? json.documentos;
    if (loteRaw === undefined && statusProcessamento !== 'NENHUM_DOCUMENTO_LOCALIZADO') {
      throw new Error('Busca incompleta: o ADN não informou o lote de documentos.');
    }
    const itens = Array.isArray(loteRaw) ? loteRaw : loteRaw ? [loteRaw] : [];
    const documentos = itens
      .map((item: Record<string, any>) => this.normalizarDocumento(item))
      .filter((item: DocumentoAdn | null): item is DocumentoAdn => item !== null);

    // O contrato nacional não exige um total. Ausência nunca significa fim do histórico.
    const maxRaw = json.MaiorNSU ?? json.maiorNSU ?? json.MaxNSU ?? json.maxNSU ?? json.MaxNsu ?? json.maxNsu;
    const maxNsu = maxRaw === undefined || maxRaw === null ? null : Number(maxRaw);
    if (maxNsu !== null && (!Number.isSafeInteger(maxNsu) || maxNsu < 0)) {
      throw new Error('Busca incompleta: o ADN informou um total inválido.');
    }

    const ultimoRecebido = itens.reduce((maior: number, item: Record<string, any>) => {
      const nsu = Number(item.NSU ?? item.nsu);
      return Number.isSafeInteger(nsu) && nsu > maior ? nsu : maior;
    }, ultimoNsu);
    // Avança pelos envelopes, inclusive eventos e documentos não decodificados.
    return { documentos, maxNsu, ultimoNsu: ultimoRecebido, quantidadeRecebida: itens.length };
  }

  private normalizarDocumento(item: Record<string, any>): DocumentoAdn | null {
    const arquivo = item.ArquivoXml ?? item.arquivoXml ?? item.XML ?? item.xml;
    if (typeof arquivo !== 'string' || !arquivo.trim()) return null;

    const xml = this.decodificarXml(arquivo);
    if (!xml) return null;

    return {
      nsu: Number(item.NSU ?? item.nsu ?? 0),
      chaveAcesso: item.ChaveAcesso ?? item.chaveAcesso,
      dataHoraGeracao: item.DataHoraGeracao ?? item.dataHoraGeracao,
      dataHoraEmissao: this.extrairDataEmissao(xml),
      xml
    };
  }

  private extrairDataEmissao(xml: string): string | undefined {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return undefined;
    try {
      const obj = new XMLParser({ removeNSPrefix: true, parseTagValue: false }).parse(xml);
      const data = obj.NFSe?.infNFSe?.DPS?.infDPS?.dhEmi;
      return typeof data === 'string' && Number.isFinite(Date.parse(data)) ? new Date(data).toISOString() : undefined;
    } catch { return undefined; }
  }

  private decodificarXml(valor: string): string | null {
    const limpo = valor.trim();
    if (limpo.startsWith('<')) return limpo;

    try {
      const buffer = Buffer.from(limpo, 'base64');
      const conteudo = buffer[0] === 0x1f && buffer[1] === 0x8b
        ? zlib.gunzipSync(buffer).toString('utf-8')
        : buffer.toString('utf-8');
      return conteudo.trim().startsWith('<') ? conteudo.trim() : null;
    } catch {
      return null;
    }
  }

  private extrairErro(json: Record<string, any>): string {
    const erros = json.Erros ?? json.erros ?? json.Mensagens ?? json.mensagens ?? json.Alertas ?? json.alertas;
    if (Array.isArray(erros) && erros.length > 0) {
      const erro = erros[0];
      return String(erro.Descricao ?? erro.descricao ?? erro.Mensagem ?? erro.mensagem ?? erro);
    }
    return String(json.motivo ?? json.message ?? json.detalhe ?? 'motivo nao informado');
  }

  private executarRequisicaoMtls(
    urlStr: string,
    pfx: Buffer,
    passphrase: string
  ): Promise<RespostaHttp> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { Accept: 'application/json', Connection: 'close' },
        agent: false,
        pfx,
        passphrase,
        timeout: 45000,
        rejectUnauthorized: true
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          corpo: Buffer.concat(chunks).toString('utf-8')
        }));
      });

      req.on('timeout', () => req.destroy(new Error('Timeout de 45s ao consultar o ADN da NFS-e.')));
      req.on('error', reject);
      req.end();
    });
  }
}
