import {describe,it,expect,vi} from 'vitest';
import {ScriptedModel,assistantMessage,functionCall} from '@openai/agents/testing';
import {criarAgenteNoto,responderAgente} from '../src/agente/agente.js';
import type {EstadoConversa} from '../src/agente/estado-conversa.js';

const conta='conta_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANA='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const estado:EstadoConversa={
  agendaEscolhida:'tribemd',faseAgenda:'CONFIRMACAO_PENDENTE',
  descoberta:{agenda:'tribemd',nomes:['Dra. Ana Souza']},
  perguntaPendente:null
};
const status=async()=>({
  tribemd:{salvo:true,conectada:true},
  amplimed:{salvo:false,conectada:false}
});
const base={
  consultarStatus:status,
  referenciaContaAgenda:vi.fn().mockResolvedValue(conta),
  confirmarProfissionais:vi.fn().mockResolvedValue({
    ok:true,medicos:[{id:ANA,nome:'Dra. Ana Souza'}]
  }),
  aoVinculo:vi.fn().mockResolvedValue({registrado:true,pesquisa:'agendada' as const})
};

describe('roteamento obrigatório de confirmação com descoberta verificada',()=>{
  it('Sim sou eu seleciona forçadamente a ferramenta por NOME e só faz uma inferência',async()=>{
    const modelo=new ScriptedModel([[
      functionCall('confirmar_profissionais_descobertos',{
        agenda:'tribemd',profissionalBase:null,decisao:'confirmar',nomes:[]
      },{callId:'confirmacao'})
    ]]);
    const confirmar=vi.fn().mockResolvedValue({
      ok:true,medicos:[{id:ANA,nome:'Dra. Ana Souza'}]
    });
    const acompanhar=vi.fn().mockResolvedValue({registrado:true,pesquisa:'agendada'});
    const resposta=await responderAgente({
      texto:'Sim, sou eu.',profissionais:[],estadoConversa:estado
    },{
      ...base,modeloTeste:modelo,
      confirmarProfissionais:confirmar,aoVinculo:acompanhar
    });
    expect(modelo.calls).toHaveLength(1);
    expect(modelo.calls[0]!.request.modelSettings.toolChoice)
      .toBe('confirmar_profissionais_descobertos');
    expect(modelo.calls[0]!.request.modelSettings.parallelToolCalls).toBe(false);
    expect(confirmar).toHaveBeenCalledExactlyOnceWith(conta,['Dra. Ana Souza']);
    expect(acompanhar).toHaveBeenCalledOnce();
    expect(resposta).toContain('Vinculei Dra. Ana Souza');
    expect(resposta).not.toContain('Não consegui confirmar isso');
    modelo.assertComplete();
  });

  it('pergunta ou negação passa pela mesma ferramenta mas NÃO autoriza escrita',async()=>{
    for(const {texto,decisao} of [
      {texto:'Quem é essa médica?',decisao:'esclarecer'},
      {texto:'Não quero vincular',decisao:'negar'},
      {texto:'Esse nome está errado',decisao:'corrigir'}
    ]){
      const modelo=new ScriptedModel([[
        functionCall('confirmar_profissionais_descobertos',{
          agenda:'tribemd',profissionalBase:null,decisao,nomes:[]
        },{callId:'decisao'})
      ]]);
      const confirmar=vi.fn();
      const acompanhar=vi.fn();
      const resposta=await responderAgente({
        texto,profissionais:[],estadoConversa:estado
      },{...base,modeloTeste:modelo,confirmarProfissionais:confirmar,aoVinculo:acompanhar});
      expect(modelo.calls).toHaveLength(1);
      expect(modelo.calls[0]!.request.modelSettings.toolChoice)
        .toBe('confirmar_profissionais_descobertos');
      expect(confirmar).not.toHaveBeenCalled();
      expect(acompanhar).not.toHaveBeenCalled();
      expect(resposta).not.toMatch(/Vinculei|pesquisa pública já foi registrada/);
      modelo.assertComplete();
    }
  });

  it('vários médicos pendentes não convertem sim sem nome em identidade',async()=>{
    const multiplo:EstadoConversa={...estado,descoberta:{
      agenda:'tribemd',nomes:['Dra. Ana Souza','Dr. Bruno Lima']
    }};
    const modelo=new ScriptedModel([[
      functionCall('confirmar_profissionais_descobertos',{
        agenda:'tribemd',profissionalBase:null,
        decisao:'confirmar',nomes:['Dra. Ana Souza']
      },{callId:'ambiguidade'})
    ]]);
    const confirmar=vi.fn();
    const resposta=await responderAgente({
      texto:'Sim, sou eu.',profissionais:[],estadoConversa:multiplo
    },{...base,modeloTeste:modelo,confirmarProfissionais:confirmar});
    expect(confirmar).not.toHaveBeenCalled();
    expect(resposta).toMatch(/qual dos profissionais|não fiz nenhum vínculo/i);
    expect(modelo.calls[0]!.request.modelSettings.toolChoice)
      .toBe('confirmar_profissionais_descobertos');
    modelo.assertComplete();
  });

  it('não obriga vínculo sem fase, sem descoberta ou sem ferramenta de autorização',()=>{
    const entrada={texto:'Olá, quero conferir a agenda.',profissionais:[]};
    const casos=[
      {estadoConversa:{}},
      {estadoConversa:{...estado,faseAgenda:'VINCULO_CONFIRMADO' as const}},
      {estadoConversa:{...estado,descoberta:undefined}},
      {estadoConversa:estado,semConta:true}
    ];
    for(const c of casos){
      const agente=criarAgenteNoto({...entrada,...c},{...base});
      expect(agente.modelSettings.toolChoice).toBeUndefined();
    }
    const semFerramenta=criarAgenteNoto({...entrada,estadoConversa:estado},{
      consultarStatus:status,referenciaContaAgenda:base.referenciaContaAgenda
    });
    expect(semFerramenta.modelSettings.toolChoice).toBeUndefined();
  });

  it('texto livre na resposta simulada não prova confirmação nem aciona gravação',async()=>{
    // Modelo simulado descumpre o toolChoice; o código deve falhar seguro.
    // No provedor real, a API recebe tool_choice com o nome obrigatório.
    const modelo=new ScriptedModel([[assistantMessage('Vinculei a médica sem chamar a ferramenta!')]]);
    const confirmar=vi.fn(), acompanhar=vi.fn(), aoDiagnostico=vi.fn();
    const resposta=await responderAgente({
      texto:'Sim, sou eu.',profissionais:[],estadoConversa:estado
    },{...base,modeloTeste:modelo,confirmarProfissionais:confirmar,
       aoVinculo:acompanhar,aoDiagnostico});
    expect(confirmar).not.toHaveBeenCalled();
    expect(acompanhar).not.toHaveBeenCalled();
    expect(aoDiagnostico).toHaveBeenCalledWith(expect.objectContaining({
      codigo:'CONFIRMACAO_SEM_FERRAMENTA',ferramentas:[]
    }));
    expect(resposta).toContain('Não vinculei ninguém');
    expect(resposta).not.toContain('Vinculei a médica');
    expect(modelo.calls[0]!.request.modelSettings.toolChoice)
      .toBe('confirmar_profissionais_descobertos');
    modelo.assertComplete();
  });
});
