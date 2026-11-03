import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import { responderAgente } from '../src/agente/agente.js';
import {
  enfileirarTrabalhoNoto, listarTrabalhosNoto, concluirLeituraNoto,
  reservarTrabalhoNoto, reservarNotificacaoNoto
} from '../src/agente/trabalhos-duraveis.js';
import { executarLeituraPendente, notificarResultadoPendente } from '../src/agente/worker-trabalhos.js';

const CONTA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TELEFONE='5551999998888';
const pedido = {
  contaId:CONTA,instancia:'notomed_assistente',mensagemId:'WA-12345',
  telefone:TELEFONE,tipo:'descoberta_agenda' as const,agenda:'tribemd' as const,medicoId:null
};
const trabalho = {
  id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  conta_id:CONTA,instancia:'notomed_assistente',mensagem_id:'WA-12345',
  telefone_destino:TELEFONE,tipo:'descoberta_agenda',agenda:'tribemd',medico_id:null,
  estado:'executando',tentativas:1
};
const db=(query:ReturnType<typeof vi.fn>)=>({query} as unknown as pg.Pool);

describe('fila de trabalhos longos: autorização, evidência e idempotência',()=>{
  it('enfileira sem navegador, somente a partir de conta e usuário ativo',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{id:'job'}]});
    expect(await enfileirarTrabalhoNoto(db(query),pedido)).toEqual({ok:true,estado:'iniciado'});
    expect(query).toHaveBeenCalledOnce();
    const [sql,parametros]=query.mock.calls[0]!;
    expect(String(sql)).toContain('u.auth_user_id is not null');
    expect(String(sql)).toContain('u.conta_id=$1');
    expect(String(sql)).toContain('m.conta_id=$1');
    expect(String(sql)).toContain('on conflict do nothing');
    expect(parametros.slice(0,7)).toEqual([CONTA,'notomed_assistente','WA-12345',
      TELEFONE,'descoberta_agenda','tribemd',null]);
    expect(String(sql)).not.toMatch(/pacientes|cpf|senha|token/);
  });
  it('webhook duplicado identifica tarefa ativa sem abrir outro navegador',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{1:1}]});
    expect(await enfileirarTrabalhoNoto(db(query),pedido))
      .toEqual({ok:true,estado:'ja_em_andamento'});
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]![0]).toContain("estado in ('pendente','executando'");
  });
  it('sem autorização ou banco retorna falha; nunca promete execução',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[]});
    expect(await enfileirarTrabalhoNoto(db(query),pedido))
      .toEqual({ok:false,motivo:'SEM_AUTORIZACAO'});
    query.mockRejectedValue(new Error('relation does not exist'));
    expect(await enfileirarTrabalhoNoto(db(query),pedido))
      .toEqual({ok:false,motivo:'FILA_INDISPONIVEL'});
  });
  it('estado consultado não expõe telefone, contas ou IDs ao modelo',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{tipo:'descoberta_agenda',agenda:'tribemd',estado:'executando',
      telefone_destino:TELEFONE,conta_id:CONTA}]});
    expect(await listarTrabalhosNoto(db(query),CONTA,TELEFONE,'notomed_assistente'))
      .toEqual([{tipo:'descoberta_agenda',agenda:'tribemd',estado:'executando'}]);
    expect(query.mock.calls[0]![1]).toEqual([CONTA,TELEFONE,'notomed_assistente']);
  });
  it('reserva com lease, SKIP LOCKED e mantém resultado antes de enviar mensagem',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[trabalho]})
      .mockResolvedValueOnce({rows:[{id:trabalho.id}]})
      .mockResolvedValueOnce({rows:[{...trabalho,estado:'notificando',resultado:{ok:true,nomes:['Dra. Alice Silva']}}]});
    const pool=db(query);
    const job=await reservarTrabalhoNoto(pool,'executor-1');
    expect(job).toMatchObject({contaId:CONTA,telefone:TELEFONE,tipo:'descoberta_agenda'});
    expect(query.mock.calls[0]![0]).toContain('for update skip locked');
    expect(query.mock.calls[0]![0]).toContain("interval '4 minutes'");
    expect(await concluirLeituraNoto(pool,trabalho.id,'executor-1',{ok:true,nomes:['Dra. Alice Silva']})).toBe(true);
    expect(query.mock.calls[1]![0]).toContain("estado='resultado_pronto'");
    const r=await reservarNotificacaoNoto(pool);
    expect(r).toMatchObject({estado:'notificando',resultado:{ok:true,nomes:['Dra. Alice Silva']}});
    expect(query.mock.calls[2]![0]).toContain("estado='notificando'");
  });
});

describe('agente mantém a conversa e delega navegação longa',()=>{
  it('enfileira a descoberta sem esperar o portal nem inventar nomes',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('descobrir_profissionais_agenda',{agenda:'tribemd',profissional:null},{callId:'ler'})],
      [assistantMessage('Conferi e encontrei todos os profissionais.')]
    ]);
    const solicitarTrabalho=vi.fn().mockResolvedValue({ok:true,estado:'iniciado'});
    const descobrirProfissionais=vi.fn(() => new Promise<never>(()=>{}));
    const resposta=await responderAgente({texto:'Quero identificar médicos da TribeMD',
      profissionais:[],estadoConversa:{agendaEscolhida:'tribemd'}},{
      modeloTeste:modelo,
      referenciaContaAgenda:vi.fn().mockResolvedValue('conta_'+CONTA),
      consultarStatus:vi.fn().mockResolvedValue({
        tribemd:{salvo:true,conectada:true},amplimed:{salvo:false,conectada:false}
      }),
      solicitarTrabalho,descobrirProfissionais
    });
    expect(solicitarTrabalho).toHaveBeenCalledExactlyOnceWith('descoberta_agenda','tribemd',null);
    expect(descobrirProfissionais).not.toHaveBeenCalled();
    expect(resposta).toContain('Comecei a conferir a TribeMD');
    expect(resposta).not.toContain('todos os profissionais');
    modelo.assertComplete();
  });
  it('saudação não é substituída pelo velho status de entrega do link',async()=>{
    const modelo=new ScriptedModel([[assistantMessage('Opa! Como posso te ajudar hoje?')]]);
    const resposta=await responderAgente({
      texto:'Opa 😎',profissionais:[],
      estadoConversa:{faseAgenda:'DESCOBERTA_PENDENTE',agendaEscolhida:'tribemd'},
      situacaoUltimoLink:{agenda:'tribemd',estado:'ACEITO_API'}
    },{modeloTeste:modelo,consultarStatus:vi.fn()});
    expect(resposta).toBe('Opa! Como posso te ajudar hoje?');
    expect(resposta).not.toContain('link');
    modelo.assertComplete();
  });
  it('trabalhos ativos informam o contexto sem revelar telefone ou conta',async()=>{
    const modelo=new ScriptedModel([[assistantMessage('Estou aqui. Pode mandar.')]]); 
    await responderAgente({texto:'Opa',profissionais:[],
      trabalhos:[{tipo:'descoberta_agenda',agenda:'tribemd',estado:'executando'}]
    },{modeloTeste:modelo,consultarStatus:vi.fn()});
    const msg=JSON.stringify(modelo.calls[0]?.request.input);
    expect(msg).toContain('trabalhosEmAndamento');
    expect(msg).toContain('executando');
    expect(msg).not.toContain(CONTA);
    expect(msg).not.toContain(TELEFONE);
    modelo.assertComplete();
  });
});

describe('worker retoma o resultado sem resposta genérica ou envio duplicado',()=>{
  it('navegador demora, mas a tarefa fica em execução fora do turno e depois persiste nomes',async()=>{
    let terminar!: (value:{ok:boolean;nomes:string[]})=>void;
    const leitura=new Promise<{ok:boolean;nomes:string[]}>(r=>{terminar=r});
    const query=vi.fn().mockResolvedValueOnce({rows:[trabalho]})
      .mockResolvedValueOnce({rows:[{id:trabalho.id}]});
    const deps={
      pool:db(query),instancia:'notomed_assistente',
      descobrir:vi.fn(()=>leitura),
      conferir:vi.fn(),
      enviar:vi.fn()
    };
    const emCurso=executarLeituraPendente(deps,'executor-1');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(deps.descobrir).toHaveBeenCalledOnce();
    expect(query.mock.calls.filter(c=>String(c[0]).includes("resultado_pronto"))).toHaveLength(0);
    terminar({ok:true,nomes:['Dra. Alice Silva']});
    expect(await emCurso).toBe(true);
    expect(query.mock.calls[1]![0]).toContain("resultado_pronto");
    expect(JSON.stringify(query.mock.calls[1]![1])).not.toMatch(/cpf|paciente|telefone/);
    expect(deps.enviar).not.toHaveBeenCalled();
  });
  it('somente notifica usuário ATIVO da mesma conta e nunca reenvia entrega incerta',async()=>{
    const query=vi.fn()
      .mockResolvedValueOnce({rows:[{...trabalho,estado:'notificando',resultado:{
        ok:true,nomes:['Dra. Alice Silva','Dr. Bruno Lima'],agenda:'tribemd'
      }}]})
      .mockResolvedValueOnce({rows:[{1:1}]})
      .mockResolvedValueOnce({rows:[],rowCount:1})
      .mockResolvedValueOnce({rows:[],rowCount:1});
    const enviar=vi.fn().mockResolvedValue(true);
    const deps={
      pool:db(query),instancia:'notomed_assistente',descobrir:vi.fn(),conferir:vi.fn(),enviar
    };
    expect(await notificarResultadoPendente(deps)).toBe(true);
    expect(enviar).toHaveBeenCalledOnce();
    expect(enviar.mock.calls[0]![0]).toBe(TELEFONE);
    expect(String(enviar.mock.calls[0]![1])).toContain('Dra. Alice Silva');
    expect(String(enviar.mock.calls[0]![1])).toContain('Quais desses médicos');
    expect(query.mock.calls[1]![0]).toContain('u.conta_id=$1');
    expect(query.mock.calls[2]![0]).toContain('jsonb_set');
    expect(query.mock.calls[3]![1]).toEqual([trabalho.id,'concluido']);
  });
  it('envio com resultado incerto não entra em retry automático',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{...trabalho,
      resultado:{ok:false,motivo:'LEITURA_INCOMPLETA'}}]})
      .mockResolvedValueOnce({rows:[{1:1}]})
      .mockResolvedValueOnce({rows:[],rowCount:1});
    const deps={
      pool:db(query),instancia:'notomed_assistente',descobrir:vi.fn(),conferir:vi.fn(),
      enviar:vi.fn().mockRejectedValue(new Error('EVOLUTION_OFFLINE'))
    };
    expect(await notificarResultadoPendente(deps)).toBe(true);
    expect(query.mock.calls.at(-1)![1]).toEqual([trabalho.id,'envio_incerto']);
  });
});
