import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { generateDanfsePdf } from './gerar-danfse-pdf.js';

export async function gerarDanfseDeXmlAutorizado(xml:string,chave:string):Promise<Uint8Array> {
  if (!/^\d{50}$/.test(chave) || xml.length>2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml)!==true)
    throw new Error('XML_AUTORIZADO_INVALIDO');
  const n = new XMLParser({removeNSPrefix:true,ignoreAttributes:false,parseTagValue:false,processEntities:false})
    .parse(xml).NFSe?.infNFSe;
  const dps = n?.DPS?.infDPS;
  const valor = dps?.valores?.vServPrest?.vServ;
  if (n?.['@_Id'] !== 'NFS'+chave || dps?.tpAmb !== '2' || typeof n.nNFSe !== 'string' ||
      typeof valor !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(valor))
    throw new Error('XML_AUTORIZADO_DIVERGENTE');
  const servico = dps.serv?.cServ;
  return generateDanfsePdf({
    chaveAcesso:chave, numero:n.nNFSe, serie:dps.serie, dataEmissao:dps.dhEmi,
    competencia:dps.dCompet, ambiente:'homologacao',
    prestador:{razaoSocial:n.emit?.xNome, cnpj:n.emit?.CNPJ ?? n.emit?.CPF,
      inscricaoMunicipal:n.emit?.IM, municipio:dps.prest?.end?.endNac?.cMun},
    tomador:{nome:dps.toma?.xNome, cpf:dps.toma?.CPF ?? dps.toma?.CNPJ},
    servico:{municipioPrestacao:dps.serv?.locPrest?.cLocPrestacao, cTribNac:servico?.cTribNac,
      cNBS:servico?.cNBS, discriminacao:servico?.xDescServ, valor:Number(valor)}
  });
}
