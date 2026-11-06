import {describe,it,expect} from 'vitest';
import {responderAgente} from '../src/agente/agente.js';

describe('piloto de leitura sem ledger de escrita',()=>{
  it('não executa IA paga quando DSN read-only não consegue reservar orçamento',async()=>{
    const resultado=await responderAgente({
      texto:'Quero conectar minha agenda',
      profissionais:[],
    },{
      apiKey:'chave-ficticia-de-teste',
      modeloNome:'gpt-4o-mini',
      exigirControleCusto:true,
      consultarStatus:async()=>({
        tribemd:{salvo:false,conectada:false},
        amplimed:{salvo:false,conectada:false}
      })
    });
    expect(resultado).toMatch(/pausados|controle de gastos/);
    expect(resultado).toContain('Não fiz chamadas pagas');
  });
});
