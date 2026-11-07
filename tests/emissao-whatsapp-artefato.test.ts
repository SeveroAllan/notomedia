import { expect, it } from 'vitest';
import { gerarDanfseDeXmlAutorizado } from '../src/fiscal/danfse/danfse-de-xml-autorizado.js';

const chave='1'.repeat(50);
const xml=`<NFSe><infNFSe Id="NFS${chave}"><nNFSe>1</nNFSe><emit><xNome>Emitente sintético</xNome></emit>
  <DPS><infDPS><tpAmb>2</tpAmb><serie>00001</serie><valores><vServPrest><vServ>100.00</vServ></vServPrest></valores></infDPS></DPS>
</infNFSe></NFSe>`;
it('gera PDF localmente do XML autorizado e bloqueia chave ou ambiente divergentes',async()=>{
  expect(Buffer.from(await gerarDanfseDeXmlAutorizado(xml,chave)).subarray(0,5).toString()).toBe('%PDF-');
  await expect(gerarDanfseDeXmlAutorizado(xml,'2'.repeat(50))).rejects.toThrow('XML_AUTORIZADO_DIVERGENTE');
  await expect(gerarDanfseDeXmlAutorizado(xml.replace('<tpAmb>2','<tpAmb>1'),chave)).rejects.toThrow('XML_AUTORIZADO_DIVERGENTE');
});
