import {describe,it,expect} from 'vitest';
import {responderAgente} from '../src/agente/agente.js';
import type {Model} from '@openai/agents';
import {PausaCustoPiloto} from '../src/agente/limite-gasto-rodada.js';

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
  it('erro de limite propagado pelo Runner vira aviso específico e não fallback genérico',async()=>{
    const modelo={
      getResponse:async()=>{throw new PausaCustoPiloto('LIMITE_TESTE');},
      getStreamedResponse:()=>{throw Error('stream nao permitido');}
    } as Model;
    const resposta=await responderAgente({
      texto:'Pode procurar CRM e RQE agora?',
      profissionais:[],
    },{
      modeloTeste:modelo,
      consultarStatus:async()=>({
        tribemd:{salvo:false,conectada:false},
        amplimed:{salvo:false,conectada:false}
      })
    });
    expect(resposta).toContain('US$ 1');
    expect(resposta).not.toMatch(/Não consegui continuar esta etapa|consulta agora/i);
  });
});
