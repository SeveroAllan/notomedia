import {describe,expect,it,vi} from 'vitest';
import type pg from 'pg';
import {ScriptedModel,assistantMessage} from '@openai/agents/testing';
import {continuarEventoComNoto,validarFalaEvento} from '../src/agente/continuar-evento.js';
import {notificarResultadoPendente} from '../src/agente/worker-trabalhos.js';

const conta='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const telefone='5551999998888';
const instancia='notomed_assistente';
const db=(query:ReturnType<typeof vi.fn>)=>({query} as unknown as pg.Pool);

describe('harness: retomada por evento do sistema',()=>{
  it('preserva o comprovante e recusa acréscimos de emissão, CRM ou entrega',()=>{
    const comprovado='Encontrei Ana Silva na agenda. Você confirma o vínculo?';
    expect(validarFalaEvento(comprovado,comprovado)).toBe(comprovado);
    expect(validarFalaEvento('Conferi. '+comprovado,comprovado)).toBe('Conferi. '+comprovado);
    expect(validarFalaEvento('Emiti a nota. '+comprovado,comprovado)).toBeNull();
    expect(validarFalaEvento(comprovado+' Já vinculei a médica.',comprovado)).toBeNull();
    expect(validarFalaEvento('CRM 1234. '+comprovado,comprovado)).toBeNull();
    expect(validarFalaEvento('A'.repeat(80)+' '+comprovado,comprovado)).toBeNull();
  });

  it('recupera estado persistido e reativa o agente sem simular mensagem ou consentimento',async()=>{
    const comprovado='A leitura terminou. Precisamos confirmar quais profissionais pertencem à conta.';
    const modelo=new ScriptedModel([[assistantMessage(comprovado)]]);
    const query=vi.fn()
      .mockResolvedValueOnce({rows:[{id:'medico-1',nome_completo:'Dra. Ana Silva'}]})
      .mockResolvedValueOnce({rows:[{estado:{agendaEscolhida:'tribemd',faseAgenda:'CONFIRMACAO_PENDENTE',
        descoberta:{agenda:'tribemd',nomes:['Dra. Ana Silva']}}}]});
    const consultarStatus=vi.fn();
    const resultado=await continuarEventoComNoto({
      tipo:'descoberta_agenda',contaId:conta,textoComprovado:comprovado
    },{pool:db(query),modeloTeste:modelo,consultarStatus});
    expect(resultado).toBe(comprovado);
    expect(query).toHaveBeenCalledTimes(2);
    expect(consultarStatus).not.toHaveBeenCalled();
    const entrada=JSON.stringify(modelo.calls[0]?.request.input);
    expect(entrada).toContain('eventoSistema');
    expect(entrada).toContain('naoEAutorizacao');
    expect(entrada).toContain('CONFIRMACAO_PENDENTE');
    modelo.assertComplete();
  });

  it('se o modelo diverge da prova, a continuação não pode substituir o aviso seguro',async()=>{
    const comprovado='A leitura ainda não confirmou os nomes dos profissionais.';
    const modelo=new ScriptedModel([[assistantMessage('Já vinculei a médica e emiti todas as notas.')]]);
    const query=vi.fn().mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{estado:{}}]});
    expect(await continuarEventoComNoto({
      tipo:'descoberta_agenda',contaId:conta,textoComprovado:comprovado
    },{pool:db(query),modeloTeste:modelo,consultarStatus:vi.fn()})).toBeNull();
    modelo.assertComplete();
  });

  it('não chama a IA sem controle de custo exigido',async()=>{
    const query=vi.fn();
    expect(await continuarEventoComNoto({
      tipo:'descoberta_agenda',contaId:conta,textoComprovado:'Resultado verificado.'
    },{pool:db(query),apiKey:'teste',exigirControleCusto:true,consultarStatus:vi.fn()})).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('worker só reativa o agente após autorização e persistência comprovada',async()=>{
    const job={id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',contaId:conta,
      instancia,telefone,tipo:'descoberta_agenda' as const,agenda:'tribemd' as const,
      medicoId:null,mensagemId:'WA-12345',tentativas:1,estado:'notificando' as const,
      resultado:{ok:true,nomes:['Dra. Ana Silva'],agenda:'tribemd'}};
    const query=vi.fn()
      .mockResolvedValueOnce({rows:[{
        id:job.id,conta_id:conta,instancia,mensagem_id:job.mensagemId,
        telefone_destino:telefone,tipo:job.tipo,agenda:job.agenda,medico_id:null,
        estado:job.estado,tentativas:1,resultado:job.resultado
      }]})
      .mockResolvedValueOnce({rows:[{existe:1}]})
      .mockResolvedValueOnce({rows:[{conta_id:conta}],rowCount:1})
      .mockResolvedValueOnce({rows:[],rowCount:1});
    const enviar=vi.fn().mockResolvedValue(true);
    const continuarEvento=vi.fn(async (e:{textoComprovado:string})=>e.textoComprovado);
    expect(await notificarResultadoPendente({
      pool:db(query),instancia,descobrir:vi.fn(),conferir:vi.fn(),
      enviar,continuarEvento
    })).toBe(true);
    expect(continuarEvento).toHaveBeenCalledOnce();
    expect(continuarEvento.mock.calls[0]![0]).toMatchObject({
      contaId:conta,tipo:'descoberta_agenda'
    });
    expect(enviar).toHaveBeenCalledOnce();
    expect(enviar.mock.calls[0]![1]).toContain('Dra. Ana Silva');
    expect(query.mock.calls.at(-1)![1]).toEqual([job.id,'aceito_api']);
  });

  it('não reativa o agente se o resultado autenticado não pôde ser persistido',async()=>{
    const query=vi.fn()
      .mockResolvedValueOnce({rows:[{
        id:'job',conta_id:conta,instancia,mensagem_id:'WA-1',telefone_destino:telefone,
        tipo:'descoberta_agenda',agenda:'tribemd',medico_id:null,estado:'notificando',tentativas:1,
        resultado:{ok:true,nomes:['Dra. Ana Silva'],agenda:'tribemd'}
      }]})
      .mockResolvedValueOnce({rows:[{existe:1}]})
      .mockResolvedValueOnce({rows:[],rowCount:0})
      .mockResolvedValueOnce({rows:[],rowCount:1});
    const continuarEvento=vi.fn(),enviar=vi.fn().mockResolvedValue(true);
    expect(await notificarResultadoPendente({
      pool:db(query),instancia,descobrir:vi.fn(),conferir:vi.fn(),enviar,continuarEvento
    })).toBe(true);
    expect(continuarEvento).not.toHaveBeenCalled();
    expect(String(enviar.mock.calls[0]![1])).not.toContain('Dra. Ana Silva');
  });
});
