import { readFileSync } from 'node:fs';
import {describe,it,expect,vi} from 'vitest';
import {ScriptedModel,assistantMessage,functionCall} from '@openai/agents/testing';
import {criarAgenteNoto,responderAgente} from '../src/agente/agente.js';
import type {EstadoConversa} from '../src/agente/estado-conversa.js';
import type {DiagnosticoAgente} from '../src/agente/diagnostico.js';

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
  it('retoma o CRM adiado antes do certificado, sem gravar nem preparar link',async()=>{
    const texto='O CRM sugerido da Ana é 36948/RS. Você confirma esse número?';
    const p=preparar(['retomar_registro','consultar_certificado'],texto,[]);
    p.entrada.texto='Vamos validar o CRM';
    expect(await responderAgente(p.entrada,p.deps)).toBe(texto);
    expect(JSON.stringify(p.modelo.lastCall?.request.input)).toContain('REGISTRO_PENDENTE');
    expect(JSON.stringify(p.modelo.lastCall?.request.input)).toContain('36948/RS');
    expect(p.aprovarRegistroProfissional).not.toHaveBeenCalled();
    expect(p.consultarProntidao).not.toHaveBeenCalled();
    expect(p.links).toEqual([]);
  });
  it('não promete registrar período ou conferir quando o alvo foi recusado',async()=>{
    const p=preparar(['definir_periodo'],'Vou fazer isso agora.',[]);
    p.entrada.texto='Pode usar 20/10 como início do período e conferir os atendimentos. Se estiver tudo certo, já quero emitir a nota.';
    const modelo=new ScriptedModel([
      [functionCall('continuar_onboarding',{profissional:'20/10',intencoes:['definir_periodo'],inicioPeriodo:'2026-10-20',
        crmConfirmado:null,rqeConfirmado:null,camposConfirmados:[]},{callId:'alvo-recusado'})],
      [assistantMessage(JSON.stringify({texto:'Vou fazer isso agora.',fatos,acoesConcluidas:[]}))]
    ]);
    const diagnosticos:DiagnosticoAgente[]=[];
    const resposta=await responderAgente(p.entrada,{...p.deps,modeloTeste:modelo,aoDiagnostico:r=>diagnosticos.push(r)});
    expect(resposta).toContain('Não consegui identificar o profissional');
    expect(resposta).not.toContain('Vou fazer isso agora');
    expect(diagnosticos.at(-1)).toMatchObject({codigo:'RESPOSTA_POR_ESTADO',continuidade:{alvoValido:false,acoesConcluidas:[]}});
    expect(p.registrarPeriodoConferencia).not.toHaveBeenCalled();
    modelo.assertComplete();
  });
  it.each([
    {intencoes:['conversar'],campos:[],crm:null,alvo:'Ana',revisao:'NAO_SOLICITADA',comparacao:'NAO_INFORMADO'},
    {intencoes:['aprovar_registro'],campos:[],crm:'36948/RS',alvo:'Ana',revisao:'CRM_NAO_AUTORIZADO',comparacao:'COINCIDE'},
    {intencoes:['aprovar_registro'],campos:['crm'],crm:'99999/RS',alvo:'Ana',revisao:'REGISTRO_DIVERGENTE',comparacao:'DIVERGE'},
    {intencoes:['aprovar_registro','consultar_certificado'],campos:['crm'],crm:'36948/RS',alvo:'Bruno',revisao:'ALVO_INVALIDO',comparacao:'NAO_AVALIADO'}
  ])('expõe o motivo de nenhuma ação sem argumentos sensíveis: $revisao',async(caso)=>{
    const p=preparar(['conversar'],'Continuamos com o vínculo preservado.',[]);
    const diagnosticos:DiagnosticoAgente[]=[];
    const modelo=new ScriptedModel([
      [functionCall('continuar_onboarding',{profissional:caso.alvo,intencoes:caso.intencoes,inicioPeriodo:null,
        crmConfirmado:caso.crm,rqeConfirmado:null,camposConfirmados:caso.campos},{callId:'sem-acao'})],
      [assistantMessage(JSON.stringify({texto:'Continuamos com o vínculo preservado.',fatos,acoesConcluidas:[]}))]
    ]);
    await responderAgente(p.entrada,{...p.deps,modeloTeste:modelo,aoDiagnostico:r=>diagnosticos.push(r)});
    const ultimo=diagnosticos.at(-1)!;
    expect(ultimo.continuidade).toMatchObject({intencoes:caso.intencoes,camposConfirmados:caso.campos,
      alvoValido:caso.alvo==='Ana',revisao:caso.revisao,comparacaoCrm:caso.comparacao,acoesConcluidas:[]});
    expect(ultimo.contratoFala).toBe('VALIDO');
    expect(ultimo.ferramentas).toContainEqual(expect.objectContaining({nome:'continuar_onboarding',codigo:'CONTINUIDADE_SEM_ACAO'}));
    expect(ultimo.rejeicaoFala).toBeUndefined();
    expect(JSON.stringify(diagnosticos)).not.toMatch(/36948|99999|Ana|Bruno|https|bbbbbbbb/);
    expect(p.aprovarRegistroProfissional).not.toHaveBeenCalled();
    expect(p.consultarProntidao).not.toHaveBeenCalled();
    modelo.assertComplete();
  });
  it.each([
    {fatos:{...fatos,crm:'confirmado'},acoes:[],motivo:'FATOS_DIVERGENTES'},
    {fatos,acoes:['crm_salvo'],motivo:'ACOES_DIVERGENTES'},
    {fatos:{...fatos,crm:'confirmado'},acoes:['crm_salvo'],motivo:'FATOS_E_ACOES_DIVERGENTES'}
  ])('identifica rejeição da fala sem expor conteúdo: $motivo',async(caso)=>{
    const p=preparar(['conversar'],'Não executei ações.',[]);
    const diagnosticos:DiagnosticoAgente[]=[];
    const modelo=new ScriptedModel([
      [functionCall('continuar_onboarding',{profissional:'Ana',intencoes:['conversar'],inicioPeriodo:null,
        crmConfirmado:null,rqeConfirmado:null,camposConfirmados:[]},{callId:'contrato'})],
      [assistantMessage(JSON.stringify({texto:'CONTEUDO_PRIVADO',fatos:caso.fatos,acoesConcluidas:caso.acoes}))]
    ]);
    const resposta=await responderAgente(p.entrada,{...p.deps,modeloTeste:modelo,aoDiagnostico:r=>diagnosticos.push(r)});
    expect(resposta).not.toContain('CONTEUDO_PRIVADO');
    expect(diagnosticos.at(-1)).toMatchObject({contratoFala:'INVALIDO',rejeicaoFala:caso.motivo});
    expect(JSON.stringify(diagnosticos)).not.toContain('CONTEUDO_PRIVADO');
    expect(p.aprovarRegistroProfissional).not.toHaveBeenCalled();
    modelo.assertComplete();
  });
  it.each(['Pronto, confirmei o CRM da Ana. O acesso do certificado está aqui.',
    'O CRM ficou salvo. Para o A1, pode abrir o acesso abaixo.'])('atende CRM e certificado no mesmo turno com fala natural: %s',async(texto)=>{
    const p=preparar(['aprovar_registro','consultar_certificado'],texto,['crm_salvo','pagina_certificado_preparada'],'confirmado','36948/RS');
    const diagnosticos:DiagnosticoAgente[]=[];
    expect(await responderAgente(p.entrada,{...p.deps,aoDiagnostico:r=>diagnosticos.push(r)})).toBe(texto);
    expect(diagnosticos.at(-1)?.continuidade).toMatchObject({
      intencoes:['aprovar_registro','consultar_certificado'],camposConfirmados:['crm'],alvoValido:true,
      comparacaoCrm:'COINCIDE',revisao:'EXECUTADA_SUCESSO',certificado:'PREPARADO',
      acoesConcluidas:['crm_salvo','pagina_certificado_preparada']});
    expect(p.aprovarRegistroProfissional).toHaveBeenCalledExactlyOnceWith(ID,{confirmarRqe:false});
    expect(p.consultarProntidao).toHaveBeenCalledExactlyOnceWith(ID);
    expect(p.confirmarProfissionais).not.toHaveBeenCalled();
    expect(p.links).toEqual(['https://homologacao.example.test/?medicoId='+ID+'&etapa=certificado']);
    const itens=p.modelo.lastCall?.request.input as Array<{type?:string;output?:{text:string}}>;
    const resultado=JSON.parse(itens.find(item=>item.type==='function_call_result')!.output!.text);
    const arquivo=readFileSync(new URL('../contrato-continuar-onboarding.md',import.meta.url),'utf8').trim();
    expect(resultado.contratoResposta.instrucao).toBe(arquivo);
    expect(resultado.contratoResposta.instrucao).toContain('pagina_certificado_preparada');
    expect(resultado.contratoResposta.formato).toEqual({
      texto:'Sua resposta natural ao usuário',
      fatos:{...fatos,crm:'confirmado',crmValor:'36948/RS'},
      acoesConcluidas:['crm_salvo','pagina_certificado_preparada']
    });
    expect(p.modelo.calls[0]!.request.modelSettings.toolChoice).toBe('continuar_onboarding');
    p.modelo.assertComplete();
  });
  it.each([false,true])('verifica só o certificado do profissional recém-confirmado (válido: %s)',async(valido)=>{
    const texto=valido?'O certificado da Ana está válido.':'Abra a página segura para cadastrar o certificado da Ana.';
    const p=preparar(['aprovar_registro'],texto,
      ['crm_salvo',valido?'certificado_verificado':'pagina_certificado_preparada'],'confirmado','36948/RS');
    p.entrada.texto='O CRM 36948/RS está certo, pode confirmar e salvar.';
    p.entrada.profissionais=[...profissionais,{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',nome:'Dr. Bruno Lima'}];
    p.consultarProntidao.mockResolvedValue({certificadoValido:valido,dadosProfissionaisCompletos:true});
    expect(await responderAgente(p.entrada,p.deps)).toBe(texto);
    expect(p.aprovarRegistroProfissional).toHaveBeenCalledExactlyOnceWith(ID,{confirmarRqe:false});
    expect(p.consultarProntidao).toHaveBeenCalledExactlyOnceWith(ID);
    expect(p.links).toEqual(valido?[]:['https://homologacao.example.test/?medicoId='+ID+'&etapa=certificado']);
    p.modelo.assertComplete();
  });
  it('período é tratado semanticamente como escopo e a fala não vira histórico de emissão',async()=>{
    const p=preparar(['definir_periodo'],'Certo.', ['periodo_registrado'],'adiado',null,'2023-10-20');
    p.entrada.texto='Desde 20 de outubro.';
    const solicitarTrabalho=vi.fn().mockResolvedValue({ok:true,estado:'iniciado'});
    const consultarConferencia=vi.fn();
    const ano=new Intl.DateTimeFormat('en',{year:'numeric',timeZone:'America/Sao_Paulo'}).format();
    const inicio=ano+'-10-20';
    vi.useFakeTimers({toFake:['Date']});
    vi.setSystemTime(new Date(ano+'-11-07T12:00:00Z'));
    try {
      const resposta=await responderAgente({...p.entrada,estadoConversa:{...p.entrada.estadoConversa,agendaEscolhida:'tribemd'}},
        {...p.deps,consultarStatus:async()=>({tribemd:{salvo:true,conectada:true},amplimed:{salvo:false,conectada:false}}),solicitarTrabalho,consultarConferencia});
      expect(resposta).toContain('em andamento');
      expect(p.registrarPeriodoConferencia).toHaveBeenCalledExactlyOnceWith(ID,inicio);
      expect(solicitarTrabalho).toHaveBeenCalledExactlyOnceWith('conferencia_fiscal','tribemd',ID,inicio);
      expect(p.aprovarRegistroProfissional).not.toHaveBeenCalled();
      expect(p.links).toHaveLength(0);
    } finally {vi.useRealTimers();}
    p.modelo.assertComplete();
  });
  it.each([
    ['na verdade é desde 20 de outubro de 2026', '20/10/2026'],
    ['20 de outubro de 2026', null],
    ['20/10/2026', '2023-10-20']
  ])('extrai a data da mensagem: %s', async (texto, dica) => {
    const p=preparar(['definir_periodo'],'Certo.', ['periodo_registrado'],'adiado',null,dica);
    const solicitarTrabalho=vi.fn().mockResolvedValue({ok:true,estado:'iniciado'});
    vi.useFakeTimers({toFake:['Date']});
    vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
    try {
      const resposta=await responderAgente({...p.entrada,texto,estadoConversa:{...p.entrada.estadoConversa,
        agendaEscolhida:'tribemd',periodoConferencia:{profissionalId:ID,inicio:'2023-10-20'}}},
        {...p.deps,consultarStatus:async()=>({tribemd:{salvo:true,conectada:true},amplimed:{salvo:false,conectada:false}}),
          consultarConferencia:vi.fn(),solicitarTrabalho});
      expect(p.registrarPeriodoConferencia).toHaveBeenCalledExactlyOnceWith(ID,'2026-10-20','2023-10-20');
      expect(solicitarTrabalho).toHaveBeenCalledExactlyOnceWith('conferencia_fiscal','tribemd',ID,'2026-10-20');
      expect(resposta).toContain('em andamento');
      expect(resposta).not.toContain('Qual é a data inicial');
    } finally {vi.useRealTimers();}
  });
  it.each([
    ['2026-12-20', 'DATA_FUTURA'],
    ['entre 20/10/2026 e 25/10/2026', 'INTERVALO_OU_MULTIPLAS_DATAS'],
    ['31/10', 'ANO_NECESSARIO_PARA_SUBSTITUIR'],
    ['não é 2023, é desde 20 de outubro de 2026', 'MULTIPLOS_ANOS'],
    ['até outubro', 'INTERVALO_OU_MULTIPLAS_DATAS'],
    ['não é desde 20 de outubro de 2026', 'DATA_NEGADA'],
    ['Minha consulta foi em 20/10/2026', 'DATA_SEM_ESCOPO_CLARO']
  ])('esclarece e diagnostica a rejeição: %s', async (texto, motivo) => {
    const p=preparar(['definir_periodo'],'Certo.', [],'adiado',null,'20/10/2026');
    const aoDiagnostico=vi.fn();
    vi.useFakeTimers({toFake:['Date']});
    vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
    try {
      const resposta=await responderAgente({...p.entrada,texto,estadoConversa:{...p.entrada.estadoConversa,
        periodoConferencia:{profissionalId:ID,inicio:'2023-10-20'}}},{...p.deps,aoDiagnostico});
      expect(resposta).toContain('Qual é a data inicial');
      expect(p.registrarPeriodoConferencia).not.toHaveBeenCalled();
      expect(aoDiagnostico).toHaveBeenCalledWith(expect.objectContaining({
        rejeicaoPeriodo:{motivo}
      }));
    } finally {vi.useRealTimers();}
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
