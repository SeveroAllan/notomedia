import { describe, expect, it, vi } from 'vitest';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import { responderAgente } from '../src/agente/agente.js';

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
      [assistantMessage('Enviei o link seguro para você conectar a Amplimed. Sua senha fica só na página.')]
    ]);
    const solicitarLinkAgenda=vi.fn().mockResolvedValue({enviado:true});
    const diagnostico=vi.fn();
    const resposta=await responderAgente({
      texto:'Amplimed da Alice. Pode me mandar o link?',profissionais,
      estadoConversa:{profissionalConfirmadoId:'m1',agendaEscolhida:'amplimed'}
    },{modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(acessoSalvo),
      solicitarLinkAgenda,aoDiagnostico:diagnostico});
    expect(solicitarLinkAgenda).toHaveBeenCalledExactlyOnceWith('m1','amplimed');
    expect(resposta).toContain('link seguro');
    expect(diagnostico.mock.calls[0][0].ferramentas[0].codigo).toBe('LINK_ENVIADO');
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
    expect(entrada).not.toMatch(/senha|password|senhaSecreta123/);
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
