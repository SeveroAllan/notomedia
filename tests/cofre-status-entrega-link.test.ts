import { describe,expect,it,vi } from 'vitest';
import { diagnosticarEntregaLink,evoluirEstadoEntrega,hashDestinatario,interpretarEstadoEvolution } from '../src/whatsapp/status-entrega-link.js';
import { registrarAceiteLink,registrarEstadoEvolution,consultarEntregaLink } from '../src/whatsapp/repositorio-entrega-link.js';

const SEGREDO='segredo-de-webhook-isolado-para-testes';
const NUM='5551999998888',INST='assistente-isolado',ID='3EB0ABCDEFGH9';
const evento=(estado:string,numero=NUM,instancia=INST)=>({
  event:'messages.update',instance:instancia,
  data:{keyId:ID,remoteJid:numero+'@s.whatsapp.net',fromMe:true,status:estado}
});
describe('status de URL sensível — sem envio nem HTTP externo',()=>{
  it('SERVER_ACK nao e entrega; atraso nunca e ERROR',()=>{
    const inicio=new Date('2026-11-02T16:00:00Z');
    expect(diagnosticarEntregaLink('ACEITO_API',inicio,new Date('2026-11-02T16:00:01Z'))).toBe('ACEITO_SEM_CONFIRMACAO');
    expect(diagnosticarEntregaLink('SERVER_ACK',inicio,new Date('2026-11-02T16:00:10Z'))).toBe('AGUARDANDO_ENTREGA');
    expect(diagnosticarEntregaLink('SERVER_ACK',inicio,new Date('2026-11-02T16:20:00Z'))).toBe('SEM_CONFIRMACAO');
    expect(diagnosticarEntregaLink('DELIVERY_ACK',inicio,new Date('2026-11-02T16:20:00Z'))).toBe('ENTREGUE');
    expect(diagnosticarEntregaLink('READ',inicio,new Date('2026-11-02T16:20:00Z'))).toBe('LIDO');
    expect(diagnosticarEntregaLink('ERROR',inicio,new Date('2026-11-02T16:20:00Z'))).toBe('ERRO_COMPROVADO');
  });
  it('eventos fora de ordem nao rebaixam entrega nem convertem silencio em erro',()=>{
    expect(evoluirEstadoEntrega('SERVER_ACK','PENDING')).toBe('SERVER_ACK');
    expect(evoluirEstadoEntrega('DELIVERY_ACK','ERROR')).toBe('DELIVERY_ACK');
    expect(evoluirEstadoEntrega('READ','SERVER_ACK')).toBe('READ');
    expect(evoluirEstadoEntrega('ERROR','DELIVERY_ACK')).toBe('DELIVERY_ACK');
  });
  it('identifica so recibos emitidos pela propria instancia e destinatario',()=>{
    expect(interpretarEstadoEvolution(evento('SERVER_ACK'))).toEqual({
      instancia:INST,mensagemId:ID,destinatarios:[NUM],estado:'SERVER_ACK'
    });
    const espelho={...evento('READ'),data:{...evento('READ').data,fromMe:false}};
    expect(interpretarEstadoEvolution(espelho)).toBeNull();
    expect(interpretarEstadoEvolution(evento('DESCONHECIDO'))).toBeNull();
    expect(interpretarEstadoEvolution({event:'messages.upsert',instance:INST,data:{}})).toBeNull();
    expect(interpretarEstadoEvolution({...evento('READ'),data:{...evento('READ').data,remoteJid:'abc@lid'}})).toBeNull();
  });
  it('nao grava URL, token, telefone ou corpo na correlacao; fonte e aceite HTTP',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[]});
    await registrarAceiteLink({query} as any,{
      linkId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',instancia:INST,
      mensagemId:ID,telefone:NUM,segredo:SEGREDO
    });
    const [sql,parametros]=query.mock.calls[0] as unknown as [string,unknown[]];
    expect(sql).toContain('cofre_links_entregas');
    expect(JSON.stringify(parametros)).not.toContain(NUM);
    expect(JSON.stringify(parametros)).not.toContain('https://');
    expect(parametros[3]).toBe(hashDestinatario(SEGREDO,NUM));
  });
  it('ACK de outra instancia ou outro destinatario nunca atualiza a conta',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{link_id:'id'}]});
    expect(await registrarEstadoEvolution({query} as any,evento('READ',NUM,'outra'),INST,SEGREDO)).toBe(false);
    expect(query).not.toHaveBeenCalled();
    await registrarEstadoEvolution({query} as any,evento('SERVER_ACK'),INST,SEGREDO);
    const [sql,params]=query.mock.calls[0] as unknown as [string,unknown[]];
    expect(sql).toContain('update public.cofre_links_entregas');
    expect(sql).toContain('destino_hash=ANY');
    expect(params[0]).toBe(INST);
    expect(params[1]).toBe(ID);
    expect(params[2]).toContain(hashDestinatario(SEGREDO,NUM));
    expect(params[3]).toBe('SERVER_ACK');
  });
  it('consulta limita-se à conta autenticada, sem dados da URL ou da outra conta',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{
      estado:'SERVER_ACK',aceito_em:'2026-11-02T16:00:00Z',mensagem_id:ID
    }]});
    const resultado=await consultarEntregaLink({query} as any,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','tribemd',new Date('2026-11-02T16:03:00Z'));
    expect(resultado).toMatchObject({estado:'SEM_CONFIRMACAO',comId:true});
    const [sql,params]=query.mock.calls[0] as unknown as [string,unknown[]];
    expect(sql).toContain('l.conta_id=$1');
    expect(sql).toContain('m.conta_id=$1');
    expect(params[0]).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(JSON.stringify(resultado)).not.toContain(ID);
  });
});
