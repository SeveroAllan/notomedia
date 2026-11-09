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

it('reserva PDF e XML separadamente e não repete envio após erro', async()=>{
  const { entregarEmissaoWhatsApp } = await import('../src/worker/entregar-emissao-whatsapp.js');
  const reservas = new Set<string>();
  const estados:string[] = [];
  const pool = {async query(sql:string, params:string[]) {
    if (sql.includes('from public.notas_fiscais')) return {rows:[{id:'nota-teste',chave_acesso:chave,xml_storage_path:'teste.xml'}]};
    if (sql.includes('insert into public.noto_envios_homologacao')) {
      if (reservas.has(params[1]!)) return {rows:[]};
      reservas.add(params[1]!);
      return {rows:[{id:params[1]}]};
    }
    if (sql.includes('update public.noto_envios_homologacao')) { estados.push(params[1]!);return {rows:[]}; }
    throw new Error('Escrita inesperada');
  }} as unknown as Parameters<typeof entregarEmissaoWhatsApp>[0];
  const storage = {storage:{from:()=>({download:async()=>({data:new Blob([xml])})})}} as unknown as Parameters<typeof entregarEmissaoWhatsApp>[1];
  const envios:string[][] = [];
  const evolution = {async enviarDocumento(params:{contatoTelefone:string},tipo:string) {
    envios.push([params.contatoTelefone,tipo]);
    return {sucesso:tipo==='application/xml'};
  }} as unknown as Parameters<typeof entregarEmissaoWhatsApp>[2];
  const escopo={contaId:'conta-teste',medicoId:'medico-teste',agendamentoId:'agendamento-teste'};
  for(let tentativa=0;tentativa<2;tentativa++)
    await entregarEmissaoWhatsApp(pool,storage,evolution,escopo,'solicitacao-teste','assistente-teste','5551999990000');
  expect(envios).toEqual([['5551999990000','application/pdf'],['5551999990000','application/xml']]);
  expect(estados).toEqual(['erro','enviado']);
});
