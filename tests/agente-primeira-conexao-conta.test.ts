import { describe, expect, it, vi } from 'vitest';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import { responderAgente } from '../src/agente/agente.js';

const referencia='id-tecnico-da-conta';
const medicoProvisorio={id:referencia,nome:'Médico 6133'};
const vazio={tribemd:{salvo:false,conectada:false},amplimed:{salvo:false,conectada:false}};
const conectado={tribemd:{salvo:true,conectada:true},amplimed:{salvo:false,conectada:false}};
const origem={agendaEscolhida:'tribemd' as const};
const nomes=['Dra. Alice Silva','Dr. Bruno Costa'];
const modelo=(ferramenta:string,args:Record<string,unknown>,resposta:string)=>new ScriptedModel(
  ferramenta==='confirmar_profissionais_descobertos'
    ?[[functionCall(ferramenta,args,{callId:'agenda-conta'})]]
    :[[functionCall(ferramenta,args,{callId:'agenda-conta'})],[assistantMessage(resposta)]]
);

describe('primeira conexão por conta sem médico confirmado',()=>{
  it('orienta Cofre seguro sem escolher cadastro provisório nem perguntar qual médico',async()=>{
    const scripted=modelo('orientar_conexao_agenda',{agenda:'tribemd',profissional:null},
      'Posso enviar a página segura para conectar sua TribeMD. Lá você informa a senha.');
    const consultarStatus=vi.fn().mockResolvedValue(vazio),referenciaContaAgenda=vi.fn().mockResolvedValue(referencia);
    const resposta=await responderAgente({texto:'Quero conectar minha TribeMD',
      profissionais:[medicoProvisorio],estadoConversa:origem},
      {modeloTeste:scripted,consultarStatus,referenciaContaAgenda});
    const input=JSON.stringify(scripted.lastCall?.request.input);
    expect(resposta).toContain('página segura');
    expect(referenciaContaAgenda).toHaveBeenCalledOnce();
    expect(consultarStatus).toHaveBeenCalledExactlyOnceWith(referencia);
    expect(input).toContain('profissional=null');
    expect(input).not.toContain('6133');
    expect(input).not.toContain(referencia);
    scripted.assertComplete();
  });

  it('envia link da conta sem identidade clínica, somente depois da escolha Tribe',async()=>{
    const scripted=modelo('solicitar_link_seguro_agenda',{agenda:'tribemd',profissional:null},
      'A Evolution aceitou o pedido do link seguro. Ainda não há confirmação de entrega.');
    const consultarStatus=vi.fn().mockResolvedValue(vazio);
    const solicitarLinkAgenda=vi.fn().mockResolvedValue({aceitoParaEnvio:true});
    const aoComprovante=vi.fn();
    await responderAgente({texto:'Quero conectar TribeMD. Envie meu link.',
      profissionais:[medicoProvisorio],estadoConversa:origem},
      {modeloTeste:scripted,consultarStatus,
        referenciaContaAgenda:vi.fn().mockResolvedValue(referencia),
        solicitarLinkAgenda,aoComprovante});
    expect(solicitarLinkAgenda).toHaveBeenCalledExactlyOnceWith(referencia,'tribemd');
    expect(aoComprovante).not.toHaveBeenCalled(); // sem DELIVERY_ACK, tarefa não concluída
    expect(JSON.stringify(scripted.lastCall?.request.input)).not.toContain('6133');
    scripted.assertComplete();
  });

  it('sem vínculo de conta ou sem agenda escolhida não envia link ou cria médico',async()=>{
    const solicitarLinkAgenda=vi.fn();
    const semRef=modelo('solicitar_link_seguro_agenda',{agenda:'tribemd',profissional:null},
      'Preciso confirmar o acesso à conta antes do link.');
    await responderAgente({texto:'Quero conectar TribeMD',profissionais:[medicoProvisorio],estadoConversa:origem},
      {modeloTeste:semRef,consultarStatus:vi.fn(),referenciaContaAgenda:vi.fn().mockResolvedValue(null),solicitarLinkAgenda});
    expect(solicitarLinkAgenda).not.toHaveBeenCalled();
    const semEscolha=modelo('solicitar_link_seguro_agenda',{agenda:'tribemd',profissional:null},
      'Preciso que escolha a plataforma de agenda primeiro.');
    await responderAgente({texto:'Me envie o link',profissionais:[medicoProvisorio]},
      {modeloTeste:semEscolha,consultarStatus:vi.fn(),referenciaContaAgenda:vi.fn().mockResolvedValue(referencia),solicitarLinkAgenda});
    expect(solicitarLinkAgenda).not.toHaveBeenCalled();
  });

  it('descobre nomes apenas depois de estado conectado e chamada à agenda real',async()=>{
    const scripted=modelo('descobrir_profissionais_agenda',{agenda:'tribemd',profissional:null},
      'A agenda mostrou Alice Silva e Bruno Costa. Você confirma adicioná-los à sua conta?');
    const descobrirProfissionais=vi.fn().mockResolvedValue({ok:true,nomes:[...nomes,'Médico 6133']});
    const aoComprovante=vi.fn();
    const resposta=await responderAgente({texto:'Quais médicos aparecem na TribeMD?',
      profissionais:[medicoProvisorio],estadoConversa:origem},
      {modeloTeste:scripted,consultarStatus:vi.fn().mockResolvedValue(conectado),
        referenciaContaAgenda:vi.fn().mockResolvedValue(referencia),descobrirProfissionais,aoComprovante});
    expect(descobrirProfissionais).toHaveBeenCalledExactlyOnceWith(referencia,'tribemd');
    const input=JSON.stringify(scripted.lastCall?.request.input);
    expect(input).toContain('Alice Silva');
    expect(input).toContain('Bruno Costa');
    expect(input).not.toContain('6133');
    expect(resposta).toContain('confirma');
    expect(aoComprovante).toHaveBeenCalledOnce();
    scripted.assertComplete();
  });

  it('não descobre ninguém antes do login confirmado',async()=>{
    const scripted=modelo('descobrir_profissionais_agenda',{agenda:'tribemd',profissional:null},
      'A conexão ainda não foi confirmada. Vou aguardar o acesso seguro.');
    const descobrirProfissionais=vi.fn();
    await responderAgente({texto:'Quem está na TribeMD?',profissionais:[medicoProvisorio]},
      {modeloTeste:scripted,consultarStatus:vi.fn().mockResolvedValue(vazio),
        referenciaContaAgenda:vi.fn().mockResolvedValue(referencia),descobrirProfissionais});
    expect(descobrirProfissionais).not.toHaveBeenCalled();
    scripted.assertComplete();
  });

  it('confirma um alvo comprovado sem reler agenda nem herdar autorização fiscal',async()=>{
    const scripted=modelo('confirmar_profissionais_descobertos',{
      agenda:'tribemd',profissionalBase:null,decisao:'confirmar',nomes:['Dra. Alice Silva']
    },'Vínculo concluído.');
    const descobrirProfissionais=vi.fn();
    const confirmarProfissionais=vi.fn().mockResolvedValue({ok:true,
      nomes:['Dra. Alice Silva'],medicos:[{id:'m-2',nome:'Dra. Alice Silva'}]});
    const resposta=await responderAgente({
      texto:'Confirmo vincular a Dra. Alice Silva à minha conta.',
      profissionais:[medicoProvisorio],
      estadoConversa:{...origem,faseAgenda:'CONFIRMACAO_PENDENTE',
        descoberta:{agenda:'tribemd',nomes}}
    },{modeloTeste:scripted,consultarStatus:vi.fn().mockResolvedValue(conectado),
      referenciaContaAgenda:vi.fn().mockResolvedValue(referencia),
      descobrirProfissionais,confirmarProfissionais});
    expect(descobrirProfissionais).not.toHaveBeenCalled();
    expect(confirmarProfissionais).toHaveBeenCalledExactlyOnceWith(referencia,['Dra. Alice Silva']);
    expect(resposta).toContain('Vinculei Dra. Alice Silva');
    scripted.assertComplete();
  });

  it('não vincula nomes sem confirmação nem se a IA inventar um médico',async()=>{
    for (const {texto,lista} of [
      {texto:'Quem é Alice Silva?',lista:nomes},
      {texto:'Confirmo adicionar Alice Silva à conta.',lista:['Bruno Costa']}
    ]) {
      const scripted=modelo('confirmar_profissionais_descobertos',{
        agenda:'tribemd',profissionalBase:null,decisao:'esclarecer',nomes:['Alice Silva']
      },'Vou confirmar os nomes pela agenda antes de cadastrar.');
      const confirmarProfissionais=vi.fn();
      await responderAgente({texto,profissionais:[medicoProvisorio],estadoConversa:origem},
        {modeloTeste:scripted,consultarStatus:vi.fn().mockResolvedValue(conectado),
          referenciaContaAgenda:vi.fn().mockResolvedValue(referencia),
          descobrirProfissionais:vi.fn().mockResolvedValue({ok:true,nomes:lista}),confirmarProfissionais});
      expect(confirmarProfissionais).not.toHaveBeenCalled();
    }
  });

  it('agenda já conectada segue para descoberta sem reenviar link',async()=>{
    const scripted=modelo('orientar_conexao_agenda',{agenda:'tribemd',profissional:null},
      'A TribeMD já está conectada. Vou consultar os nomes na agenda.');
    const solicitarLinkAgenda=vi.fn();
    await responderAgente({texto:'Consegue verificar minha TribeMD?',profissionais:[medicoProvisorio],estadoConversa:origem},
      {modeloTeste:scripted,consultarStatus:vi.fn().mockResolvedValue(conectado),
        referenciaContaAgenda:vi.fn().mockResolvedValue(referencia),solicitarLinkAgenda});
    expect(solicitarLinkAgenda).not.toHaveBeenCalled();
    expect(JSON.stringify(scripted.lastCall?.request.input)).toContain('descobrir_profissionais_agenda');
    scripted.assertComplete();
  });
});

it('sem descoberta real comprovada em turno anterior, não cadastra mesmo com nome válido e confirmação',async()=>{
  const modeloTeste=new ScriptedModel([
    [functionCall('confirmar_profissionais_descobertos',{
      agenda:'tribemd',profissionalBase:null,decisao:'confirmar',nomes:['Alice Silva']
    },{callId:'sem-descoberta-previa'})]
  ]);
  const descobrirProfissionais=vi.fn().mockResolvedValue({ok:true,nomes:['Alice Silva']});
  const confirmarProfissionais=vi.fn();
  const resposta=await responderAgente({
    texto:'Confirmo adicionar Alice Silva',profissionais:[],estadoConversa:{agendaEscolhida:'tribemd'}
  },{modeloTeste,consultarStatus:vi.fn().mockResolvedValue({
    tribemd:{salvo:true,conectada:true},amplimed:{salvo:false,conectada:false}
  }),referenciaContaAgenda:vi.fn().mockResolvedValue('id-tecnico-da-conta'),
  descobrirProfissionais,confirmarProfissionais});
  expect(resposta).toContain('descoberta comprovada');
  expect(descobrirProfissionais).not.toHaveBeenCalled();
  expect(confirmarProfissionais).not.toHaveBeenCalled();
  modeloTeste.assertComplete();
});

it('apelido Tribe é escolha explícita preservada no próximo turno',async()=>{
  const { evoluirEstadoConversa } = await import('../src/agente/estado-conversa.js');
  const estado=evoluirEstadoConversa({},'Eu uso Tribe','Posso enviar o link seguro?',[{id:'placeholder',nome:'Médico 6133'}]);
  expect(estado.agendaEscolhida).toBe('tribemd');
  const scripted=modelo('solicitar_link_seguro_agenda',{agenda:'tribemd',profissional:null},
    'A Evolution aceitou o pedido do link seguro. Ainda não há confirmação de entrega.');
  const solicitarLinkAgenda=vi.fn().mockResolvedValue({aceitoParaEnvio:true});
  await responderAgente({texto:'Sim, pode enviar',profissionais:[],estadoConversa:estado},{
    modeloTeste:scripted,consultarStatus:vi.fn().mockResolvedValue({
      tribemd:{salvo:false,conectada:false},amplimed:{salvo:false,conectada:false}
    }),referenciaContaAgenda:vi.fn().mockResolvedValue('id-tecnico-da-conta'),solicitarLinkAgenda});
  expect(solicitarLinkAgenda).toHaveBeenCalledExactlyOnceWith('id-tecnico-da-conta','tribemd');
  scripted.assertComplete();
});
