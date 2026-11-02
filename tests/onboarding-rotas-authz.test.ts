import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { criarAppExpress } from '../src/server.js';
import { SupabaseAuthAdminService } from '../src/io/supabase/supabase-auth-admin-service.js';
import { PostgresDadosProfissionaisService } from '../src/io/postgres/postgres-dados-profissionais-service.js';

const borda = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
const efeito = vi.hoisted(() => ({
  confirmar: vi.fn(), perfil: vi.fn(), certificado: vi.fn(),
  carregarCertificado: vi.fn(), processarXml: vi.fn(),
  consentir: vi.fn(), adotar: vi.fn(), consultarAdn: vi.fn()
}));
vi.mock('../src/io/postgres/pool.js', () => ({ pool: borda }));
vi.mock('../src/cofre/router.js', async () => {
  const express = await import('express');
  return { criarCofreContas: () => ({ app: express.default(), encerrar: async () => {} }) };
});
vi.mock('../src/onboarding/fluxos/confirmar-parametros-fiscais.js', () => ({ confirmarParametrosFiscais: efeito.confirmar }));
vi.mock('../src/io/postgres/salvar-perfil-profissional.js', () => ({
  salvarPerfilProfissional: efeito.perfil, ErroPerfilProfissional: class extends Error {}
}));
vi.mock('../src/onboarding/fluxos/salvar-certificado-medico.js', () => ({ salvarCertificadoMedico: efeito.certificado }));
vi.mock('../src/io/fiscal/carregar-certificado-medico.js', () => ({ carregarCertificadoMedico: efeito.carregarCertificado }));
vi.mock('../src/io/fiscal/extrair-chaves-certificado.js', () => ({
  extrairChavesCertificado: () => ({ documentoTitular: '12345678901', validoAte: new Date('2030-01-01') })
}));
vi.mock('../src/onboarding/fluxos/processar-onboarding-xml.js', () => ({ processarOnboardingXml: efeito.processarXml }));
vi.mock('../src/onboarding/fluxos/consentimento-fiscal.js', () => ({
  versaoConsentimentoFiscal: 'consentimento-teste',
  registrarConsentimentoFiscal: efeito.consentir, adotarReferenciaConsentida: efeito.adotar
}));
vi.mock('../src/io/fiscal/adn-nfse-client.js', () => ({
  AdnNfseClient: class {
    buscarNfseMaisRecente = efeito.consultarAdn;
  }
}));

const MEDICO = '11111111-1111-4111-8111-111111111111';
const USUARIO = '22222222-2222-4222-8222-222222222222';
const OUTRO = '33333333-3333-4333-8333-333333333333';
const AUTH = '44444444-4444-4444-8444-444444444444';
const CHAMADAS = [
  { rota: '/api/onboarding/confirmar-fiscal', body: { medicoId: MEDICO, usarReferencia: true, referenciaHash: 'a'.repeat(64) } },
  { rota: '/api/onboarding/certificado', body: { medicoId: MEDICO, arquivoBase64: 'Y2VydA==', senha: 'segredo' } },
  { rota: '/api/onboarding/nome', body: { medicoId: MEDICO, usuarioId: USUARIO, nome: 'Alice Souza' } },
  { rota: '/api/conta/perfil', body: { medicoId: MEDICO, usuarioId: USUARIO, crm: '12345' } },
  { rota: '/api/conta/preferencias', body: { medicoId: MEDICO, usuarioId: USUARIO, solicitarCpfDiretoPaciente: true } },
  { rota: '/api/onboarding/buscar-referencia', body: { medicoId: MEDICO } },
  { rota: '/api/onboarding/xml', body: { medicoId: MEDICO, xmlString: '<NFSe/>' } }
];
const getUser=vi.fn();
let sql: string[]=[];
let vinculo=true;
let medicoUsuarioId: string|null=USUARIO;
beforeEach(() => {
  vi.clearAllMocks(); sql=[]; vinculo=true; medicoUsuarioId=USUARIO;
  vi.spyOn(SupabaseAuthAdminService.prototype, 'supabaseClient', 'get')
    .mockReturnValue({ auth: { getUser } } as never);
  getUser.mockImplementation(async (token:string) => token === 'valido'
    ? { data: { user: { id: AUTH } }, error: null }
    : { data: { user: null }, error: { message: 'invalid' } });
  borda.query.mockImplementation(async (query:string, params:unknown[]=[]) => {
    const q=query.replace(/\s+/g,' ').trim().toLowerCase(); sql.push(q);
    if (q.includes('join medicos m on m.conta_id = u.conta_id')) {
      expect(params[0]).toBe(AUTH);
      if (!vinculo || params[1] === OUTRO) return { rows: [], rowCount:0 };
      if (params[1] !== MEDICO && params[1] !== USUARIO) return { rows:[],rowCount:0 };
      return { rows: [{ medico_id:MEDICO, medico_usuario_id:medicoUsuarioId, usuario_id:USUARIO }],rowCount:1 };
    }
    if (q.startsWith('update medicos set solicitar_cpf')) return {
      rows:[{id:MEDICO,solicitar_cpf_direto_paciente:true}],rowCount:1
    };
    if (q.startsWith('update medicos set nome_completo') || q.startsWith('update usuarios set nome')) return {rows:[],rowCount:1};
    throw Error('SQL imprevisto no teste de autorização: '+q);
  });
  borda.connect.mockImplementation(() => { throw Error('ESCRITA_INESPERADA'); });
  efeito.confirmar.mockResolvedValue(undefined);
  efeito.perfil.mockResolvedValue({medicoId:MEDICO,crm:'12345'});
  efeito.certificado.mockResolvedValue({ok:true,certificadoId:'certificado-teste'});
  efeito.carregarCertificado.mockResolvedValue({pfxBuffer:Buffer.from('teste'),senhaCertificado:'senha'});
  efeito.processarXml.mockResolvedValue({ok:true,parametros:{dadosReformaTributaria:{hash:'a'.repeat(64)}}});
  efeito.adotar.mockResolvedValue({ok:true});
  efeito.consultarAdn.mockResolvedValue({resumo:'teste',documento:{xml:'<NFSe/>',nsu:'123',chaveAcesso:'abc'}});
  vi.spyOn(PostgresDadosProfissionaisService.prototype,'retomar').mockResolvedValue(0);
});
afterEach(() => vi.restoreAllMocks());

async function servidor(acao:(postar:(rota:string,body:unknown,token?:string)=>Promise<{status:number;json:any}>)=>Promise<void>) {
  const server=createServer(criarAppExpress());
  await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));
  const porta=(server.address() as AddressInfo).port;
  const postar=async (rota:string,body:unknown,token?:string) => {
    const headers:Record<string,string>={ 'Content-Type':'application/json' };
    if(token!==undefined)headers.Authorization='Bearer '+token;
    const r=await fetch(`http://127.0.0.1:${porta}${rota}`,
      {method:'POST',headers,body:JSON.stringify(body)});
    return {status:r.status,json:await r.json()};
  };
  try { await acao(postar); }
  finally { await new Promise<void>((ok,erro)=>server.close(e=>e?erro(e):ok())); }
}
function semEscritas() {
  expect(sql.every(q=>q.startsWith('select '))).toBe(true);
  expect(borda.connect).not.toHaveBeenCalled();
  for(const f of [efeito.confirmar,efeito.perfil,efeito.certificado,efeito.carregarCertificado,
    efeito.processarXml,efeito.consentir,efeito.adotar,efeito.consultarAdn])expect(f).not.toHaveBeenCalled();
}

describe('sete rotas: sessão Supabase e vínculo de conta antes de qualquer efeito', () => {
  it.each(CHAMADAS)('sem Bearer recusa $rota sem consultar banco ou alterar dados',async ({rota,body})=>{
    await servidor(async postar => {
      const r=await postar(rota,body);
      expect(r).toMatchObject({status:401,json:{ok:false}});
    });
    expect(sql).toEqual([]);semEscritas();expect(getUser).not.toHaveBeenCalled();
  });
  it.each(CHAMADAS)('token inválido recusa $rota sem SQL ou escrita',async ({rota,body})=>{
    await servidor(async postar=>{
      const r=await postar(rota,body,'invalido');
      expect(r).toMatchObject({status:401,json:{ok:false}});
    });
    expect(sql).toEqual([]);semEscritas();
  });
  it.each(CHAMADAS)('outra conta recusa $rota sem criar médico nem alterar dados',async ({rota,body})=>{
    await servidor(async postar=>{
      const r=await postar(rota,{...body,medicoId:OUTRO},'valido');
      expect(r).toMatchObject({status:403,json:{ok:false}});
    });
    expect(sql).toHaveLength(1);semEscritas();
  });
  it('não aceita usuarioId forjado, corpo sem identidade ou token no body como sessão', async () => {
    await servidor(async postar=>{
      expect((await postar('/api/conta/perfil',{medicoId:MEDICO,usuarioId:OUTRO,nome:'Invasor'},'valido')).status).toBe(403);
      expect((await postar('/api/onboarding/nome',{nome:'Invasor',tokenAcesso:'valido'})).status).toBe(401);
      expect((await postar('/api/onboarding/certificado',{medicoId:OUTRO,arquivoBase64:'YQ==',senha:'segredo'},'valido')).status).toBe(403);
    });
    semEscritas();
  });
  it('sessão e médico legítimos permitem as sete rotas e usam o ID resolvido do servidor', async () => {
    await servidor(async postar => {
      for(const {rota,body} of CHAMADAS) {
        const r=await postar(rota,body,'valido');
        expect(r.status,rota).toBe(200);
        expect(r.json.ok,rota).not.toBe(false);
      }
    });
    expect(efeito.confirmar).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({medicoId:MEDICO}));
    expect(efeito.certificado).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.objectContaining({medicoId:MEDICO}));
    expect(efeito.perfil).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({medicoId:MEDICO,usuarioId:USUARIO}));
    expect(sql.some(q=>q.startsWith('update usuarios set nome'))).toBe(true);
    expect(sql.filter(q=>q.includes('join medicos m on m.conta_id = u.conta_id'))).toHaveLength(7);
  });
  it('usuarioId próprio é compatível com a jornada sem criação automática',async()=>{
    await servidor(async postar=>{
      const r=await postar('/api/onboarding/nome',{usuarioId:USUARIO,nome:'Alice Souza'},'valido');
      expect(r.status).toBe(200);expect(r.json.medicoId).toBe(MEDICO);
    });
    expect(sql.some(q=>q.startsWith('insert '))).toBe(false);
  });
  it('delegado pode alterar dados médicos sem mudar email ou identidade do dono',async()=>{
    medicoUsuarioId=null;
    await servidor(async postar=>{
      expect((await postar('/api/conta/perfil',{medicoId:MEDICO,crm:'12345'},'valido')).status).toBe(200);
      expect((await postar('/api/conta/perfil',{medicoId:MEDICO,email:'outro@teste.com'},'valido')).status).toBe(403);
    });
    expect(efeito.perfil).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({
      medicoId:MEDICO,atualizarUsuarioVinculado:false
    }));
    expect(efeito.perfil).toHaveBeenCalledTimes(1);
    expect(sql.every(q=>!q.startsWith('update usuarios'))).toBe(true);
  });
});
