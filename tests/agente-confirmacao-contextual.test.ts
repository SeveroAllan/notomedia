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

describe('CRM/RQE públicos são proposta, não cadastro automático',()=>{
  const profissionais=[{id:ANA,nome:'Dra. Ana Souza'},{id:BRUNO,nome:'Dr. Bruno Lima'}];
  const sugestao:EstadoConversa={
    profissionalConfirmadoId:ANA,faseAgenda:'VINCULO_CONFIRMADO',
    pesquisasRegistro:{[ANA]:{nome:'Dra. Ana Souza',estado:'aguardando_confirmacao',
      razao:'ENCONTRADO',
      candidatos:[{crm:'12345/RS',uf:'RS',rqes:['980'],origem:'Google via OpenSerp (sugestão não oficial)'}]}}
  };
  async function revisar(
    entrada:string,decisao:string,estado:EstadoConversa=sugestao,crm?:string,rqe?:string){
    const modelo=new ScriptedModel([
      [functionCall('revisar_registro_profissional',{
        profissional:'Ana',decisao,...(crm?{crm}:{}),...(rqe?{rqe}:{})
      },{callId:'revisao'})],
      [assistantMessage('Gravei CRM e RQE automaticamente; já validei no conselho.')]
    ]);
    const salvarDadosProfissionais=vi.fn().mockResolvedValue({ok:true,nome:'Dra. Ana Souza',crm:'12345/RS',rqe:'980'});
    const proporCorrecaoPesquisa=vi.fn().mockResolvedValue(true);
    const concluirRevisaoPesquisa=vi.fn().mockResolvedValue(true);
    const resposta=await responderAgente({texto:entrada,profissionais,estadoConversa:estado},{
      modeloTeste:modelo,consultarStatus:status,salvarDadosProfissionais,
      proporCorrecaoPesquisa,concluirRevisaoPesquisa
    });
    modelo.assertComplete();
    return {resposta,salvarDadosProfissionais,proporCorrecaoPesquisa,concluirRevisaoPesquisa};
  }
  it('pesquisa não confirma: só grava após aprovação de proposta inequívoca',async()=>{
    const r=await revisar('Sim, esses números estão certos','aprovar');
    expect(r.salvarDadosProfissionais).toHaveBeenCalledExactlyOnceWith(ANA,{
      crm:'12345/RS',rqe:'980'
    });
    expect(r.concluirRevisaoPesquisa).toHaveBeenCalledExactlyOnceWith(ANA);
    expect(r.resposta).toContain('Registrei os dados confirmados');
    expect(r.resposta).not.toContain('automaticamente');
  });
  it('correção "meu CRM é..." registra proposta, não escreve até o próximo aceite',async()=>{
    const r=await revisar('Na verdade o CRM correto é 66666/RS e RQE 777','corrigir',sugestao,'66666/RS','777');
    expect(r.proporCorrecaoPesquisa).toHaveBeenCalledExactlyOnceWith(ANA,{crm:'66666/RS',rqe:'777'});
    expect(r.salvarDadosProfissionais).not.toHaveBeenCalled();
    expect(r.resposta).toContain('Confirma esses dados');
    const retomada={...sugestao,pesquisasRegistro:{[ANA]:{
      ...sugestao.pesquisasRegistro![ANA]!,
      proposta:{crm:'66666/RS',rqe:'777',origem:'correcao' as const}
    }}};
    const aprovado=await revisar('Agora sim, pode salvar','aprovar',retomada);
    expect(aprovado.salvarDadosProfissionais).toHaveBeenCalledExactlyOnceWith(ANA,{
      crm:'66666/RS',rqe:'777'
    });
  });
  it('números inventados pelo modelo e não presentes na mensagem não viram correção',async()=>{
    const r=await revisar('Não, está errado','corrigir',sugestao,'66666/RS','777');
    expect(r.proporCorrecaoPesquisa).not.toHaveBeenCalled();
    expect(r.salvarDadosProfissionais).not.toHaveBeenCalled();
  });
  it('duas sugestões de CRM não permitem "sim" sem desambiguação',async()=>{
    const estado={...sugestao,pesquisasRegistro:{[ANA]:{...sugestao.pesquisasRegistro![ANA]!,
      razao:'HOMONIMOS' as const,
      candidatos:[{crm:'12345/RS',uf:'RS',rqes:[],origem:'OpenSerp'},
        {crm:'54321/RS',uf:'RS',rqes:[],origem:'OpenSerp'}]}}};
    const r=await revisar('Sim, é meu','aprovar',estado);
    expect(r.salvarDadosProfissionais).not.toHaveBeenCalled();
    expect(r.resposta).toContain('Não salvei');
  });
  it('sem vínculo ou pesquisa concluída, não tenta validar CRM/RQE',async()=>{
    const r=await revisar('Meu CRM é 100/RS','aprovar',{});
    expect(r.salvarDadosProfissionais).not.toHaveBeenCalled();
    expect(r.resposta).toContain('Primeiro preciso concluir o vínculo');
  });
});
