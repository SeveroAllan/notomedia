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
    expect(resposta).toContain('A verificação da agenda começa ali.');
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

  it('período informado define escopo, não ausência de notas, sem abrir certificado nem cobrar CRM',async()=>{
    const modelo=new ScriptedModel([[functionCall('registrar_periodo_conferencia',{
      decisao:'definir',inicio:'2026-11-01'
    },{callId:'periodo'})]]);
    const registrarPeriodoConferencia=vi.fn().mockResolvedValue(true);
    const consultarProntidao=vi.fn().mockResolvedValue({certificadoValido:false,
      dadosProfissionaisCompletos:false,dadosFiscaisConfirmados:false,liberadoParaEmitir:false});
    const resposta=await responderAgente({texto:'Desde 1 de novembro de 2026.',profissionais,
      painelUrl:'https://homologacao.example.test',estadoConversa:{profissionalConfirmadoId:'m1',
        perguntaPendente:'periodo',pesquisasRegistro:{m1:{nome:'Dra. Alice Silva',estado:'aguardando_confirmacao',
          confirmacaoAdiada:true,candidatos:[{crm:'36948/RS',uf:'RS',rqes:[],origem:'OpenSerp'}]}}}},
      {modeloTeste:modelo,consultarStatus:vi.fn(),registrarPeriodoConferencia,consultarProntidao});
    expect(modelo.calls[0]!.request.modelSettings.toolChoice).toBe('registrar_periodo_conferencia');
    expect(modelo.calls).toHaveLength(1);
    expect(registrarPeriodoConferencia).toHaveBeenCalledExactlyOnceWith('m1','2026-11-01');
    expect(consultarProntidao).not.toHaveBeenCalled();
    expect(resposta).toContain('período solicitado');
    expect(resposta).toContain('01/11/2026');
    expect(resposta).toContain('Qual agenda devo conferir?');
    expect(resposta).not.toContain('etapa=certificado');
    expect(resposta).not.toMatch(/não emite|não emitiu|parou de emitir|Quer que eu siga com a confirmação|36948/);
    expect(JSON.stringify(modelo.calls[0]!.request.input)).not.toContain('36948/RS');
    modelo.assertComplete();
  });
  it('snapshot real da #60 com pergunta nula ou ausente exige classificação da intenção completa',async()=>{
    for(const pergunta of [null,undefined]){
      const modelo=new ScriptedModel([[functionCall('registrar_periodo_conferencia',{
        decisao:'definir',inicio:'2026-11-01'
      },{callId:'periodo-legado'})]]);
      const registrarPeriodoConferencia=vi.fn().mockResolvedValue(true);
      const diagnostico=vi.fn();
      const resposta=await responderAgente({texto:'Desde 1 de novembro de 2026.',profissionais,
        estadoConversa:{faseAgenda:'VINCULO_CONFIRMADO',profissionalConfirmadoId:'m1',
          ...(pergunta===null?{perguntaPendente:null}:{}),
          pesquisasRegistro:{m1:{nome:'Dra. Alice Silva',estado:'aguardando_confirmacao',confirmacaoAdiada:true}}}},
        {modeloTeste:modelo,consultarStatus:vi.fn(),registrarPeriodoConferencia,aoDiagnostico:diagnostico});
      expect(modelo.calls[0]!.request.modelSettings.toolChoice).toBe('continuar_onboarding');
      expect(registrarPeriodoConferencia).toHaveBeenCalledExactlyOnceWith('m1','2026-11-01');
      expect(resposta).toContain('período solicitado');
      expect(resposta).not.toMatch(/não emite|não emitiu|confirmar.*vincul/);
      expect(diagnostico.mock.calls.at(-1)?.[0]).toMatchObject({
        estadoVinculo:{fase:'VINCULO_CONFIRMADO'},
        estadoOnboarding:{vinculoConfirmadoNaConta:true,perguntaPendente:pergunta===null?null:'AUSENTE',
          crmAdiado:true,ferramentaPeriodoObrigatoria:false,ferramentaContinuidadeObrigatoria:true}
      });
      const primeiraEntrada=modelo.calls[0]!.request.input[0];
      if(!primeiraEntrada||typeof primeiraEntrada==='string'||!('content' in primeiraEntrada))throw Error('Contexto não enviado');
      const contexto=JSON.parse(String(primeiraEntrada.content));
      expect(contexto.vinculoProfissionalVerificado).toEqual({nome:'Dra. Alice Silva',estado:'CONFIRMADO',novaConfirmacaoNecessaria:false});
      modelo.assertComplete();
    }
  });
  it('texto livre sem ferramenta não muda sentido da data nem reabre vínculo confirmado',async()=>{
    const modelo=new ScriptedModel([[assistantMessage('Como você não emite notas desde 1 de novembro, a confirmação dela está pendente. Você confirma que deseja vincular Alice?')]]);
    const estado={faseAgenda:'VINCULO_CONFIRMADO' as const,profissionalConfirmadoId:'m1',
      perguntaPendente:null,pesquisasRegistro:{m1:{nome:'Dra. Alice Silva',estado:'aguardando_confirmacao' as const,confirmacaoAdiada:true}}};
    const antes=structuredClone(estado);
    const diagnostico=vi.fn();
    const resposta=await responderAgente({texto:'Desde 1 de novembro de 2026.',profissionais,estadoConversa:estado},
      {modeloTeste:modelo,consultarStatus:vi.fn(),aoDiagnostico:diagnostico});
    expect(resposta).toContain('Dra. Alice Silva já está vinculada');
    expect(resposta).toContain('confirmação do CRM/RQE continua adiada');
    expect(resposta).not.toMatch(/não emite|a confirmação dela está pendente|Você confirma que deseja vincular/);
    expect(resposta).toContain('data inicial do período');
    expect(estado).toEqual(antes);
    expect(diagnostico.mock.calls.at(-1)?.[0]).toMatchObject({codigo:'RESPOSTA_POR_ESTADO',
      estadoOnboarding:{vinculoConfirmadoNaConta:true,ferramentaPeriodoObrigatoria:false}});
    modelo.assertComplete();
  });
  it('classificação outro_assunto não libera conclusões fiscais ou regressão do vínculo no texto livre',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('registrar_periodo_conferencia',{decisao:'outro_assunto',inicio:null},{callId:'assunto'})],
      [assistantMessage('Alice ainda aguarda vínculo e você não emite desde novembro.')]
    ]);
    const registrarPeriodoConferencia=vi.fn();
    const resposta=await responderAgente({texto:'Podemos continuar?',profissionais,
      estadoConversa:{faseAgenda:'VINCULO_CONFIRMADO',profissionalConfirmadoId:'m1',
        pesquisasRegistro:{m1:{nome:'Dra. Alice Silva',estado:'aguardando_confirmacao',confirmacaoAdiada:true}}}},
      {modeloTeste:modelo,consultarStatus:vi.fn(),registrarPeriodoConferencia});
    expect(registrarPeriodoConferencia).not.toHaveBeenCalled();
    expect(resposta).toContain('Dra. Alice Silva já está vinculada');
    expect(resposta).not.toMatch(/ainda aguarda vínculo|não emite desde/);
    modelo.assertComplete();
  });
  it('período já guardado também não permite texto livre inventar ausência de notas',async()=>{
    const modelo=new ScriptedModel([[assistantMessage('Você parou de emitir nessa data e Alice precisa ser vinculada.')]]);
    const resposta=await responderAgente({texto:'Sobre 1 de novembro...',profissionais,
      estadoConversa:{faseAgenda:'VINCULO_CONFIRMADO',profissionalConfirmadoId:'m1',
        periodoConferencia:{profissionalId:'m1',inicio:'2026-11-01'}}},
      {modeloTeste:modelo,consultarStatus:vi.fn(),registrarPeriodoConferencia:vi.fn()});
    expect(resposta).not.toMatch(/parou de emitir|precisa ser vinculada/);
    expect(resposta).toContain('período solicitado é 01/11/2026');
    expect(resposta).toContain('verificação do certificado');
    modelo.assertComplete();
  });
  it('modelo sem ferramenta de período não pode transformar a data em conclusão fiscal',async()=>{
    const modelo=new ScriptedModel([[assistantMessage('Você não emite notas desde 1 de novembro.')]]);
    const registrarPeriodoConferencia=vi.fn();
    const resposta=await responderAgente({texto:'Desde 1 de novembro de 2026.',profissionais,
      estadoConversa:{profissionalConfirmadoId:'m1',perguntaPendente:'periodo'}},
      {modeloTeste:modelo,consultarStatus:vi.fn(),registrarPeriodoConferencia});
    expect(registrarPeriodoConferencia).not.toHaveBeenCalled();
    expect(resposta).not.toContain('Você não emite');
    expect(resposta).toContain('data inicial da conferência');
    modelo.assertComplete();
  });
  it('certificado distingue falha de prontidão de URL inválida e mantém recuperação concreta',async()=>{
    for(const falha of ['prontidao','origem'] as const){
      const modelo=new ScriptedModel([
        [functionCall('orientar_certificado_seguro',{profissional:'Alice'},{callId:'cert'})],
        [assistantMessage('A página está fora do ar. Se precisar de mais informações, é só avisar.')]
      ]);
      const consultarProntidao=vi.fn(async()=>{
        if(falha==='prontidao')throw Object.assign(new Error('segredo-nao-expor'),{code:'42703'});
        return {certificadoValido:false,dadosProfissionaisCompletos:false,dadosFiscaisConfirmados:false,liberadoParaEmitir:false};
      });
      const resposta=await responderAgente({texto:'Podemos seguir com o certificado?',profissionais,
        painelUrl:falha==='origem'?'http://inseguro.example.test':'https://homologacao.example.test',
        estadoConversa:{profissionalConfirmadoId:'m1'}},
        {modeloTeste:modelo,consultarStatus:vi.fn(),consultarProntidao});
      expect(resposta).toContain('próximo passo');
      expect(resposta).not.toMatch(/fora do ar|é só avisar|segredo-nao-expor/);
      expect(resposta).toContain(falha==='prontidao'?'Isso não comprova que a página esteja indisponível':'origem HTTPS');
      modelo.assertComplete();
    }
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


describe('confirmação contextual de médicos descobertos com evidência',()=>{
  const profissionais=[{id:'m1',nome:'Dra. Alice Silva'}];
  const conectado={tribemd:{salvo:true,conectada:true},amplimed:{salvo:true,conectada:true}};
  const estado={agendaEscolhida:'tribemd' as const,faseAgenda:'CONFIRMACAO_PENDENTE' as const,
    descoberta:{agenda:'tribemd' as const,nomes:['Bruno Costa']}};
  it('uma pergunta não autoriza vincular Bruno',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('confirmar_profissionais_descobertos',{agenda:'tribemd',profissionalBase:'Alice',
        decisao:'esclarecer',nomes:['Bruno Costa']},{callId:'duvida'})]
    ]);
    const confirmarProfissionais=vi.fn(),aoDiagnostico=vi.fn();
    const resposta=await responderAgente({texto:'Quem é o Bruno Costa?',profissionais,estadoConversa:estado},{
      modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(conectado),confirmarProfissionais,aoDiagnostico
    });
    expect(confirmarProfissionais).not.toHaveBeenCalled();
    expect(resposta).not.toContain('Vinculei');
    expect(aoDiagnostico.mock.calls[0][0].ferramentas[0].codigo).toBe('ESCLARECIMENTO');
    modelo.assertComplete();
  });
  it('confirma um único alvo comprovado sem consultar novamente o portal',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('confirmar_profissionais_descobertos',{agenda:'tribemd',profissionalBase:'Alice',
        decisao:'confirmar',nomes:['Bruno Costa']},{callId:'vincular'})]
    ]);
    const confirmarProfissionais=vi.fn().mockResolvedValue({ok:true,nomes:['Bruno Costa'],
      medicos:[{id:'m2',nome:'Bruno Costa'}]});
    const descobrirProfissionais=vi.fn(),aoDiagnostico=vi.fn();
    const resposta=await responderAgente({texto:'Confirmo vincular o Bruno Costa',
      profissionais,estadoConversa:estado},{
      modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(conectado),
      descobrirProfissionais,confirmarProfissionais,aoDiagnostico
    });
    expect(confirmarProfissionais).toHaveBeenCalledExactlyOnceWith('m1',['Bruno Costa']);
    expect(descobrirProfissionais).not.toHaveBeenCalled();
    expect(aoDiagnostico.mock.calls[0][0].ferramentas[0].codigo).toBe('PROFISSIONAIS_CONFIRMADOS');
    expect(resposta).toContain('Vinculei Bruno Costa');
    expect(resposta).not.toContain('O CRM falhou');
    modelo.assertComplete();
  });
  it('um sim com vários profissionais não escolhe um nome arbitrariamente',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('confirmar_profissionais_descobertos',{agenda:'tribemd',profissionalBase:'Alice',
        decisao:'confirmar',nomes:['Bruno Costa']},{callId:'ambigua'})]
    ]);
    const confirmarProfissionais=vi.fn();
    const resposta=await responderAgente({texto:'sim',profissionais,
      estadoConversa:{...estado,descoberta:{agenda:'tribemd',nomes:['Bruno Costa','Carla Dias']}}
    },{modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(conectado),confirmarProfissionais});
    expect(confirmarProfissionais).not.toHaveBeenCalled();
    expect(resposta).not.toContain('Bruno foi adicionado');
    modelo.assertComplete();
  });
  it('não vincula um nome fora da lista autenticada',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('confirmar_profissionais_descobertos',{agenda:'tribemd',profissionalBase:'Alice',
        decisao:'confirmar',nomes:['Carla Dias']},{callId:'fora-lista'})]
    ]);
    const confirmarProfissionais=vi.fn();
    await responderAgente({texto:'Vincula Carla Dias',profissionais,estadoConversa:estado},{
      modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue(conectado),confirmarProfissionais
    });
    expect(confirmarProfissionais).not.toHaveBeenCalled();
    modelo.assertComplete();
  });
  it('negação não cadastra nem pesquisa',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('confirmar_profissionais_descobertos',{agenda:'tribemd',profissionalBase:'Alice',
        decisao:'negar',nomes:['Bruno Costa']},{callId:'nao'})]
    ]);
    const confirmarProfissionais=vi.fn();
    const resposta=await responderAgente({texto:'Não é ele',profissionais,estadoConversa:estado},{
      modeloTeste:modelo,consultarStatus:vi.fn(),confirmarProfissionais
    });
    expect(confirmarProfissionais).not.toHaveBeenCalled();
    expect(resposta).toContain('não vinculei');
    modelo.assertComplete();
  });
});

describe('CRM/RQE não são preenchidos nem confirmados por números no WhatsApp',()=>{
  const medicos=[{id:'m1',nome:'Dra. Alice Silva'}];
  it.each([
    'Meu CRM é 12345/RS',
    'O CRM 12345/RS está certo?',
    'Confirmo CRM 12345/RS',
    'Na verdade, o CRM correto é 67890/RS'
  ])('nenhum número escrito no WhatsApp chama gravação: %s',async texto=>{
    const modelo=new ScriptedModel([
      [assistantMessage('Para preencher ou corrigir números, use o cofre seguro.')]
    ]);
    const salvarDadosProfissionais=vi.fn();
    const resposta=await responderAgente({texto,profissionais:medicos,
      estadoConversa:{profissionalConfirmadoId:'m1'}},{
      modeloTeste:modelo,consultarStatus:vi.fn(),salvarDadosProfissionais
    });
    expect(salvarDadosProfissionais).not.toHaveBeenCalled();
    expect(resposta).toContain('cofre seguro');
    expect(JSON.stringify(modelo.calls[0]?.request.tools)).not.toContain('confirmar_dados_profissionais');
    modelo.assertComplete();
  });
  it('sem vínculo, não oferece cadastro por WhatsApp nem pesquisa',async()=>{
    const modelo=new ScriptedModel([[assistantMessage('Primeiro preciso confirmar o vínculo.') ]]);
    const salvarDadosProfissionais=vi.fn();
    const resposta=await responderAgente({texto:'CRM: 12345/RS',profissionais:medicos},{
      modeloTeste:modelo,consultarStatus:vi.fn(),salvarDadosProfissionais
    });
    expect(salvarDadosProfissionais).not.toHaveBeenCalled();
    expect(resposta).toContain('confirmar o vínculo');
    modelo.assertComplete();
  });
});

describe('negações não são autorizações de escrita',()=>{
  it('não adiciona médico quando a pessoa diz que não confirma',async()=>{
    const modelo=new ScriptedModel([
      [functionCall('confirmar_profissionais_descobertos',{
        agenda:'tribemd',profissionalBase:'Alice',decisao:'negar',nomes:['Bruno Costa']
      },{callId:'negou-cadastro'})]
    ]);
    const confirmarProfissionais=vi.fn();
    const diagnostico=vi.fn();
    const resposta=await responderAgente({
      texto:'Não confirmo adicionar Bruno Costa à conta.',
      profissionais:[{id:'m1',nome:'Dra. Alice Silva'}],
      estadoConversa:{agendaEscolhida:'tribemd',profissionalConfirmadoId:'m1',faseAgenda:'CONFIRMACAO_PENDENTE',descoberta:{agenda:'tribemd',nomes:['Bruno Costa']}}
    },{modeloTeste:modelo,consultarStatus:vi.fn().mockResolvedValue({
      tribemd:{salvo:true,conectada:true},amplimed:{salvo:false,conectada:false}
    }),descobrirProfissionais:vi.fn().mockResolvedValue({ok:true,nomes:['Bruno Costa']}),
      confirmarProfissionais,aoDiagnostico:diagnostico});
    expect(confirmarProfissionais).not.toHaveBeenCalled();
    expect(resposta).toContain('não vinculei');
    expect(diagnostico.mock.calls[0][0].ferramentas[0].codigo).toBe('NAO_AUTORIZOU');
    modelo.assertComplete();
  });

  it.each(['Não confirmo CRM: 12345/RS','Não quero que salve CRM: 12345/RS'])(
    'negação mantém cadastro intacto: %s',async texto=>{
      const modelo=new ScriptedModel([[assistantMessage('Não salvei seus dados profissionais.') ]]);
      const salvarDadosProfissionais=vi.fn();
      await responderAgente({texto,profissionais:[{id:'m1',nome:'Dra. Alice Silva'}],
        estadoConversa:{profissionalConfirmadoId:'m1'}},{
        modeloTeste:modelo,consultarStatus:vi.fn(),salvarDadosProfissionais
      });
      expect(salvarDadosProfissionais).not.toHaveBeenCalled();
      modelo.assertComplete();
    });

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
