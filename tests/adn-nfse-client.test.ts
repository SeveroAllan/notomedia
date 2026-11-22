import { describe, expect, it, vi } from 'vitest';
import zlib from 'node:zlib';
import { AdnNfseClient, type HttpMtlsAdn } from '../src/io/fiscal/adn-nfse-client.js';
import { respostaCompativelComFerramentas } from '../src/agente/agente.js';

function zipBase64(xml: string): string {
  return zlib.gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
}

function nfseXml(cnpj: string, dhEmi: string): string {
  return `<NFSe><infNFSe><DPS><infDPS><dhEmi>${dhEmi}</dhEmi><prest><CNPJ>${cnpj}</CNPJ></prest></infDPS></DPS></infNFSe></NFSe>`;
}

describe('AdnNfseClient — busca de NFS-e mais recente com fallback cnpjConsulta', () => {
  it('faz fallback automático para cnpjConsulta quando InscricaoCertificado devolve HTTP 400 REJEICAO', async () => {
    const cnpj = '12345678000199';
    const urlsChamadas: string[] = [];
    const transmissor: HttpMtlsAdn = vi.fn(async url => {
      urlsChamadas.push(url);
      if (!url.includes('cnpjConsulta=')) {
        return {
          status: 400,
          corpo: JSON.stringify({
            TipoConsulta: 'InscricaoCertificado',
            StatusProcessamento: 'REJEICAO',
            LoteDFe: [],
            Alertas: [],
            Erros: []
          })
        };
      }
      if (url.includes('/DFe/0?')) {
        return {
          status: 200,
          corpo: JSON.stringify({
            StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS',
            LoteDFe: [
              { NSU: 10, ArquivoXml: zipBase64(nfseXml(cnpj, '2026-10-15T10:00:00-03:00')) }
            ]
          })
        };
      }
      if (url.includes('/DFe/10?')) {
        return {
          status: 200,
          corpo: JSON.stringify({
            StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS',
            LoteDFe: [
              { NSU: 25, ArquivoXml: zipBase64(nfseXml(cnpj, '2026-11-04T11:05:01-03:00')) }
            ]
          })
        };
      }
      return {
        status: 404,
        corpo: JSON.stringify({ StatusProcessamento: 'NENHUM_DOCUMENTO_LOCALIZADO', LoteDFe: [] })
      };
    });

    const client = new AdnNfseClient(transmissor);
    const res = await client.buscarNfseMaisRecente(Buffer.from('pfx'), 'senha', cnpj);

    expect(res.documento.nsu).toBe(25);
    expect(res.resumo.notasDoTitular).toBe(2);
    expect(urlsChamadas).toEqual([
      'https://adn.nfse.gov.br/contribuintes/DFe/0?lote=true',
      `https://adn.nfse.gov.br/contribuintes/DFe/0?cnpjConsulta=${cnpj}&lote=true`,
      `https://adn.nfse.gov.br/contribuintes/DFe/10?cnpjConsulta=${cnpj}&lote=true`,
      `https://adn.nfse.gov.br/contribuintes/DFe/25?cnpjConsulta=${cnpj}&lote=true`
    ]);
  });

  it('mantém consulta direta sem cnpjConsulta quando InscricaoCertificado responde 200', async () => {
    const cnpj = '12345678000199';
    const urlsChamadas: string[] = [];
    const transmissor: HttpMtlsAdn = vi.fn(async url => {
      urlsChamadas.push(url);
      if (url.includes('/DFe/0?')) {
        return {
          status: 200,
          corpo: JSON.stringify({
            StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS',
            MaiorNSU: 5,
            LoteDFe: [{ NSU: 5, ArquivoXml: zipBase64(nfseXml(cnpj, '2026-11-10T09:00:00-03:00')) }]
          })
        };
      }
      return { status: 404, corpo: JSON.stringify({ StatusProcessamento: 'NENHUM_DOCUMENTO_LOCALIZADO' }) };
    });

    const client = new AdnNfseClient(transmissor);
    const res = await client.buscarNfseMaisRecente(Buffer.from('pfx'), 'senha', cnpj);

    expect(res.documento.nsu).toBe(5);
    expect(urlsChamadas).toEqual(['https://adn.nfse.gov.br/contribuintes/DFe/0?lote=true']);
  });

  it('bloqueia alucinação de envio de link e verificação sem ferramenta executada', () => {
    expect(respostaCompativelComFerramentas(
      'Já mandei de novo o link seguro para enviar o certificado da Alice Xavier.',
      [{ nome: 'enviar_link_certificado_profissional', codigo: 'CERTIFICADO_EXISTENTE', duracaoMs: 10 }]
    )).toBe(false);

    expect(respostaCompativelComFerramentas(
      'Verifiquei de novo e o sistema não achou um certificado A1 válido salvo para a médica Alice Xavier ainda.',
      []
    )).toBe(false);

    expect(respostaCompativelComFerramentas(
      'Verifiquei agora e o certificado A1 da Alice Xavier já está válido e os dados fiscais estão prontos.',
      [{ nome: 'consultar_estado_onboarding_conta', codigo: 'ONBOARDING_CONSULTADO', duracaoMs: 12 }]
    )).toBe(true);
  });
});
