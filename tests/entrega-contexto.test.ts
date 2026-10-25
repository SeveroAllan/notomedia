import { expect, it, vi } from 'vitest';
import type pg from 'pg';
import { carregarConfig } from '../src/config.js';
import { ComunicacaoHomologacao } from '../src/whatsapp/comunicacao-homologacao.js';
import type { EnviarPdfDanfseParams } from '../src/whatsapp/enviar-pdf-danfse.js';

const medico='11111111-1111-4111-8111-111111111111';
const solicitacao='22222222-2222-4222-8222-222222222222';
const notaId='33333333-3333-4333-8333-333333333333';

function cenario() {
  const reservas=new Set<string>();
  const contextos:Array<{conversa:string;mensagemId:string;texto:string}>=[];
  const enviarPdf=vi.fn(async (_p:EnviarPdfDanfseParams)=>({sucesso:true}));
  const query=vi.fn(async(sql:string,p:any[]=[])=>{
    if(sql.includes('select sn.id as solicitacao_id')) {
      const data=p[1];
      return {rows:data==='20/10/2026'?[{solicitacao_id:solicitacao}]:[]};
    }
    if(sql.includes('select nf.id as nota_fiscal_id')) return {rows:[{
      nota_fiscal_id:notaId,pdf_storage_path:'data:application/pdf;base64,cGRm',ndps:42,valor_servicos_centavos:25000,
      origem:'manual',datas_consulta_texto:'20/10/2026',paciente_nome:'Paciente Teste',
      telefone_medico:'5511999990000',contato_telefone:null,ambiente:'homologacao',
      nome_instancia:null,instancia_medico_id:null,instancia_status:null
    }]};
    if(sql.includes('insert into public.noto_envios_homologacao')) {
      const k=JSON.stringify(p.slice(0,3));if(reservas.has(k))return {rows:[]};reservas.add(k);return {rows:[{id:'envio-1'}]};
    }
    if(sql.includes('update public.noto_envios_homologacao'))return {rows:[]};
    if(sql.includes('insert into conversa_mensagens')) {
      contextos.push({conversa:p[1],mensagemId:p[2],texto:p[3]});return {rows:[{id:'ctx'}]};
    }
    throw Error('SQL_NAO_MODELADO '+sql);
  });
  const permissoes={ler:vi.fn(async()=>({valor:'so_medico'}))};
  const comunicacao=new ComunicacaoHomologacao(
    {query} as unknown as pg.Pool,
    {...carregarConfig({}),envioMedicoRealAtivo:true,envioRealAllowlist:['5511999990000']},
    {enviarTexto:vi.fn(),enviarPdf},
    vi.fn(),
    permissoes as any
  );
  return {comunicacao,enviarPdf,query,contextos};
}

it('nota nova autorizada continua pelo fluxo normal e fica registrada como nota_nova',async()=>{
  const c=cenario();
  expect(await c.comunicacao.paciente({medicoId:medico,solicitacaoId:solicitacao},{enviarPdf:c.enviarPdf})).toBe('enviado');
  expect(c.enviarPdf).toHaveBeenCalledTimes(1);
  expect(c.contextos).toHaveLength(1);
  expect(JSON.parse(c.contextos[0]!.texto)).toMatchObject({notaFiscalId:notaId,destino:'medico',origem:'nota_nova',resultado:'enviado'});
});

it('pedido histórico envia somente a data pedida e a mesma chave não repete PDF',async()=>{
  const c=cenario();
  expect(await c.comunicacao.reenviarNotaMedico(medico,{enviarPdf:c.enviarPdf},'2026-10-20','pedido-20')).toBe('enviado');
  expect(await c.comunicacao.reenviarNotaMedico(medico,{enviarPdf:c.enviarPdf},'2026-10-20','pedido-20')).toBe('repetido');
  expect(await c.comunicacao.reenviarNotaMedico(medico,{enviarPdf:c.enviarPdf},'2026-10-21','pedido-21')).toBe('ausente');
  expect(c.enviarPdf).toHaveBeenCalledTimes(1);
  expect(c.query.mock.calls.filter(([sql])=>String(sql).includes('select sn.id as solicitacao_id')).map(call=>call[1]?.[1])).toEqual(['20/10/2026','20/10/2026','21/10/2026']);
  expect(c.contextos.map(x=>JSON.parse(x.texto).resultado)).toEqual(['enviado','repetido']);
});

it('resultado do PDF histórico fica registrado com nota, destino, momento e sucesso',async()=>{
  const c=cenario();
  await c.comunicacao.reenviarNotaMedico(medico,{enviarPdf:c.enviarPdf},'2026-10-20','pedido-contexto');
  expect(c.contextos).toHaveLength(1);
  expect(c.contextos[0]!.mensagemId).toMatch(/^contexto:entrega_nota:/);
  const e=JSON.parse(c.contextos[0]!.texto);
  expect(e).toMatchObject({notaFiscalId:notaId,solicitacaoId:solicitacao,ndps:42,paciente:'Paciente Teste',datasConsulta:'20/10/2026',valorCentavos:25000,destino:'medico',origem:'pedido_historico',resultado:'enviado'});
  expect(new Date(e.registradaEm).toString()).not.toBe('Invalid Date');
});
