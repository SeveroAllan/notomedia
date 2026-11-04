import { describe, expect, it, vi } from 'vitest';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import { responderAgente, respostaCompativelComFerramentas } from '../src/agente/agente.js';

const profissionais=[{id:'m1',nome:'Dra. Alice Silva'}];
const conectado={tribemd:{salvo:true,conectada:true},amplimed:{salvo:true,conectada:true}};
const acessoSalvo={tribemd:{salvo:true,conectada:false},amplimed:{salvo:false,conectada:false}};
const falha={tribemd:{salvo:false,conectada:false,indisponivel:true},amplimed:{salvo:false,conectada:false}};

describe('onboarding usa ferramentas existentes apenas com evidência real',()=>{
  it('lê só nomes depois de conexão comprovada, sem inventar médicos da conta',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('descobrir_profissionais_agenda',{agenda:'tribemd',profissional:'Alice'},{callId:'descoberta'})],
      [assistantMessage('Encontrei Alice Silva e Bruno Costa na agenda. Qual desses profissionais você quer configurar?')]
    ]);
    const consultarStatus=vi.fn().mockResolvedValue(conectado);
    const descobrirProfissionais=vi.fn().mockResolvedValue({ok:true,nomes:['Alice Silva','Bruno Costa']});
    const diagnostico=vi.fn();
    const resposta=await responderAgente({
      texto:'A TribeMD da Alice já está conectada. Quem aparece na agenda?',profissionais,
      estadoConversa:{agendaEscolhida:'tribemd',profissionalConfirmadoId:'m1'}
    },{modeloTeste:modelo,consultarStatus,descobrirProfissionais,aoDiagnostico:diagnostico});
    expect(consultarStatus).toHaveBeenCalledWith('m1');
    expect(descobrirProfissionais).toHaveBeenCalledExactlyOnceWith('m1','tribemd');
    expect(resposta).toContain('Bruno Costa');
    const entrada=JSON.stringify(modelo.lastCall?.request.input);
    expect(entrada).toContain('Bruno Costa');
    expect(entrada).not.toMatch(/pacienteId|cpf|telefonePaciente/);
    expect(diagnostico.mock.calls[0][0].ferramentas).toEqual([
      expect.objectContaining({nome:'descobrir_profissionais_agenda',codigo:'PROFISSIONAIS_ENCONTRADOS'})
    ]);
    modelo.assertComplete();
  });

  it('acesso salvo sem conexão confirmada não inicia descoberta nem apresenta lista falsa',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('descobrir_profissionais_agenda',{agenda:'tribemd',profissional:'Alice'},{callId:'acesso-salvo'})],
      [assistantMessage('Há acesso salvo, mas não confirmei a conexão. Vou orientar o próximo passo seguro.')]
    ]);
    const descobrirProfissionais=vi.fn();
    const diagnostico=vi.fn();
    const resposta=await responderAgente({texto:'Pode listar quem está na TribeMD da Alice?',profissionais},
      {modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(acessoSalvo),descobrirProfissionais,aoDiagnostico:diagnostico});
    expect(descobrirProfissionais).not.toHaveBeenCalled();
    expect(resposta).toContain('não confirmei');
    expect(diagnostico.mock.calls[0][0].ferramentas[0].codigo).toBe('CONEXAO_PENDENTE');
    modelo.assertComplete();
  });

  it('falha não vira ausência de cadastro ou conexão',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('descobrir_profissionais_agenda',{agenda:'tribemd',profissional:'Alice'},{callId:'falhou'})],
      [assistantMessage('Não consegui consultar a agenda agora. Podemos tentar verificar novamente?')]
    ]);
    const descobrirProfissionais=vi.fn();
    const diagnostico=vi.fn();
    const resposta=await responderAgente({texto:'Quem está na agenda da Alice?',profissionais},
      {modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(falha),descobrirProfissionais,aoDiagnostico:diagnostico});
    expect(descobrirProfissionais).not.toHaveBeenCalled();
    expect(diagnostico.mock.calls[0][0].ferramentas[0].codigo).toBe('STATUS_INDISPONIVEL');
    expect(resposta).not.toMatch(/não está cadastrada|não possui agenda|desconectada/i);
    modelo.assertComplete();
  });

  it('solicita link só para agenda e profissional explicitamente escolhidos',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('solicitar_link_seguro_agenda',{agenda:'amplimed',profissional:'Alice'},{callId:'link'})],
      [assistantMessage('O pedido do link seguro foi aceito para envio. Ainda não tenho confirmação de entrega.')]
    ]);
    const solicitarLinkAgenda=vi.fn().mockResolvedValue({aceitoParaEnvio:true});
    const diagnostico=vi.fn();
    const resposta=await responderAgente({
      texto:'Amplimed da Alice. Pode me mandar o link?',profissionais,
      estadoConversa:{profissionalConfirmadoId:'m1',agendaEscolhida:'amplimed'}
    },{modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(acessoSalvo),
      solicitarLinkAgenda,aoDiagnostico:diagnostico});
    expect(solicitarLinkAgenda).toHaveBeenCalledExactlyOnceWith('m1','amplimed');
    expect(resposta).toContain('link seguro');
    expect(diagnostico.mock.calls[0][0].ferramentas[0].codigo).toBe('LINK_ACEITO_PARA_ENVIO');
    modelo.assertComplete();
  });

  it('não envia link se escolha não foi feita; ferramenta não pode inferir só porque há um médico cadastrado',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('solicitar_link_seguro_agenda',{agenda:'amplimed',profissional:'Alice'},{callId:'nao-confirmou'})],
      [assistantMessage('Antes de enviar, preciso saber para qual profissional será essa agenda.')]
    ]);
    const solicitarLinkAgenda=vi.fn();
    const diagnostico=vi.fn();
    await responderAgente({texto:'Qual é o próximo passo?',profissionais},
      {modeloTeste:modelo,consultarStatus:vi.fn(),solicitarLinkAgenda,aoDiagnostico:diagnostico});
    expect(solicitarLinkAgenda).not.toHaveBeenCalled();
    expect(diagnostico.mock.calls[0][0].ferramentas[0].codigo).toBe('DEPENDENCIA_PROFISSIONAL');
    modelo.assertComplete();
  });

  it('certificado só aponta para página autenticada de profissional já confirmado, sem alterar fiscal',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('orientar_certificado_seguro',{profissional:'Alice'},{callId:'a1'})],
      [assistantMessage('Seu certificado ainda está pendente. Use a página segura do Noto para cadastrar.')]
    ]);
    const consultarProntidao=vi.fn().mockResolvedValue({
      certificadoValido:false,dadosProfissionaisCompletos:false,
      dadosFiscaisConfirmados:false,liberadoParaEmitir:false
    });
    const diagnostico=vi.fn();
    const resposta=await responderAgente({
      texto:'Pode me orientar sobre meu certificado A1?',profissionais,
      painelUrl:'https://homologacao.example.test',
      estadoConversa:{profissionalConfirmadoId:'m1'}
    },{modeloTeste:modelo,consultarStatus:vi.fn(),consultarProntidao,aoDiagnostico:diagnostico});
    const entrada=JSON.stringify(modelo.lastCall?.request.input);
    expect(entrada).toContain('etapa=certificado');
    expect(entrada).toContain('https://homologacao.example.test');
    expect(entrada).not.toContain('senhaSecreta123');
    expect(entrada).not.toContain('password=');
    expect(consultarProntidao).toHaveBeenCalledExactlyOnceWith('m1');
    expect(diagnostico.mock.calls[0][0].ferramentas[0].codigo).toBe('CERTIFICADO_PENDENTE');
    expect(resposta).not.toContain('Já emiti');
    modelo.assertComplete();
  });

  it('consultar prontidão fiscal não emite nem grava dados ou assume parâmetros',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('consultar_prontidao_onboarding',{profissional:'Alice'},{callId:'pronto'})],
      [assistantMessage('Ainda faltam certificado e dados fiscais confirmados. Não há emissão liberada.')]
    ]);
    const consultarProntidao=vi.fn().mockResolvedValue({
      certificadoValido:false,dadosProfissionaisCompletos:true,
      dadosFiscaisConfirmados:false,liberadoParaEmitir:false
    });
    const diagnostico=vi.fn();
    await responderAgente({texto:'Já podemos emitir notas?',profissionais},
      {modeloTeste:modelo,consultarStatus:vi.fn(),consultarProntidao,aoDiagnostico:diagnostico});
    expect(consultarProntidao).toHaveBeenCalledExactlyOnceWith('m1');
    expect(diagnostico.mock.calls[0][0].ferramentas[0].codigo).toBe('PRONTIDAO_VERIFICADA');
    modelo.assertComplete();
  });
});


describe('confirmação de médicos descobertos depende de consentimento e evidência atual', () => {
  const profissionais=[{id:'m1',nome:'Dra. Alice Silva'}];
  const conectado={tribemd:{salvo:true,conectada:true},amplimed:{salvo:true,conectada:true}};
  const descoberta=vi.fn().mockResolvedValue({ok:true,nomes:['Alice Silva','Bruno Costa']});

  it('mencionar nomes numa pergunta não autoriza cadastro', async()=>{
    const modelo=new ScriptedModel([
      [functionCall('confirmar_profissionais_descobertos',{
        agenda:'tribemd',profissionalBase:'Alice',nomes:['Bruno Costa']
      },{callId:'sem-confirmacao'})],
      [assistantMessage('Encontrei Bruno na agenda. Você confirma adicioná-lo à conta?')]
    ]);
    const confirmar=vi.fn();
    const diag=vi.fn();
    const resposta=await responderAgente({
      texto:'O Bruno Costa também está na agenda da Alice?',profissionais,
      estadoConversa:{agendaEscolhida:'tribemd',profissionalConfirmadoId:'m1'}
    },{modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(conectado),
      descobrirProfissionais:descoberta,confirmarProfissionais:confirmar,aoDiagnostico:diag});
    expect(confirmar).not.toHaveBeenCalled();
    expect(resposta).toContain('confirma');
    expect(diag.mock.calls[0][0].ferramentas[0].codigo).toBe('DEPENDENCIA_PROFISSIONAL');
    modelo.assertComplete();
  });

  it('confirma a ação quando o usuário identifica nome e autoriza incluir, sem herdar fiscal', async()=>{
    const modelo=new ScriptedModel([
      [functionCall('confirmar_profissionais_descobertos',{
        agenda:'tribemd',profissionalBase:'Alice',nomes:['Bruno Costa']
      },{callId:'confirma-doctor'})],
      [assistantMessage('Bruno foi adicionado à conta. Isso não configura certificado nem autoriza emissão.')]
    ]);
    const confirmar=vi.fn().mockResolvedValue({ok:true,nomes:['Bruno Costa']});
    const diag=vi.fn();
    const resposta=await responderAgente({
      texto:'Confirmo adicionar Bruno Costa à conta.',profissionais,
      estadoConversa:{agendaEscolhida:'tribemd',profissionalConfirmadoId:'m1'}
    },{modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(conectado),
      descobrirProfissionais:vi.fn().mockResolvedValue({ok:true,nomes:['Bruno Costa']}),
      confirmarProfissionais:confirmar,aoDiagnostico:diag});
    expect(confirmar).toHaveBeenCalledExactlyOnceWith('m1',['Bruno Costa']);
    expect(diag.mock.calls[0][0].ferramentas[0].codigo).toBe('PROFISSIONAIS_CONFIRMADOS');
    expect(resposta).toContain('nem autoriza emissão');
    modelo.assertComplete();
  });

  it('não cadastra nome que não aparece na fonte agora, mesmo com autorização', async()=>{
    const modelo=new ScriptedModel([
      [functionCall('confirmar_profissionais_descobertos',{
        agenda:'tribemd',profissionalBase:'Alice',nomes:['Bruno Costa']
      },{callId:'fora-fonte'})],
      [assistantMessage('Não consegui confirmar Bruno na agenda. Vou verificar a fonte novamente.')]
    ]);
    const confirmar=vi.fn();
    const diag=vi.fn();
    await responderAgente({
      texto:'Confirmo adicionar Bruno Costa à conta.',profissionais,
      estadoConversa:{agendaEscolhida:'tribemd',profissionalConfirmadoId:'m1'}
    },{modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(conectado),
      descobrirProfissionais:vi.fn().mockResolvedValue({ok:true,nomes:['Alice Silva']}),
      confirmarProfissionais:confirmar,aoDiagnostico:diag});
    expect(confirmar).not.toHaveBeenCalled();
    expect(diag.mock.calls[0][0].ferramentas[0].codigo).toBe('PROFISSIONAL_AMBIGUO');
    modelo.assertComplete();
  });

  it('sim isolado não cadastra lista múltipla, apenas nome único explicitamente pendente', async()=>{
    const modelo=new ScriptedModel([
      [functionCall('confirmar_profissionais_descobertos',{
        agenda:'tribemd',profissionalBase:'Alice',nomes:['Bruno Costa']
      },{callId:'sim-multiplos'})],
      [assistantMessage('Qual nome da lista você confirma?')]
    ]);
    const confirmar=vi.fn();
    const diag=vi.fn();
    await responderAgente({
      texto:'sim',profissionais,
      estadoConversa:{agendaEscolhida:'tribemd',profissionalConfirmadoId:'m1',
        perguntaPendente:'profissional',descoberta:{agenda:'tribemd',nomes:['Alice Silva','Bruno Costa']}}
    },{modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(conectado),
      descobrirProfissionais:vi.fn().mockResolvedValue({ok:true,nomes:['Alice Silva','Bruno Costa']}),
      confirmarProfissionais:confirmar,aoDiagnostico:diag});
    expect(confirmar).not.toHaveBeenCalled();
    expect(diag.mock.calls[0][0].ferramentas[0].codigo).toBe('DEPENDENCIA_PROFISSIONAL');
    modelo.assertComplete();
  });
});


describe('sim é confirmação contextual de um único médico pendente',()=>{
  it('autoriza somente Bruno após pergunta específica, mesmo com vários encontrados', async()=>{
    const modelo=new ScriptedModel([
      [functionCall('confirmar_profissionais_descobertos',{
        agenda:'tribemd',profissionalBase:'Alice',nomes:['Bruno Costa']
      },{callId:'sim-bruno'})],
      [assistantMessage('Bruno foi adicionado à sua conta. O certificado dele continua pendente.')]
    ]);
    const confirmar=vi.fn().mockResolvedValue({ok:true,nomes:['Bruno Costa']});
    const status=vi.fn().mockResolvedValue({tribemd:{salvo:true,conectada:true},amplimed:{salvo:false,conectada:false}});
    const resposta=await responderAgente({
      texto:'sim',profissionais:[{id:'m1',nome:'Dra. Alice Silva'}],
      estadoConversa:{
        agendaEscolhida:'tribemd',profissionalConfirmadoId:'m1',
        perguntaPendente:'confirmar_profissional',nomeProfissionalPerguntado:'Bruno Costa',
        descoberta:{agenda:'tribemd',nomes:['Alice Silva','Bruno Costa']}
      }
    },{modeloTeste:modelo,consultarStatus:status,
      descobrirProfissionais:vi.fn().mockResolvedValue({ok:true,nomes:['Alice Silva','Bruno Costa']}),
      confirmarProfissionais:confirmar});
    expect(confirmar).toHaveBeenCalledExactlyOnceWith('m1',['Bruno Costa']);
    expect(resposta).toContain('certificado');
    modelo.assertComplete();
  });

  it('não permite confirmar outra pessoa, mesmo quando a última pergunta era Bruno', async()=>{
    const modelo=new ScriptedModel([
      [functionCall('confirmar_profissionais_descobertos',{
        agenda:'tribemd',profissionalBase:'Alice',nomes:['Carla Dias']
      },{callId:'desvio-pessoa'})],
      [assistantMessage('Você confirma qual profissional deseja vincular?')]
    ]);
    const confirmar=vi.fn();
    const diag=vi.fn();
    await responderAgente({
      texto:'sim',profissionais:[{id:'m1',nome:'Dra. Alice Silva'}],
      estadoConversa:{
        agendaEscolhida:'tribemd',profissionalConfirmadoId:'m1',
        perguntaPendente:'confirmar_profissional',nomeProfissionalPerguntado:'Bruno Costa',
        descoberta:{agenda:'tribemd',nomes:['Bruno Costa','Carla Dias']}
      }
    },{modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue({
      tribemd:{salvo:true,conectada:true},amplimed:{salvo:false,conectada:false}
    }),descobrirProfissionais:vi.fn().mockResolvedValue({ok:true,nomes:['Bruno Costa','Carla Dias']}),
    confirmarProfissionais:confirmar,aoDiagnostico:diag});
    expect(confirmar).not.toHaveBeenCalled();
    expect(diag.mock.calls[0][0].ferramentas[0].codigo).toBe('DEPENDENCIA_PROFISSIONAL');
    modelo.assertComplete();
  });
});


describe('dados profissionais via conversa, com autorização exata',()=>{
  const medicos=[{id:'m1',nome:'Dra. Alice Silva'}];
  const toolArgs={profissional:'Alice',crm:'12345/RS'};

  it('registra CRM informado e confirmado pelo próprio operador, sem tocar no fiscal',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('confirmar_dados_profissionais',toolArgs,{callId:'confirma-crm'})],
      [assistantMessage('CRM registrado. Os dados fiscais e a emissão continuam pendentes.')]
    ]);
    const salvarDadosProfissionais=vi.fn().mockResolvedValue({ok:true,nome:'Alice Silva',crm:'12345/RS',rqe:null});
    const diagnostico=vi.fn();
    const resposta=await responderAgente({
      texto:'Confirmo CRM: 12345/RS',profissionais:medicos,
      estadoConversa:{profissionalConfirmadoId:'m1'}
    },{modeloTeste:modelo,consultarStatus:vi.fn(),salvarDadosProfissionais,aoDiagnostico:diagnostico});
    expect(salvarDadosProfissionais).toHaveBeenCalledExactlyOnceWith('m1',{crm:'12345/RS'});
    expect(diagnostico.mock.calls[0][0].ferramentas[0].codigo).toBe('DADOS_PROFISSIONAIS_SALVOS');
    expect(JSON.stringify(modelo.lastCall?.request.input)).toMatch(/emissaoAutorizada[^a-zA-Z]*false/);
    expect(resposta).toContain('pendentes');
    modelo.assertComplete();
  });

  it('não altera CRM apenas porque o valor foi mencionado em uma dúvida',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('confirmar_dados_profissionais',toolArgs,{callId:'crm-pergunta'})],
      [assistantMessage('Quer confirmar esse CRM para seu cadastro?')]
    ]);
    const salvarDadosProfissionais=vi.fn();
    const diagnostico=vi.fn();
    await responderAgente({
      texto:'O CRM 12345/RS está certo?',profissionais:medicos,
      estadoConversa:{profissionalConfirmadoId:'m1'}
    },{modeloTeste:modelo,consultarStatus:vi.fn(),salvarDadosProfissionais,aoDiagnostico:diagnostico});
    expect(salvarDadosProfissionais).not.toHaveBeenCalled();
    expect(diagnostico.mock.calls[0][0].ferramentas[0].codigo).toBe('DEPENDENCIA_CONFIRMACAO');
    modelo.assertComplete();
  });

  it('não grava valor inventado pelo modelo, mesmo que a confirmação seja real',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('confirmar_dados_profissionais',toolArgs,{callId:'crm-inventado'})],
      [assistantMessage('Você confirma o CRM correto, por favor?')]
    ]);
    const salvarDadosProfissionais=vi.fn();
    const diagnostico=vi.fn();
    await responderAgente({
      texto:'Confirmo CRM: 67890/RS',profissionais:medicos,
      estadoConversa:{profissionalConfirmadoId:'m1'}
    },{modeloTeste:modelo,consultarStatus:vi.fn(),salvarDadosProfissionais,aoDiagnostico:diagnostico});
    expect(salvarDadosProfissionais).not.toHaveBeenCalled();
    expect(diagnostico.mock.calls[0][0].ferramentas[0].codigo).toBe('DEPENDENCIA_CONFIRMACAO');
    modelo.assertComplete();
  });

  it('ferramenta de cadastro não é exposta antes de vínculo',async()=>{
    const modelo=new ScriptedModel([[assistantMessage('Primeiro precisamos confirmar o profissional. Ainda não pesquisei o CRM.')]]);
    const salvarDadosProfissionais=vi.fn();
    const resposta=await responderAgente({texto:'Confirmo CRM: 12345/RS',profissionais:medicos},{
      modeloTeste:modelo,consultarStatus:vi.fn(),salvarDadosProfissionais
    });
    expect(salvarDadosProfissionais).not.toHaveBeenCalled();
    expect(resposta).toContain('confirmar o profissional');
    modelo.assertComplete();
  });
});


describe('negações não são autorizações de escrita',()=>{
  it('não adiciona médico quando a pessoa diz que não confirma',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('confirmar_profissionais_descobertos',{
        agenda:'tribemd',profissionalBase:'Alice',nomes:['Bruno Costa']
      },{callId:'negou-cadastro'})],
      [assistantMessage('Entendi, não vou adicionar Bruno. Podemos continuar sem alterar sua conta.')]
    ]);
    const confirmarProfissionais=vi.fn();
    const diagnostico=vi.fn();
    const resposta=await responderAgente({
      texto:'Não confirmo adicionar Bruno Costa à conta.',
      profissionais:[{id:'m1',nome:'Dra. Alice Silva'}],
      estadoConversa:{agendaEscolhida:'tribemd',profissionalConfirmadoId:'m1'}
    },{modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue({
      tribemd:{salvo:true,conectada:true},amplimed:{salvo:false,conectada:false}
    }),descobrirProfissionais:vi.fn().mockResolvedValue({ok:true,nomes:['Bruno Costa']}),
      confirmarProfissionais,aoDiagnostico:diagnostico});
    expect(confirmarProfissionais).not.toHaveBeenCalled();
    expect(resposta).toContain('não vou adicionar');
    expect(diagnostico.mock.calls[0][0].ferramentas[0].codigo).toBe('DEPENDENCIA_PROFISSIONAL');
    modelo.assertComplete();
  });

  it.each(['Não confirmo CRM: 12345/RS','Não quero que salve CRM: 12345/RS'])(
    'não grava cadastro quando a pessoa nega: %s',async texto=>{
      const modelo=new ScriptedModel([
        [functionCall('confirmar_dados_profissionais',{
          profissional:'Alice',crm:'12345/RS'
        },{callId:'negou-crm'})],
        [assistantMessage('Entendi, não vou alterar seu CRM.')]
      ]);
      const salvarDadosProfissionais=vi.fn();
      const diagnostico=vi.fn();
      await responderAgente({
        texto,profissionais:[{id:'m1',nome:'Dra. Alice Silva'}],
        estadoConversa:{profissionalConfirmadoId:'m1'}
      },{modeloTeste:modelo,consultarStatus:vi.fn(),salvarDadosProfissionais,aoDiagnostico:diagnostico});
      expect(salvarDadosProfissionais).not.toHaveBeenCalled();
      expect(diagnostico.mock.calls[0][0].ferramentas[0].codigo).toBe('DEPENDENCIA_CONFIRMACAO');
      modelo.assertComplete();
    }
  );
});

describe('configuração local não é instabilidade atribuída à TribeMD', () => {
  const naoConfigurada = {tribemd:{salvo:false,conectada:false,indisponivel:true,
    motivo:'INTEGRACAO_NAO_CONFIGURADA' as const},amplimed:{salvo:false,conectada:false,
    indisponivel:true,motivo:'INTEGRACAO_NAO_CONFIGURADA' as const}};

  it('orientar conexão devolve dependência LOCAL, não invoca TribeMD e corrige resposta enganosa',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('orientar_conexao_agenda',{agenda:'tribemd',profissional:'Alice'},{callId:'conectar-local'})],
      [assistantMessage('A TribeMD falhou. Tente mais tarde.')]
    ]);
    const consultarStatus=vi.fn().mockResolvedValue(naoConfigurada);
    const diagnostico=vi.fn();
    const resposta=await responderAgente({
      texto:'Quero conectar a TribeMD da Alice',profissionais,
      estadoConversa:{agendaEscolhida:'tribemd',profissionalConfirmadoId:'m1'}
    },{modeloTeste:modelo,consultarStatus,aoDiagnostico:diagnostico});
    expect(consultarStatus).toHaveBeenCalledExactlyOnceWith('m1');
    expect(diagnostico.mock.calls[0][0].ferramentas).toContainEqual(
      expect.objectContaining({nome:'orientar_conexao_agenda',codigo:'INTEGRACAO_NAO_CONFIGURADA'})
    );
    expect(resposta).toContain('pendência local');
    expect(resposta).toContain('página segura');
    expect(resposta).not.toMatch(/tribemd falhou|tente mais tarde|tente novamente/i);
    modelo.assertComplete();
  });

  it('consultar estado distingue não configurado de falha operacional sem oferecer retentativa',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('consultar_status_agendas',{profissional:'Alice'},{callId:'status-local'})],
      [assistantMessage('A integração ainda não está configurada neste ambiente. Vou orientar a página segura quando estiver habilitada.')]
    ]);
    const diagnostico=vi.fn();
    const resposta=await responderAgente({texto:'A Tribe da Alice já está configurada?',profissionais},
      {modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(naoConfigurada),
        aoDiagnostico:diagnostico});
    expect(diagnostico.mock.calls[0][0].ferramentas[0]).toMatchObject({
      nome:'consultar_status_agendas',codigo:'INTEGRACAO_NAO_CONFIGURADA'
    });
    expect(resposta).toContain('não está configurada');
    modelo.assertComplete();
  });

  it('erro real com cofre existente continua identificado como falha de consulta',async()=>{
    const falhaReal={...naoConfigurada,tribemd:{salvo:false,conectada:false,indisponivel:true,
      motivo:'FALHA_CONSULTA_INTEGRACAO' as const}};
    const modelo=new ScriptedModel([
      [functionCall('orientar_conexao_agenda',{agenda:'tribemd',profissional:'Alice'},{callId:'falha-real'})],
      [assistantMessage('Não consegui verificar a conexão agora.')]
    ]);
    const diagnostico=vi.fn();
    await responderAgente({
      texto:'Verifica a TribeMD da Alice',profissionais,
      estadoConversa:{agendaEscolhida:'tribemd',profissionalConfirmadoId:'m1'}
    },{modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(falhaReal),
      aoDiagnostico:diagnostico});
    expect(diagnostico.mock.calls[0][0].ferramentas[0].codigo).toBe('STATUS_INDISPONIVEL');
    modelo.assertComplete();
  });
});

it('sem configuração local, resposta simples "tente mais tarde" também é recusada', () => {
  const evento = {nome:'orientar_conexao_agenda' as const,
    codigo:'INTEGRACAO_NAO_CONFIGURADA' as const,duracaoMs:1};
  for(const fala of [
    'Tente mais tarde.',
    'A TribeMD está instável agora.',
    'Podemos tentar novamente depois.',
    'A TribeMD falhou, tente de novo.'
  ]) {
    expect(respostaCompativelComFerramentas(fala,[evento])).toBe(false);
  }
  expect(respostaCompativelComFerramentas(
    'A integração ainda não está configurada neste ambiente. A senha é informada somente na página segura.',
    [evento])).toBe(true);
});
