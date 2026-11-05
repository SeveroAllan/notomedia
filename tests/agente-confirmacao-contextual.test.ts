import {describe,expect,it,vi} from 'vitest';
import {ScriptedModel,assistantMessage,functionCall} from '@openai/agents/testing';
import {decidirVinculo} from '../src/agente/confirmacao-contextual.js';
import {responderAgente} from '../src/agente/agente.js';
import type {EstadoConversa} from '../src/agente/estado-conversa.js';

const ANA='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BRUNO='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const base='conta_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const unico:EstadoConversa={agendaEscolhida:'tribemd',faseAgenda:'CONFIRMACAO_PENDENTE',
  descoberta:{agenda:'tribemd',nomes:['Dra. Ana Souza']},
  perguntaPendente:null}; // a resposta NÃO depende do texto da pergunta anterior
const multiplo:EstadoConversa={...unico,descoberta:{agenda:'tribemd',
  nomes:['Dra. Ana Souza','Dr. Bruno Lima']}};
const status=vi.fn().mockResolvedValue({
  tribemd:{salvo:true,conectada:true},
  amplimed:{salvo:false,conectada:false}
});
const port=()=>{
  const confirmarProfissionais=vi.fn().mockResolvedValue({
    ok:true,nomes:['Dra. Ana Souza'],medicos:[{id:ANA,nome:'Dra. Ana Souza'}]
  });
  const aoVinculo=vi.fn().mockResolvedValue({registrado:true,pesquisa:'agendada'});
  return {confirmarProfissionais,aoVinculo};
};
async function simular(texto:string,decisao:string,nomes:string[],estado:EstadoConversa=unico,
  overrides:Record<string,unknown>={}){
  const modelo=new ScriptedModel([
    [functionCall('confirmar_profissionais_descobertos',
      {agenda:'tribemd',profissionalBase:null,decisao,nomes},{callId:'vinculo'})],
    [assistantMessage('O CRM 999 não foi validado; tente digitar tudo de novo.')]
  ]);
  const deps=port();
  const resposta=await responderAgente({texto,profissionais:[],estadoConversa:estado},{
    modeloTeste:modelo,referenciaContaAgenda:vi.fn().mockResolvedValue(base),consultarStatus:status,
    ...deps,...overrides
  });
  modelo.assertComplete();
  return {...deps,resposta};
}
describe('consentimento contextual com alvo autenticado, sem frases fixas',()=>{
  for(const texto of ['Sim, sou eu!','É essa médica, pode vincular.','Perfeito. Sim, é a minha conta.',
    'Confirmado, essa profissional sou eu.','Pode seguir com essa, por favor.']){
    it('interpreta '+texto+' sem exigir palavras da pergunta anterior',async()=>{
      const r=await simular(texto,'confirmar',['Dra. Ana Souza']);
      expect(r.confirmarProfissionais).toHaveBeenCalledExactlyOnceWith(base,['Dra. Ana Souza']);
      expect(r.aoVinculo).toHaveBeenCalledExactlyOnceWith('tribemd',{id:ANA,nome:'Dra. Ana Souza'});
      expect(r.resposta).toContain('Vinculei Dra. Ana Souza');
      expect(r.resposta).toContain('antes de salvar');
      expect(r.resposta).not.toMatch(/999|não foi validado|digitar tudo/);
    });
  }
  it('confirma pelo contexto também sem nome técnico no tool call se só houver uma descoberta',()=>{
    expect(decidirVinculo(unico,{agenda:'tribemd',decisao:'confirmar',nomes:[],mensagem:'Sim, sou eu!'}))
      .toEqual({ok:true,agenda:'tribemd',nomes:['Dra. Ana Souza']});
  });
  it('com dois médicos, "sim sou eu" não escolhe nenhum',async()=>{
    const r=await simular('Sim, sou eu!','confirmar',['Dra. Ana Souza'],multiplo);
    expect(r.confirmarProfissionais).not.toHaveBeenCalled();
    expect(r.aoVinculo).not.toHaveBeenCalled();
    expect(r.resposta).toMatch(/qual dos profissionais|não fiz nenhum vínculo/i);
  });
  it('com dois médicos, identifica apenas o nome presente na mensagem',()=>{
    expect(decidirVinculo(multiplo,{agenda:'tribemd',decisao:'confirmar',
      nomes:['Dr. Bruno Lima'],mensagem:'Vincula o Bruno Lima à conta'}))
      .toEqual({ok:true,agenda:'tribemd',nomes:['Dr. Bruno Lima']});
    expect(decidirVinculo(multiplo,{agenda:'tribemd',decisao:'confirmar',
      nomes:['Dra. Ana Souza','Dr. Bruno Lima'],mensagem:'Pode vincular os dois'}))
      .toEqual({ok:false,motivo:'ALVO_AMBIGUO'});
  });
  it('negação, dúvida, correção ou mudança de assunto não criam vínculos',async()=>{
    for(const [texto,decisao] of [
      ['Não, não sou essa pessoa','negar'],
      ['Quem é essa médica?','esclarecer'],
      ['O nome está errado','corrigir'],
      ['Quero só saber das notas','esclarecer']
    ]){
      const r=await simular(texto,decisao,['Dra. Ana Souza']);
      expect(r.confirmarProfissionais).not.toHaveBeenCalled();
      expect(r.resposta).not.toContain('Vinculei');
    }
  });
  it('sem descoberta autenticada ou fonte divergente não consulta portal nem cadastra',async()=>{
    for(const estado of [{},{
      ...unico,descoberta:{agenda:'amplimed' as const,nomes:['Dra. Ana Souza']}
    }]){
      const r=await simular('Sim, sou eu','confirmar',['Dra. Ana Souza'],estado);
      expect(r.confirmarProfissionais).not.toHaveBeenCalled();
    }
  });
  it('status da agenda indisponível não vira suposta falha de CRM/RQE',async()=>{
    const r=await simular('Sim, sou eu','confirmar',['Dra. Ana Souza'],unico,{
      consultarStatus:vi.fn().mockResolvedValue({
        tribemd:{salvo:true,conectada:false,indisponivel:true},
        amplimed:{salvo:false,conectada:false}
      })
    });
    expect(r.confirmarProfissionais).not.toHaveBeenCalled();
    expect(r.resposta).toMatch(/Ainda não confirmei o acesso/);
    expect(r.resposta).not.toMatch(/não consegui validar|CRM 999/i);
  });
  it('não relê agenda no momento da confirmação, mesmo com pesquisa anterior demorada',async()=>{
    const descobrirProfissionais=vi.fn(()=>new Promise<never>(()=>{}));
    const r=await simular('Sim, sou eu','confirmar',['Dra. Ana Souza'],unico,{descobrirProfissionais});
    expect(descobrirProfissionais).not.toHaveBeenCalled();
    expect(r.confirmarProfissionais).toHaveBeenCalledOnce();
  });
});

describe('CRM/RQE: sugestão pública e preenchimento apenas pelo cofre',()=>{
  const profissionais=[{id:ANA,nome:'Dra. Ana Souza'},{id:BRUNO,nome:'Dr. Bruno Lima'}];
  const sugestao:EstadoConversa={
    profissionalConfirmadoId:ANA,faseAgenda:'VINCULO_CONFIRMADO',
    pesquisasRegistro:{[ANA]:{nome:'Dra. Ana Souza',estado:'aguardando_confirmacao',
      razao:'ENCONTRADO',
      candidatos:[{crm:'12345/RS',uf:'RS',rqes:['980'],origem:'Pesquisa pública via OpenSerp'}]}}
  };
  async function revisar(
    entrada:string,decisao:'aprovar'|'corrigir'|'recusar'|'esclarecer',
    estado:EstadoConversa=sugestao
  ){
    const modelo=new ScriptedModel([
      [functionCall('revisar_registro_profissional',{
        profissional:'Ana',decisao
      },{callId:'revisao'})],
      [assistantMessage('Gravei CRM e RQE automaticamente, sem pedir confirmação.')]
    ]);
    const aprovarRegistroProfissional=vi.fn().mockResolvedValue({
      ok:true,nome:'Dra. Ana Souza',crm:'12345/RS',rqe:'980'
    });
    const solicitarLinkRegistro=vi.fn().mockResolvedValue({ok:true,motivo:'ACEITO_API'});
    const salvarDadosProfissionais=vi.fn();
    const resposta=await responderAgente({texto:entrada,profissionais,estadoConversa:estado},{
      modeloTeste:modelo,consultarStatus:status,
      aprovarRegistroProfissional,solicitarLinkRegistro,salvarDadosProfissionais
    });
    modelo.assertComplete();
    return {resposta,aprovarRegistroProfissional,solicitarLinkRegistro,salvarDadosProfissionais,modelo};
  }
  it('aprovação natural grava apenas proposta persistida, não valores do modelo',async()=>{
    const r=await revisar('Sim, são esses os dados que eu confirmei','aprovar');
    expect(r.aprovarRegistroProfissional).toHaveBeenCalledExactlyOnceWith(ANA);
    expect(r.salvarDadosProfissionais).not.toHaveBeenCalled();
    expect(r.resposta).toContain('Registrei os dados confirmados');
    expect(r.resposta).not.toContain('automaticamente');
    expect(JSON.stringify(r.modelo.calls)).not.toContain('66666/RS');
  });
  it('correção pede página segura, não exige que se digite CRM no WhatsApp',async()=>{
    const r=await revisar('Não, quero corrigir esses dados','corrigir');
    expect(r.solicitarLinkRegistro).toHaveBeenCalledExactlyOnceWith(ANA,'solicitar');
    expect(r.aprovarRegistroProfissional).not.toHaveBeenCalled();
    expect(r.salvarDadosProfissionais).not.toHaveBeenCalled();
    expect(r.resposta).toMatch(/link seguro/i);
    expect(r.resposta).not.toMatch(/salvei os dados|digite seu CRM aqui/i);
  });
  it('texto contendo números não contorna o cofre nem vira proposta escrita',async()=>{
    const r=await revisar('Meu CRM é 66666/RS, pode corrigir','corrigir');
    expect(r.solicitarLinkRegistro).toHaveBeenCalledOnce();
    expect(r.aprovarRegistroProfissional).not.toHaveBeenCalled();
    expect(r.salvarDadosProfissionais).not.toHaveBeenCalled();
  });
  it('homônimos não aprovam um CRM por "sim"',async()=>{
    const estado={...sugestao,pesquisasRegistro:{[ANA]:{
      nome:'Dra. Ana Souza',estado:'aguardando_confirmacao' as const,
      razao:'HOMONIMOS' as const,
      candidatos:[{crm:'12345/RS',uf:'RS',rqes:[],origem:'OpenSerp'},
        {crm:'54321/RS',uf:'RS',rqes:[],origem:'OpenSerp'}]
    }}};
    const r=await revisar('Sim, sou eu','aprovar',estado);
    expect(r.aprovarRegistroProfissional).not.toHaveBeenCalled();
    expect(r.resposta).toMatch(/Não salvei/);
    expect(r.salvarDadosProfissionais).not.toHaveBeenCalled();
  });
  it('sem vínculo ou sem resultado apresentado, não chama gravação',async()=>{
    const r=await revisar('Meu CRM é 100/RS','aprovar',{});
    expect(r.aprovarRegistroProfissional).not.toHaveBeenCalled();
    expect(r.salvarDadosProfissionais).not.toHaveBeenCalled();
    expect(r.resposta).toContain('Primeiro preciso concluir o vínculo');
  });
  it('recusa e esclarecimento não gravam CRM nem geram link',async()=>{
    for(const decisao of ['recusar','esclarecer'] as const){
      const r=await revisar('Ainda não, quero conferir melhor',decisao);
      expect(r.aprovarRegistroProfissional).not.toHaveBeenCalled();
      expect(r.solicitarLinkRegistro).not.toHaveBeenCalled();
      expect(r.resposta).not.toContain('Registrei os dados');
    }
  });
  it('depois de quatro tentativas, link depende de autorização contextual, não de frase fixa',async()=>{
    const estado:EstadoConversa={profissionalConfirmadoId:ANA,
      pesquisasRegistro:{[ANA]:{nome:'Dra. Ana Souza',estado:'manual_pendente',
        razao:'LIMITE_TENTATIVAS',tentativas:4}}};
    const solicitarLinkRegistro=vi.fn().mockResolvedValue({ok:true,motivo:'ACEITO_API'});
    for(const texto of ['Pode enviar a página segura','Sim, vamos preencher pelo link']){
      const modelo=new ScriptedModel([
        [functionCall('solicitar_link_seguro_registro',
          {profissional:'Ana',decisao:'autorizar'},{callId:'link'})],
        [assistantMessage('Já recebi seus dados!')]
      ]);
      const resposta=await responderAgente({texto,profissionais,estadoConversa:estado},{
        modeloTeste:modelo,consultarStatus:status,solicitarLinkRegistro
      });
      expect(resposta).toMatch(/aceitou o link seguro/i);
      expect(resposta).not.toContain('Já recebi seus dados');
      modelo.assertComplete();
    }
    expect(solicitarLinkRegistro).toHaveBeenCalledTimes(2);
  });
  it('a intenção incerta não autoriza link novo',async()=>{
    const estado:EstadoConversa={profissionalConfirmadoId:ANA,
      pesquisasRegistro:{[ANA]:{nome:'Dra. Ana Souza',estado:'manual_pendente',
        razao:'LIMITE_TENTATIVAS',tentativas:4}}};
    const solicitarLinkRegistro=vi.fn();
    const modelo=new ScriptedModel([
      [functionCall('solicitar_link_seguro_registro',{profissional:'Ana',decisao:'esclarecer'},{callId:'duvida'})],
      [assistantMessage('Enviei um link')]
    ]);
    const resposta=await responderAgente({texto:'Como é esse link?',profissionais,estadoConversa:estado},{
      modeloTeste:modelo,consultarStatus:status,solicitarLinkRegistro
    });
    expect(solicitarLinkRegistro).not.toHaveBeenCalled();
    expect(resposta).not.toContain('Enviei');
    modelo.assertComplete();
  });
  it('distingue status real e menciona invalidação apenas quando a troca foi confirmada',async()=>{
    const estado:EstadoConversa={profissionalConfirmadoId:ANA,
      pesquisasRegistro:{[ANA]:{nome:'Dra. Ana Souza',estado:'link_manual_reservado',
        razao:'LIMITE_TENTATIVAS',tentativas:4}}};
    const cenarios=[
      {decisao:'consultar',motivo:'ENVIO_INCERTO',ok:true,revo:false,
        trecho:'não vou reenviá-la às cegas'},
      {decisao:'consultar',motivo:'ACEITO_SEM_ENTREGA',ok:true,revo:false,
        trecho:'ainda não confirmou entrega'},
      {decisao:'consultar',motivo:'FALHA_COMPROVADA',ok:false,revo:false,
        trecho:'falhou de forma comprovada'},
      {decisao:'consultar',motivo:'ENTREGUE',ok:true,revo:false,
        trecho:'confirmou a entrega'},
      {decisao:'substituir',motivo:'ACEITO_API',ok:true,revo:true,
        trecho:'Invalidei o link anterior'},
      {decisao:'substituir',motivo:'ENVIO_INCERTO',ok:false,revo:true,
        trecho:'Invalidei o link anterior'},
    ] as const;
    for(const c of cenarios){
      const modelo=new ScriptedModel([
        [functionCall('solicitar_link_seguro_registro',
          {profissional:'Ana',decisao:c.decisao},{callId:'link'})],
        [assistantMessage('Entreguei o link e já gravei o CRM.')]
      ]);
      const solicitarLinkRegistro=vi.fn().mockResolvedValue({
        ok:c.ok,motivo:c.motivo,anteriorInvalidado:c.revo
      });
      const resposta=await responderAgente({
        texto:c.decisao==='substituir'?'Pode invalidar o anterior e tentar outro da Ana':
          'Consegue conferir o que aconteceu com o link da Ana?',
        profissionais,estadoConversa:estado
      },{modeloTeste:modelo,consultarStatus:status,solicitarLinkRegistro});
      expect(resposta).toContain(c.trecho);
      if(!c.revo)expect(resposta).not.toContain('Invalidei o link anterior');
      expect(resposta).not.toContain('já gravei');
      expect(solicitarLinkRegistro).toHaveBeenCalledExactlyOnceWith(
        ANA,c.decisao==='substituir'?'substituir':'consultar');
      modelo.assertComplete();
    }
  });

});
