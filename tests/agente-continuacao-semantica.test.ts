import {describe,it,expect,vi} from 'vitest';
import {ScriptedModel,assistantMessage,functionCall} from '@openai/agents/testing';
import {criarAgenteNoto,responderAgente} from '../src/agente/agente.js';
import type {EstadoConversa} from '../src/agente/estado-conversa.js';

const ID='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const profissionais=[{id:ID,nome:'Dra. Ana Souza'}];
const estado:EstadoConversa={faseAgenda:'VINCULO_CONFIRMADO',profissionalConfirmadoId:ID,perguntaPendente:null,
  pesquisasRegistro:{[ID]:{nome:'Dra. Ana Souza',estado:'aguardando_confirmacao',confirmacaoAdiada:true,
    razao:'ENCONTRADO',candidatos:[{crm:'36948/RS',uf:'RS',rqes:['980'],origem:'OpenSerp'}]}}};
const fatos={vinculo:'confirmado',crm:'adiado',crmValor:null,periodo:'pendente',inicioPeriodo:null,emitiuNota:false,consultouNotas:false};
function preparar(intencoes:string[],texto:string,acoes:string[],crm='adiado',crmConfirmado:string|null=null,inicioPeriodo:string|null=null){
  const modelo=new ScriptedModel([
    [functionCall('continuar_onboarding',{profissional:'Ana',intencoes,inicioPeriodo,
      crmConfirmado,rqeConfirmado:null,camposConfirmados:intencoes.includes('aprovar_registro')?['crm']:[]},{callId:'continuar'})],
    [assistantMessage(JSON.stringify({texto,fatos:{...fatos,crm,crmValor:crm==='confirmado'?'36948/RS':null,
        periodo:inicioPeriodo?'registrado':'pendente',inicioPeriodo},acoesConcluidas:acoes}))]
  ]);
  const aprovarRegistroProfissional=vi.fn().mockResolvedValue({ok:true,nome:'Dra. Ana Souza',crm:'36948/RS',rqe:null});
  const consultarProntidao=vi.fn().mockResolvedValue({certificadoValido:false,dadosProfissionaisCompletos:false,
    dadosFiscaisConfirmados:false,liberadoParaEmitir:false});
  const registrarPeriodoConferencia=vi.fn().mockResolvedValue(true);
  const confirmarProfissionais=vi.fn();
  const links:string[]=[];
  const deps={modeloTeste:modelo,aprovarRegistroProfissional,consultarProntidao,confirmarProfissionais,
    consultarStatus:vi.fn(),registrarPeriodoConferencia,aoCertificadoSeguro:(r:{ok:boolean;url?:string})=>{if(r.ok&&r.url)links.push(r.url);}};
  const entrada={texto:'O CRM 36948/RS está certo, pode confirmar e salvar. E me manda o link da página do certificado.',
    profissionais,estadoConversa:structuredClone(estado),painelUrl:'https://homologacao.example.test'};
  return {modelo,aprovarRegistroProfissional,consultarProntidao,registrarPeriodoConferencia,confirmarProfissionais,links,deps,entrada};
}
describe('continuidade semântica com resultados verificáveis',()=>{
  it.each(['Pronto, confirmei o CRM da Ana. O acesso do certificado está aqui.',
    'O CRM ficou salvo. Para o A1, pode abrir o acesso abaixo.'])('atende CRM e certificado no mesmo turno com fala natural: %s',async(texto)=>{
    const p=preparar(['aprovar_registro','consultar_certificado'],texto,['crm_salvo','pagina_certificado_preparada'],'confirmado','36948/RS');
    expect(await responderAgente(p.entrada,p.deps)).toBe(texto);
    expect(p.aprovarRegistroProfissional).toHaveBeenCalledExactlyOnceWith(ID,{confirmarRqe:false});
    expect(p.consultarProntidao).toHaveBeenCalledExactlyOnceWith(ID);
    expect(p.confirmarProfissionais).not.toHaveBeenCalled();
    expect(p.links).toEqual(['https://homologacao.example.test/?medicoId='+ID+'&etapa=certificado']);
    expect(p.modelo.calls[0]!.request.modelSettings.toolChoice).toBe('continuar_onboarding');
    p.modelo.assertComplete();
  });
  it('período é tratado semanticamente como escopo e a fala não vira histórico de emissão',async()=>{
    const texto='O período começa em 1º de novembro. Podemos seguir com o A1.';
    const p=preparar(['definir_periodo'],texto,['periodo_registrado','pagina_certificado_preparada'],'adiado',null,'2026-11-01');
    p.entrada.texto='Desde 1 de novembro de 2026.';
    expect(await responderAgente(p.entrada,p.deps)).toBe(texto);
    expect(p.registrarPeriodoConferencia).toHaveBeenCalledExactlyOnceWith(ID,'2026-11-01');
    expect(p.aprovarRegistroProfissional).not.toHaveBeenCalled();
    expect(p.links).toHaveLength(1);
    p.modelo.assertComplete();
  });
  it('contrato que inventa vínculo pendente é recusado sem transformar isso em gravação',async()=>{
    const p=preparar(['conversar'],'Alice precisa ser vinculada novamente.',[]);
    const modelo=new ScriptedModel([
      [functionCall('continuar_onboarding',{profissional:'Ana',intencoes:['conversar'],inicioPeriodo:null,
        crmConfirmado:null,rqeConfirmado:null,camposConfirmados:[]},{callId:'inventar'})],
      [assistantMessage(JSON.stringify({texto:'Alice precisa ser vinculada novamente.',fatos:{...fatos,vinculo:'pendente'},acoesConcluidas:[]}))]
    ]);
    const diagnosticos:unknown[]=[];
    const resposta=await responderAgente(p.entrada,{...p.deps,modeloTeste:modelo,aoDiagnostico:r=>diagnosticos.push(r)});
    expect(resposta).not.toContain('precisa ser vinculada novamente');
    expect(p.aprovarRegistroProfissional).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnosticos)).toContain('FALA_FORA_CONTRATO');
    modelo.assertComplete();
  });
  it('leitura fiscal real atualiza os fatos sem reintroduzir conclusão a partir de uma data',async()=>{
    const p=preparar(['conversar'],'Conferi os vínculos registrados.',[]);
    p.entrada.texto='Confere os atendimentos da Ana na TribeMD.';
    const consultarConferencia=vi.fn(async()=>({ok:true as const,agenda:'tribemd' as const,
      profissional:'Dra. Ana Souza',janelaDias:30 as const,realizados:1,comReferencia:1,semReferencia:0,
      comVinculoConfirmado:1,comSolicitacaoVinculada:1,comNotaAutorizadaVinculada:1,semVinculoConfirmado:0,
      limite:'VINCULOS_EXATOS_NAO_COMPROVAM_AUSENCIA_DE_NOTA' as const}));
    const modelo=new ScriptedModel([
      [functionCall('continuar_onboarding',{profissional:'Ana',intencoes:['conversar'],inicioPeriodo:null,
        crmConfirmado:null,rqeConfirmado:null,camposConfirmados:[]},{callId:'contexto'})],
      [functionCall('conferir_atendimentos_e_notas',{profissional:'Ana',agenda:'tribemd'},{callId:'conferir'})],
      [assistantMessage(JSON.stringify({texto:'Conferi os vínculos registrados. Eles não provam ausência de outras notas.',
        fatos:{...fatos,consultouNotas:true},acoesConcluidas:['conferencia_realizada']}))]
    ]);
    const resposta=await responderAgente(p.entrada,{...p.deps,modeloTeste:modelo,consultarConferencia,
      consultarStatus:async()=>({tribemd:{salvo:true,conectada:true},amplimed:{salvo:false,conectada:false}})});
    expect(resposta).toBe('Conferi os vínculos registrados. Eles não provam ausência de outras notas.');
    expect(consultarConferencia).toHaveBeenCalledExactlyOnceWith(ID,'tribemd');
    expect(p.aprovarRegistroProfissional).not.toHaveBeenCalled();
    modelo.assertComplete();
  });
  it('sim é ela não aprova números e não oferece nova vinculação',async()=>{
    const p=preparar(['conversar'],'Sim, Ana já está vinculada.',[]);
    p.entrada.texto='Sim, é ela.';
    const agente=criarAgenteNoto(p.entrada,p.deps);
    expect(agente.tools.some(t=>'name' in t&&t.name==='confirmar_profissionais_descobertos')).toBe(false);
    expect(await responderAgente(p.entrada,p.deps)).toBe('Sim, Ana já está vinculada.');
    expect(p.aprovarRegistroProfissional).not.toHaveBeenCalled();
    expect(p.confirmarProfissionais).not.toHaveBeenCalled();
    expect(p.consultarProntidao).not.toHaveBeenCalled();
    p.modelo.assertComplete();
  });
  it('repetição da ferramenta na mesma mensagem não duplica gravação nem link',async()=>{
    const p=preparar(['aprovar_registro','consultar_certificado'],'CRM salvo, segue o acesso.',
      ['crm_salvo','pagina_certificado_preparada'],'confirmado','36948/RS');
    const args={profissional:'Ana',intencoes:['aprovar_registro','consultar_certificado'],inicioPeriodo:null,
      crmConfirmado:'36948/RS',rqeConfirmado:null,camposConfirmados:['crm']};
    const modelo=new ScriptedModel([
      [functionCall('continuar_onboarding',args,{callId:'primeira'})],
      [functionCall('continuar_onboarding',args,{callId:'duplicada'})],
      [assistantMessage(JSON.stringify({texto:'CRM salvo, segue o acesso.',fatos:{...fatos,crm:'confirmado',crmValor:'36948/RS'},
        acoesConcluidas:['crm_salvo','pagina_certificado_preparada']}))]
    ]);
    expect(await responderAgente(p.entrada,{...p.deps,modeloTeste:modelo})).toBe('CRM salvo, segue o acesso.');
    expect(p.aprovarRegistroProfissional).toHaveBeenCalledOnce();
    expect(p.consultarProntidao).toHaveBeenCalledOnce();
    expect(p.links).toHaveLength(1);
    modelo.assertComplete();
  });
  it('número divergente não salva sugestão antiga; o pedido independente de certificado continua',async()=>{
    const texto='Esse número não corresponde à sugestão apresentada. O acesso do A1 está aqui.';
    const p=preparar(['aprovar_registro','consultar_certificado'],texto,['pagina_certificado_preparada'],'adiado','99999/RS');
    p.entrada.texto='O CRM 99999/RS está certo. Manda também o certificado.';
    expect(await responderAgente(p.entrada,p.deps)).toBe(texto);
    expect(p.aprovarRegistroProfissional).not.toHaveBeenCalled();
    expect(p.links).toHaveLength(1);
    p.modelo.assertComplete();
  });
  it('falha de gravação não vira sucesso e não perde o outro pedido',async()=>{
    const texto='Não consegui salvar o CRM. O acesso do A1 está aqui para seguirmos.';
    const p=preparar(['aprovar_registro','consultar_certificado'],texto,['pagina_certificado_preparada'],'adiado','36948/RS');
    p.aprovarRegistroProfissional.mockResolvedValue({ok:false,motivo:'GRAVACAO_INDISPONIVEL'});
    expect(await responderAgente(p.entrada,p.deps)).toBe(texto);
    expect(p.aprovarRegistroProfissional).toHaveBeenCalledOnce();
    expect(p.links).toHaveLength(1);
    p.modelo.assertComplete();
  });
});
