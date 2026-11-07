import { describe,expect,it,vi } from 'vitest';
import { ScriptedModel,assistantMessage,functionCall } from '@openai/agents/testing';
import { responderAgente } from '../src/agente/agente.js';

const vazio={
  tribemd:{salvo:false,conectada:false},
  amplimed:{salvo:false,conectada:false}
};
const conectado={
  tribemd:{salvo:true,conectada:true},
  amplimed:{salvo:false,conectada:false}
};
const ancora=()=>vi.fn().mockResolvedValue('id-interno-conta-sem-medico');

describe('fala alinhada a ação real de conexão, sem IA paga',()=>{
  it('não anuncia como futuro o link já aceito pela Evolution',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('solicitar_link_seguro_agenda',{agenda:'tribemd',profissional:null},{callId:'link-aceito'})],
      [assistantMessage('Já solicitei o link seguro. Assim que estiver disponível, você o receberá.')]
    ]);
    const enviar=vi.fn().mockResolvedValue({aceitoParaEnvio:true});
    const resposta=await responderAgente({
      texto:'Pode mandar o link seguro da TribeMD?',
      profissionais:[],estadoConversa:{agendaEscolhida:'tribemd'}
    },{
      modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(vazio),
      referenciaContaAgenda:ancora(),solicitarLinkAgenda:enviar
    });
    expect(enviar).toHaveBeenCalledOnce();
    expect(resposta).not.toMatch(/aceit|confirm.*entrega/i);
    expect(resposta).toContain('Depois de preencher a página segura');
    expect(resposta).not.toMatch(/assim que estiver disponível|você o receberá|já solicitei/i);
    modelo.assertComplete();
  });
  it('retoma o último link do banco sem pedir outro ou prometer novo envio',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('consultar_status_entrega_link_agenda',{agenda:'tribemd'}, {callId:'retomada'})],
      [assistantMessage('Assim que estiver disponível, você receberá o link. Estou à disposição.')]
    ]);
    const resposta=await responderAgente({
      texto:'E o link da agenda?',
      profissionais:[],estadoConversa:{agendaEscolhida:'tribemd'},
      situacaoUltimoLink:{agenda:'tribemd',estado:'SEM_CONFIRMACAO'}
    },{
      modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(vazio),
      referenciaContaAgenda:ancora(),
      consultarEntregaLink:vi.fn().mockResolvedValue({estado:'SEM_CONFIRMACAO',comId:true,segundosDesdeAceite:120})
    });
    expect(resposta).not.toMatch(/aceit|confirm.*entrega/i);
    expect(resposta).not.toMatch(/quando quiser|estou à disposição|receberá/i);
    modelo.assertComplete();
  });
  it('conexão já confirmada não vira encerramento genérico',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('orientar_conexao_agenda',{agenda:'tribemd',profissional:null},{callId:'conexao-confirmada'})],
      [assistantMessage('Certo, estou à disposição se precisar de algo.')]
    ]);
    const resposta=await responderAgente({
      texto:'Já conectei minha TribeMD, o que vem agora?',
      profissionais:[],estadoConversa:{agendaEscolhida:'tribemd'}
    },{
      modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(conectado),
      referenciaContaAgenda:ancora()
    });
    expect(resposta).toMatch(/identificar|verificar os profissionais/);
    expect(resposta).not.toMatch(/estou à disposição|quando quiser/i);
    modelo.assertComplete();
  });
  it('sem evidência de entrega não chama ✅ nem inventa confirmação de médico',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('solicitar_link_seguro_agenda',{agenda:'tribemd',profissional:null},{callId:'aceito-sem-ack'})],
      [assistantMessage('O serviço de mensagens aceitou o pedido. Ainda não confirmei entrega.')]
    ]);
    const aoComprovante=vi.fn();
    const resposta=await responderAgente({
      texto:'Quero conectar TribeMD pelo link',
      profissionais:[],estadoConversa:{agendaEscolhida:'tribemd'}
    },{
      modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(vazio),
      referenciaContaAgenda:ancora(),solicitarLinkAgenda:vi.fn().mockResolvedValue({aceitoParaEnvio:true}),
      aoComprovante
    });
    expect(resposta).toContain('A verificação da agenda começa ali.');
    expect(aoComprovante).not.toHaveBeenCalled();
    modelo.assertComplete();
  });
});

describe('estado de ação controla o relato, não uma lista de frases proibidas',()=>{
  it('após pedido de link, usa a orientação sem a abertura livre',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('solicitar_link_seguro_agenda',{agenda:'tribemd',profissional:null},{callId:'resultado-estruturado'})],
      [assistantMessage('Enviei novamente o link da Amplimed, mas ainda não tenho confirmação de entrega. [[RESULTADO_ACAO]]')]
    ]);
    const resposta=await responderAgente({
      texto:'Quero conectar a TribeMD',profissionais:[],
      estadoConversa:{agendaEscolhida:'tribemd'}
    },{
      modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(vazio),
      referenciaContaAgenda:ancora(),
      solicitarLinkAgenda:vi.fn().mockResolvedValue({aceitoParaEnvio:true})
    });
    expect(resposta).not.toMatch(/Enviei novamente|Amplimed|confirmação de entrega/i);
    expect(resposta).not.toMatch(/aceit|confirm.*entrega/i);
    expect(resposta).toContain('Depois de preencher a página segura');
    expect(resposta).not.toContain('[[RESULTADO_ACAO]]');
    modelo.assertComplete();
  });
  const variacoes=[
    'Agora vou pedir seu link para você usar quando ele estiver pronto.',
    'Tudo certo, o endereço chegará assim que o sistema concluir.',
    'Fico à disposição. O acesso será encaminhado em breve.',
    'O link poderá ser enviado em alguns instantes, aguarde.',
    'Já está entregue e você já pode abrir a página.'
  ];
  for (const [indice,livre] of variacoes.entries()) {
    it('variação de linguagem #'+(indice+1)+' não altera aceite para entrega/futuro',async()=>{
      const modelo=new ScriptedModel([
        [functionCall('solicitar_link_seguro_agenda',{agenda:'tribemd',profissional:null},{callId:'evidencia-'+indice})],
        [assistantMessage(livre)]
      ]);
      const saida=await responderAgente({
        texto:'Quero receber o link seguro da TribeMD',profissionais:[],
        estadoConversa:{agendaEscolhida:'tribemd'}
      },{
        modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(vazio),
        referenciaContaAgenda:ancora(),
        solicitarLinkAgenda:vi.fn().mockResolvedValue({aceitoParaEnvio:true})
      });
      expect(saida).not.toMatch(/aceit|confirm.*entrega/i);
      expect(saida).toContain('Depois de preencher a página segura');
      expect(saida).not.toMatch(/em breve|será encaminhado|já está entregue|vou pedir|quando ele estiver pronto/i);
      modelo.assertComplete();
    });
  }
  it('sem ação de link não desvia pergunta independente para status do Cofre',async()=>{
    const modelo=new ScriptedModel([[assistantMessage('Vamos conferir sua pergunta sobre horários.') ]]);
    const saida=await responderAgente({
      texto:'Você pode me explicar o horário do atendimento?',profissionais:[],
      estadoConversa:{agendaEscolhida:'tribemd'},
      situacaoUltimoLink:{agenda:'tribemd',estado:'SEM_CONFIRMACAO'}
    },{
      modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(vazio)
    });
    expect(saida).toBe('Vamos conferir sua pergunta sobre horários.');
    modelo.assertComplete();
  });
});
