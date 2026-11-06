import {describe,it,expect,vi} from 'vitest';
import {completarChatCompativel} from '../src/io/nvidia/chat-client.js';

describe('uso monetário da extração CRM/RQE, sem chamada real ao provedor',()=>{
  it('recolhe prompt_tokens e completion_tokens da resposta HTTP',async()=>{
    const original=globalThis.fetch;
    const fetchFalso=vi.fn().mockResolvedValue(new Response(JSON.stringify({
      usage:{prompt_tokens:4178,completion_tokens:503,total_tokens:4681},
      choices:[{finish_reason:'stop',message:{content:'{"registros":[]}'}}]
    }),{status:200,headers:{'content-type':'application/json'}}));
    globalThis.fetch=fetchFalso;
    try{
      const uso=vi.fn();
      const texto=await completarChatCompativel({
        baseUrl:'https://test.invalid/v1',apiKey:'nao-real'
      },'gpt-4o-mini',[{role:'user',content:'consulta simulada'}],{
        maxTokens:2048,tentativasMax:1,aoUso:uso,formatoJson:true
      });
      expect(texto).toBe('{"registros":[]}');
      expect(uso).toHaveBeenCalledExactlyOnceWith({entrada:4178,saida:503});
      expect(fetchFalso).toHaveBeenCalledOnce();
      const init=fetchFalso.mock.calls[0]![1] as RequestInit;
      const requisicao=JSON.parse(String(init.body));
      expect(requisicao).toMatchObject({model:'gpt-4o-mini',max_tokens:2048,stream:false});
    }finally{globalThis.fetch=original;}
  });
  it('resposta sem usage não inventa custo zero',async()=>{
    const original=globalThis.fetch;
    globalThis.fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices:[{finish_reason:'stop',message:{content:'{"registros":[]}'}}]
    }),{status:200,headers:{'content-type':'application/json'}}));
    try{
      const uso=vi.fn();
      await completarChatCompativel({baseUrl:'https://test.invalid/v1',apiKey:'nao-real'},
        'gpt-4o-mini',[{role:'user',content:'teste'}],{tentativasMax:1,aoUso:uso});
      expect(uso).toHaveBeenCalledExactlyOnceWith(null);
    }finally{globalThis.fetch=original;}
  });
});
