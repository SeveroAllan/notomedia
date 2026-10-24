import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type pg from 'pg';
import forge from 'node-forge';
import { gzipSync } from 'node:zlib';
import { BancoJornada } from './fakes/banco-jornada.js';
import { criarAppExpress } from '../src/server.js';
import { config } from '../src/config.js';
import { CadastroCertificado } from '../src/cadastro/cadastro-certificado.js';
import { PostgresCadastro } from '../src/cadastro/postgres-cadastro.js';
import { extrairChavesCertificado } from '../src/io/fiscal/extrair-chaves-certificado.js';
import { carregarCertificadoMedico } from '../src/io/fiscal/carregar-certificado-medico.js';

const fronteiras = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), supabase: vi.fn(), adn: vi.fn() }));
vi.mock('../src/io/postgres/pool.js', () => ({pool:{query:fronteiras.query,connect:fronteiras.connect}}));
vi.mock('@supabase/supabase-js', () => ({createClient:fronteiras.supabase}));
vi.mock('../src/io/fiscal/adn-nfse-client.js', async original => {
  const real = await original<typeof import('../src/io/fiscal/adn-nfse-client.js')>();
  return { ...real, AdnNfseClient: class extends real.AdnNfseClient { constructor() {super(fronteiras.adn);} } };
});
// Agenda é uma dependência externa; todas as decisões de comunicação continuam reais.
vi.mock('../src/cofre/router.js', async () => { const express=await import('express');return {criarCofreContas:()=>({app:express.default(),statusAgenda:async()=>({nome:null,conectada:false}),encerrar:async()=>{}})}; });
const documento='11222333000181', nome='Clara Almeida Ficticia', telefone='5511999990000';
const authId='00000000-0000-4000-8000-000000000010', token='sessao-jornada-ficticia';
const senha='senha-apenas-fixture';
const xml = (data:string, numero=12) => `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe><nNFSe>${numero}</nNFSe><emit><CNPJ>${documento}</CNPJ><xNome>Consultorio Ficticio Ltda</xNome><IM>123</IM><enderNac><UF>SC</UF></enderNac></emit><DPS versao="1.01"><infDPS><tpAmb>2</tpAmb><dhEmi>${data}</dhEmi><serie>1</serie><nDPS>${numero}</nDPS><dCompet>2026-10-01</dCompet><tpEmit>1</tpEmit><cLocEmi>4205407</cLocEmi><prest><CNPJ>${documento}</CNPJ><regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib></prest><serv><locPrest><cLocPrestacao>4205407</cLocPrestacao></locPrest><cServ><cTribNac>040101</cTribNac><xDescServ>Consulta medica</xDescServ></cServ></serv><valores><vServPrest><vServ>200.00</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun><tribFed><piscofins><CST>08</CST></piscofins></tribFed><totTrib><pTotTribSN>6.00</pTotTribSN></totTrib></trib></valores></infDPS></DPS></infNFSe></NFSe>`;
const xmlRecente=xml('2026-10-17T12:00:00-03:00');
function pfxFicticio() {
  const chaves=forge.pki.rsa.generateKeyPair(1024), cert=forge.pki.createCertificate();
  cert.publicKey=chaves.publicKey;cert.serialNumber='01';cert.validity.notBefore=new Date('2020-01-01');cert.validity.notAfter=new Date('2040-01-01');
  cert.setSubject([{name:'commonName',value:`TESTE FICTICIO ${documento}`}]);cert.setIssuer(cert.subject.attributes);cert.sign(chaves.privateKey);
  return Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(chaves.privateKey,[cert],senha,{algorithm:'3des'})).getBytes(),'binary');
}
const pfx=pfxFicticio();
let banco:BancoJornada, servidor:Server, origem:string, codigo:string, conectado:boolean;
let supabase:any, logs:ReturnType<typeof vi.spyOn>, avisos:ReturnType<typeof vi.spyOn>, erros:ReturnType<typeof vi.spyOn>, rede:ReturnType<typeof vi.spyOn>;
let respostas:Array<{caminho:string;body:unknown}>;
const configAnterior={...config};
const objetos=new Map<string,Buffer>();
const requisitarLocal=globalThis.fetch;
beforeEach(async()=>{
  vi.clearAllMocks();objetos.clear();banco=new BancoJornada();codigo='';conectado=false;respostas=[];
  config.appPublicOrigin='https://app-ficticio.invalid';
  config.preparacaoFiscalAtiva=false;config.comunicacaoMedicoAtiva=true;config.evolutionApiUrl='https://evolution.invalid';config.evolutionGlobalApiKey='ficticia';config.evolutionWebhookSecret='ficticio';config.hubDesenvolvedorToken='';config.openserpBaseUrl='';
  fronteiras.query.mockImplementation((s,p)=>banco.query(s,p));fronteiras.connect.mockImplementation(()=>banco.connect());
  supabase={auth:{getUser:vi.fn(async(t:string)=>({data:{user:t===token?{id:authId}:null},error:t===token?null:{message:'Token invalido'}})),admin:{
    createUser:vi.fn(async()=>({data:{user:{id:authId}},error:null})),
    getUserById:vi.fn(async()=>({data:{user:{id:authId,email:`medico_${telefone}@auth.notomed.local`}},error:null})),
    generateLink:vi.fn(async()=>({data:{properties:{hashed_token:'hash-sessao'}},error:null}))},
    verifyOtp:vi.fn(async()=>({data:{session:{access_token:token},user:{id:authId}},error:null}))},storage:{from:(bucket:string)=>({
      upload:async(path:string,buffer:Buffer)=>{objetos.set(`${bucket}/${path}`,Buffer.from(buffer));return {error:null};},
      download:async(path:string)=>{const b=objetos.get(`${bucket}/${path}`);return {data:b?{arrayBuffer:async()=>Uint8Array.from(b).buffer}:null,error:b?null:{message:'Ausente'}};},
      remove:async(paths:string[])=>{paths.forEach(p=>objetos.delete(`${bucket}/${p}`));return {error:null};}
    })}};
  fronteiras.supabase.mockReturnValue(supabase);
  fronteiras.adn.mockImplementation(async(_url,pfxRecebido,senhaRecebida)=>{expect(pfxRecebido).toEqual(pfx);expect(senhaRecebida).toBe(senha);return {status:200,corpo:JSON.stringify({MaiorNSU:3,LoteDFe:[
    {NSU:1,ArquivoXml:gzipSync(xml('2026-10-15T12:00:00-03:00',11)).toString('base64')},
    {NSU:2,ArquivoXml:gzipSync(xmlRecente).toString('base64')},
    {NSU:3,ArquivoXml:gzipSync(xml('2026-10-16T12:00:00-03:00',13)).toString('base64')}]})};});
  rede=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
    const url=new URL(String(input));
    if(url.hostname==='127.0.0.1')return requisitarLocal(input,init);
    if(url.hostname!=='evolution.invalid')throw Error(`REDE_PROIBIDA: ${url.hostname}`);
    const body=init?.body?JSON.parse(String(init.body)):{};
    if(url.pathname.includes('/webhook/set/')) expect(body.webhook.url).toBe('https://app-ficticio.invalid/webhook/evolution');
    if(url.pathname.includes('/message/sendButtons/')){codigo=JSON.stringify(body).match(/\b\d{6}\b/)?.[0]??'';return Response.json({key:{id:'otp-ficticio'}});}
    if(url.pathname.includes('/message/sendText/')||url.pathname.includes('/message/sendMedia/'))throw Error('ENVIO_REAL_PROIBIDO');
    if(url.pathname==='/instance/create')return Response.json(body.qrcode?{qrcode:{base64:'cXI='}}:{pairingCode:'1234-5678'});
    if(url.pathname.startsWith('/instance/connectionState/'))return Response.json({instance:{state:conectado?'open':'connecting'}});
    if(url.pathname.startsWith('/settings/set/')||url.pathname.startsWith('/webhook/set/'))return Response.json({ok:true});
    if(url.pathname.startsWith('/chat/findMessages/'))return Response.json({messages:{records:[],pages:1}});
    throw Error(`EVOLUTION_FORA_DO_CONTRATO: ${url.pathname}`);
  });
  logs=vi.spyOn(console,'info').mockImplementation(()=>{});
  avisos=vi.spyOn(console,'warn').mockImplementation(()=>{});
  erros=vi.spyOn(console,'error').mockImplementation(()=>{});
  const app=criarAppExpress();servidor=await new Promise<Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  origem=`http://127.0.0.1:${(servidor.address() as any).port}`;
});
afterEach(async()=>{
  await new Promise<void>((resolve,reject)=>servidor.close(e=>e?reject(e):resolve()));
  expect(banco.desconhecidas).toEqual([]);
  expect(rede.mock.calls.filter(([u]: any[])=>/\/message\/(sendText|sendMedia)\//.test(String(u)))).toEqual([]);
  expect(banco.consultas.some(s=>/insert into (notas_fiscais|solicitacoes_nota)/.test(s))).toBe(false);
  const mensagens=JSON.stringify([logs.mock.calls,avisos.mock.calls,erros.mock.calls]);
  const respostasOnboarding=JSON.stringify(respostas.filter(r=>r.caminho!=='/api/auth/otp/verificar'));
  for(const segredo of [senha,token,pfx.toString('base64')]) {
    expect(mensagens).not.toContain(segredo);
    expect(respostasOnboarding).not.toContain(segredo);
  }
  for(const segredo of [senha,pfx.toString('base64')])expect(JSON.stringify(respostas)).not.toContain(segredo);
  Object.assign(config,configAnterior);vi.restoreAllMocks();
});
async function chamar(caminho:string,body?:unknown,autorizacao=token){
  const r=await fetch(origem+caminho,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${autorizacao}`},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const resposta=await r.json() as any;respostas.push({caminho,body:resposta});
  return {status:r.status,body:resposta};
}
async function entrar(){
  expect((await chamar('/api/auth/otp/solicitar',{telefone})).status).toBe(200);expect(codigo).toMatch(/^\d{6}$/);
  const login=await chamar('/api/auth/otp/verificar',{telefone,codigo});expect(login.status).toBe(200);expect(login.body.sessao.tokenAcesso).toBe(token);
  expect(login.body.sessao.usuario.ehNovoUsuario).toBe(true);expect(banco.otp.codigo_hash).not.toContain(codigo);expect(banco.otp.verificado_em).not.toBeNull();
  return login.body.sessao.usuario.medicoId as string;
}
const upload=(medicoId:string)=>chamar('/api/onboarding/certificado',{medicoId,arquivoBase64:pfx.toString('base64'),nomeArquivo:'ficticio.pfx',senha,consentimentoFiscal:'continuar-a1-v1'});
async function pesquisarProfissional(){
  const empresa={consultar:vi.fn(async()=>({estado:'consultado' as const,dados:{cnpj:documento,razaoSocial:'Consultorio Ficticio Ltda',origem:'Fonte externa ficticia',candidatos:[{nome,origem:'Fonte externa ficticia'}]}}))};
  const registro={buscar:vi.fn(async()=>({estado:'consultado' as const,dados:[{nomeCompleto:nome,crm:'12345',uf:'SC',rqe:'6789',origem:'Conselho ficticio',verificado:true}]}))};
  const worker=new CadastroCertificado(new PostgresCadastro({query:fronteiras.query,connect:fronteiras.connect} as unknown as pg.Pool),empresa,registro,async(medico,certId)=>{
    const cert=await carregarCertificadoMedico({query:fronteiras.query} as unknown as pg.Pool,supabase,medico);expect(cert?.id).toBe(certId);return extrairChavesCertificado(cert!.pfxBuffer,cert!.senhaCertificado).documentoTitular;
  });
  await worker.recuperar();expect(empresa.consultar).toHaveBeenCalledWith(documento);expect(registro.buscar).toHaveBeenCalledWith(nome);
}
async function aprovar(){
  expect((await chamar('/api/conta/cadastro/',undefined,'token-invalido')).status).toBe(401);
  const revisao=(await chamar('/api/conta/cadastro/')).body.revisao;
  expect(revisao).toMatchObject({nome,crm:'12345/SC',rqe:'6789',aprovado:false,pesquisaCrm:'consultado'});
  const r=await chamar('/api/conta/cadastro/aprovar',{trabalhoId:revisao.trabalhoId,versao:revisao.versao,nome,crm:'54321/SC',rqe:'9876'});
  expect(r.status).toBe(200);expect(r.body.revisao).toMatchObject({aprovado:true,nome,crm:'54321/SC',rqe:'9876'});
}

it.each(['codigo','qrcode'] as const)('jornada OTP, A1, ADN real, revisão, WhatsApp %s, painel fiscal e boas-vindas secas com flag padrão',async modoConexao=>{
  const medicoId=await entrar();
  const statusInicial=await chamar(`/api/onboarding/status?medicoId=${medicoId}`);expect(statusInicial.status).toBe(200);expect(statusInicial.body.status.liberadoParaEmitir).toBe(false);
  expect((await chamar(`/api/onboarding/status?medicoId=${medicoId}`,undefined,'invalido')).status).toBe(401);
  const certificado=await upload(medicoId);expect(certificado.status).toBe(200);expect(certificado.body.importacaoFiscal).toMatchObject({ok:true,fonte:'adn',nsu:2});
  expect(certificado.body.importacaoFiscal.parametros.dadosReformaTributaria.pendencias).toEqual([]);
  expect(certificado.body.adocaoFiscal).toMatchObject({ok:false});
  expect([...objetos.entries()].filter(([p])=>p.startsWith('xmls_referencia/')).map(([,v])=>v.toString())).toEqual([xmlRecente]);
  expect((await chamar('/api/onboarding/whatsapp/iniciar',{medicoId,modoConexao})).status).toBe(409);
  await pesquisarProfissional();await aprovar();
  const parear=await chamar('/api/onboarding/whatsapp/iniciar',{medicoId,modoConexao});expect(parear.status).toBe(200);expect(parear.body.ok).toBe(true);
  expect(parear.body[modoConexao==='codigo'?'pairingCode':'qrcodeBase64']).toBe(modoConexao==='codigo'?'1234-5678':'data:image/png;base64,cXI=');
  conectado=true;expect((await chamar(`/api/onboarding/whatsapp/status?medicoId=${medicoId}`)).body.conectado).toBe(true);
  const painel=await chamar(`/api/onboarding/status?medicoId=${medicoId}`);expect(painel.body.status.passos).toMatchObject({passoProfissionalAprovado:true,passo4WhatsappConectado:true,passo2FiscalConfirmado:false});
  const referenciaHash=painel.body.status.perfilFiscal.referenciaFiscal.hash;
  const confirmar=await chamar('/api/onboarding/confirmar-fiscal',{medicoId,usarReferencia:true,referenciaHash});expect(confirmar.status).toBe(200);
  const politica=(await chamar(`/api/onboarding/status?medicoId=${medicoId}`)).body.status.perfilFiscal.parametrosEmissao;
  expect(politica).toMatchObject({referenciaHash,fidelidadeReferencia:true});
  const editar=await chamar('/api/onboarding/confirmar-fiscal',{medicoId,referenciaHash,parametrosEmissao:politica.parametros,serieDps:'2',proximoNumeroDps:20,razaoSocial:'Consultorio Revisado Ficticio'});expect(editar.status).toBe(200);
  const final=(await chamar(`/api/onboarding/status?medicoId=${medicoId}`)).body.status;
  expect(final.liberadoParaEmitir).toBe(true);expect(final.perfilFiscal).toMatchObject({confirmadoPeloMedico:true,razaoSocial:'Consultorio Revisado Ficticio',serieDps:'2',proximoNumeroDps:20});
  expect((await chamar('/api/onboarding/confirmar-fiscal',{medicoId,referenciaHash,parametrosEmissao:politica.parametros,serieDps:'2',proximoNumeroDps:20,razaoSocial:'Consultorio Revisado Ficticio'})).status).toBe(200);
  await chamar(`/api/onboarding/whatsapp/status?medicoId=${medicoId}`);
  await vi.waitFor(()=>expect(logs.mock.calls.filter((a: any[])=>a[0]==='enviaria boas_vindas')).toHaveLength(1));
  expect(banco.historico.historicos.size).toBe(2);
  expect([...banco.historico.historicos.values()].map(h=>h.modo).sort()).toEqual(['real', 'simulado']);
  expect([...banco.historico.historicos.values()].find(h=>h.modo==='real')).toMatchObject({boas_vindas_em:null, pergunta_nota_em:null, resposta_nota:null});
  expect([...banco.historico.tentativas.values()].every(t=>t.modo==='simulado')).toBe(true);
  expect(banco.historico.envios.size).toBe(0);
  expect(banco.consultas.some(s=>s.includes('parametros_emissao = $3'))).toBe(true);
});

it('ADN indisponível preserva o A1 e permite XML como alternativa; nova tentativa automática reutiliza o A1',async()=>{
  const medicoId=await entrar();fronteiras.adn.mockResolvedValueOnce({status:503,corpo:'Indisponibilidade ficticia'});
  const certificado=await upload(medicoId);expect(certificado.body).toMatchObject({ok:true,importacaoFiscal:{ok:false}});expect(banco.perfil).toBeNull();
  const fallback=await chamar('/api/onboarding/xml',{medicoId,xmlString:xmlRecente});expect(fallback.status).toBe(200);expect(fallback.body.ok).toBe(true);
  const tentativa=await chamar('/api/onboarding/buscar-referencia',{medicoId});expect(tentativa.status).toBe(200);expect(tentativa.body).toMatchObject({ok:true,fonte:'adn',nsu:2});
  expect(banco.certificados).toHaveLength(1);expect(fronteiras.adn).toHaveBeenCalledTimes(2);
});

it('reenvio do A1 do mesmo titular mantém aprovação profissional e conexão já concluída',async()=>{
  const medicoId=await entrar();await upload(medicoId);await pesquisarProfissional();await aprovar();
  await chamar('/api/onboarding/whatsapp/iniciar',{medicoId,modoConexao:'codigo'});conectado=true;await chamar(`/api/onboarding/whatsapp/status?medicoId=${medicoId}`);
  const antes=(await chamar('/api/conta/cadastro/')).body.revisao;
  const reenvio=await upload(medicoId);expect(reenvio.body.ok).toBe(true);
  const depois=(await chamar('/api/conta/cadastro/')).body.revisao;
  expect(depois.trabalhoId).not.toBe(antes.trabalhoId);expect(depois).toMatchObject({aprovado:true,nome,crm:'54321/SC',rqe:'9876',whatsappConectado:true});
  expect((await chamar(`/api/onboarding/status?medicoId=${medicoId}`)).body.status.passos).toMatchObject({passoProfissionalAprovado:true,passo4WhatsappConectado:true});
});


it('pesquisa e aprovação profissionais concluem enquanto a importação ADN ainda aguarda HTTP',async()=>{
  const medicoId=await entrar();
  const responderAdn=fronteiras.adn.getMockImplementation()!;
  let liberar!:()=>void;
  const bloqueio=new Promise<void>(resolve=>{liberar=resolve;});
  let adnIniciado!:()=>void;
  const inicioAdn=new Promise<void>(resolve=>{adnIniciado=resolve;});
  fronteiras.adn.mockImplementationOnce(async(...args)=>{adnIniciado();await bloqueio;return responderAdn(...args);});
  let uploadConcluido=false;
  const envio=upload(medicoId).then(resposta=>{uploadConcluido=true;return resposta;});
  try {
    await inicioAdn;
    expect(uploadConcluido).toBe(false);
    expect(banco.perfil).toBeNull();
    await pesquisarProfissional();
    await aprovar();
    const durante=(await chamar(`/api/onboarding/status?medicoId=${medicoId}`)).body.status;
    expect(durante.passos).toMatchObject({passoProfissionalAprovado:true,passo3CertificadoValido:true,passo2XmlEnviado:false});
    expect(uploadConcluido).toBe(false);
    expect(banco.perfil).toBeNull();
    liberar();
    const certificado=await envio;
    expect(certificado.status).toBe(200);
    expect(certificado.body.importacaoFiscal).toMatchObject({ok:true,fonte:'adn',nsu:2});
    const depois=(await chamar(`/api/onboarding/status?medicoId=${medicoId}`)).body.status;
    expect(depois.passos).toMatchObject({passoProfissionalAprovado:true,passo2XmlEnviado:true});
    expect((await chamar('/api/conta/cadastro/')).body.revisao).toMatchObject({aprovado:true,nome,crm:'54321/SC',rqe:'9876'});
  } finally {
    liberar();
    await envio;
  }
});

it('buscar referência não troca ambiente, numeração nem política já confirmados',async()=>{
  const medicoId=await entrar();await upload(medicoId);
  const referenciaHash=banco.perfil.dados_reforma_tributaria.hash;
  await chamar('/api/onboarding/confirmar-fiscal',{medicoId,usarReferencia:true,referenciaHash});
  const parametros={...banco.servico.parametros_emissao.parametros,ambiente:'homologacao'};
  expect((await chamar('/api/onboarding/confirmar-fiscal',{medicoId,referenciaHash,parametrosEmissao:parametros,serieDps:'7',proximoNumeroDps:3000})).status).toBe(200);
  const antes=JSON.parse(JSON.stringify({perfil:banco.perfil,servico:banco.servico}));
  const busca=await chamar('/api/onboarding/buscar-referencia',{medicoId});
  expect(busca.status).toBe(200);expect(busca.body.adocaoFiscal).toMatchObject({ok:false,codigo:'REVISAO_EXPLICITA_NECESSARIA'});
  expect(banco.perfil).toMatchObject({ambiente:'homologacao',serie_dps:'7',proximo_numero_dps:3000,confirmado_pelo_medico:true});
  expect(banco.servico).toEqual(antes.servico);
});
