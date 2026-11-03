import { createHash } from 'node:crypto';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinksCofre } from '../src/cofre/links.js';
import { cofreIdDaConta } from '../src/cofre/identidade-conta.js';
import { EvolutionApiClient } from '../src/io/evolution/evolution-api-client.js';

const CONTATO = '5551999998888';
const CONTA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEDICO = '11111111-1111-4111-8111-111111111111';
const ORIGEM = 'https://homologacao.example.invalid';

afterEach(() => vi.unstubAllGlobals());

function simularEvolution() {
  const capturas: Array<{url:string; corpo:Record<string,unknown>}> = [];
  const fetchFalso = vi.fn(async (url: string|URL|Request, opcoes?: RequestInit) => {
    expect(opcoes?.method).toBe('POST');
    const corpo=JSON.parse(String(opcoes?.body ?? '{}')) as Record<string,unknown>;
    capturas.push({url:String(url),corpo});
    return new Response(JSON.stringify({key:{id:'3EB0ABCDEFGH9'}}),{
      status:200,headers:{'Content-Type':'application/json'}
    });
  });
  vi.stubGlobal('fetch',fetchFalso);
  const api=new EvolutionApiClient('https://evolution.example.invalid','chave-falsa','oficial','oficial');
  return {api,capturas,fetchFalso};
}

function simularCofreBanco() {
  const consultas:Array<{sql:string;parametros:unknown[]}>=[];
  const consultar=vi.fn(async (sql:string,parametros:unknown[]=[])=>{
    consultas.push({sql,parametros});
    if(sql==='begin' || sql==='commit' || sql==='rollback') return {rows:[]};
    if(sql.startsWith('select id from contas')) return {rows:[{id:CONTA}]};
    if(sql.includes('select telefone from usuarios')) return {rows:[{telefone:CONTATO}]};
    if(sql.includes('count(*)::int as total from cofre_links')) return {rows:[{total:0}]};
    if(sql.includes('select u.ativo, u.telefone from medicos')) return {rows:[{ativo:true,telefone:CONTATO}]};
    if(sql.includes('with referencia as (select clock_timestamp()')) return {rows:[{
      total:0,instante:'2026-11-03T12:00:00.000Z',substitui_valido:false,aguardar_minutos:1
    }]};
    if(sql.includes('insert into cofre_links\n') ||
       sql.includes('insert into cofre_links (medico_id, agenda, token_hash')) {
      return {rows:[{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}]};
    }
    return {rows:[],rowCount:1};
  });
  const cliente={query:consultar,release:vi.fn()};
  const pool={connect:vi.fn().mockResolvedValue(cliente),query:consultar} as unknown as pg.Pool;
  return {pool,consultas};
}

async function exercitarCaminho(tipo:'conta'|'medico') {
  const {api,capturas}=simularEvolution();
  const {pool,consultas}=simularCofreBanco();
  const textoNormal=vi.fn(async (_referencia:string,texto:string,contatoTelefone?:string) => {
    const envio=await api.enviarTexto({
      instanciaNome:'noto-assistente',contatoTelefone:contatoTelefone??CONTATO,texto
    });
    return envio.sucesso?'enviado' as const:'erro' as const;
  });
  const urlSegura=vi.fn(async (params:{
    referenciaCofre:string;url:string;linkId:string;telefone:string
  }) => {
    // Mesmo contrato do callback enviarUrlComRecibo ligado em src/server.ts.
    const envio=await api.enviarTexto({
      instanciaNome:'noto-assistente',contatoTelefone:params.telefone,
      texto:params.url,linkPreview:false
    });
    return envio.sucesso?'enviado' as const:'erro' as const;
  });
  const links=new LinksCofre({
    pool,origem:ORIGEM,
    cofre:{status:vi.fn().mockResolvedValue({estado:'vazio',ativo:false}),
      iniciar:vi.fn().mockResolvedValue({estado:'conectando'})},
    enviar:textoNormal,enviarUrlComRecibo:urlSegura
  });
  const r=tipo==='conta'
    ? await links.solicitarLinkConta(CONTA,'tribemd',CONTATO)
    : await links.solicitarLinkCofre(MEDICO,'tribemd',{contatoTelefone:CONTATO});
  expect(r).toMatchObject({ok:true,motivo:'enviado'});
  expect(textoNormal).toHaveBeenCalledTimes(2);
  expect(urlSegura).toHaveBeenCalledTimes(1);
  expect(urlSegura).toHaveBeenCalledWith(expect.objectContaining({
    referenciaCofre:tipo==='conta'?cofreIdDaConta(CONTA):MEDICO,
    linkId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',telefone:CONTATO
  }));
  expect(capturas).toHaveLength(3);
  expect(capturas.map(c=>c.url)).toEqual(Array(3).fill('https://evolution.example.invalid/message/sendText/noto-assistente'));
  for(const mensagem of capturas.slice(0,2)) {
    expect(Object.keys(mensagem.corpo).sort()).toEqual(['number','text']);
    expect(mensagem.corpo.number).toBe(CONTATO);
    expect(typeof mensagem.corpo.text).toBe('string');
    expect(mensagem.corpo).not.toHaveProperty('linkPreview');
  }
  const ultimo=capturas[2]!.corpo;
  expect(Object.keys(ultimo).sort()).toEqual(['linkPreview','number','text']);
  expect(ultimo.number).toBe(CONTATO);
  expect(ultimo.linkPreview).toBe(false);
  expect(ultimo.texto).toBeUndefined();
  const url=String(ultimo.text);
  expect(url).toMatch(/^https:\/\/homologacao\.example\.invalid\/c\/[A-Za-z0-9_-]{43}$/);
  const token=url.split('/').at(-1)!;
  expect(consultas.some(c=>c.sql.includes('insert into cofre_links') &&
    c.parametros.includes(createHash('sha256').update(token).digest('hex')))).toBe(true);
  // Nenhuma URL/token bruto foi escrita no banco; 15 minutos e regras de dono mantidos.
  expect(JSON.stringify(consultas)).not.toContain(url);
  expect(JSON.stringify(consultas)).not.toContain(token);
  const insercao=consultas.find(c=>/\binsert\s+into\s+cofre_links\s*\(/i.test(c.sql))!;
  expect(insercao.sql).toContain("interval '15 minutes'");
  expect(insercao.sql).toContain(tipo==='conta'?'conta_id,medico_id':'medico_id, agenda');
}

describe('Link seguro: Evolution/Baileys 2.4.0-rc2 — apenas URL sem prévia',()=>{
  it('caminho CONTA: JSON com linkPreview:false apenas no terceiro balão',async()=>{
    await exercitarCaminho('conta');
  });
  it('caminho LEGADO MÉDICO: JSON com linkPreview:false apenas no terceiro balão',async()=>{
    await exercitarCaminho('medico');
  });
  it('demais mensagens mantêm exatamente o corpo {number,text} por padrão',async()=>{
    const {api,capturas}=simularEvolution();
    await api.enviarTexto({instanciaNome:'noto-assistente',contatoTelefone:CONTATO,
      texto:'Olá, podemos continuar?'});
    expect(capturas).toHaveLength(1);
    expect(capturas[0]!.corpo).toEqual({number:CONTATO,text:'Olá, podemos continuar?'});
  });
  it('opção explícita é repassada sem definir um valor global',async()=>{
    const {api,capturas}=simularEvolution();
    await api.enviarTexto({instanciaNome:'noto-assistente',contatoTelefone:CONTATO,
      texto:'https://example.com/',linkPreview:false});
    await api.enviarTexto({instanciaNome:'noto-assistente',contatoTelefone:CONTATO,
      texto:'texto normal'});
    expect(capturas.map(c=>c.corpo)).toEqual([
      {number:CONTATO,text:'https://example.com/',linkPreview:false},
      {number:CONTATO,text:'texto normal'}
    ]);
  });
  it('envio comum de PDF não recebe linkPreview',async()=>{
    const {api,capturas}=simularEvolution();
    const r=await api.enviarPdf({
      instanciaNome:'noto-assistente',contatoTelefone:CONTATO,
      pdfPathOuUrl:'base64-pdf-ficticio',nomeArquivo:'documento.pdf',legenda:'Comprovante'
    });
    expect(r.sucesso).toBe(true);
    expect(capturas[0]?.url).toBe('https://evolution.example.invalid/message/sendMedia/noto-assistente');
    expect(capturas[0]?.corpo).not.toHaveProperty('linkPreview');
  });
});
