import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import { criarRouterWebhookAgente } from '../src/agente/webhook.js';
import { responderAgente } from '../src/agente/agente.js';

const evento = {
  instance: 'notomed_assistente',
  event: 'messages.upsert',
  data: {
    key: { id: 'mensagem-1', remoteJid: '5551999998888@s.whatsapp.net', fromMe: false },
    message: { conversation: 'Noto, verifica a agenda da Alice' }
  }
};

function preparar(overrides: Record<string, unknown> = {}) {
  const query = vi.fn(async (sql: string, parametros: unknown[]) => {
    if (sql.includes('distinct conta_id')) return { rows: [{ conta_id: 'conta-a' }] };
    if (sql.includes('from medicos')) {
      expect(parametros).toEqual(['conta-a']);
      return { rows: [{ id: 'alice-id', nome_completo: 'Alice Souza' }] };
    }
    throw new Error('SQL não previsto');
  });
  const modeloTeste = new ScriptedModel([
    [functionCall('consultar_status_agendas', { profissional: 'Alice' }, { callId: 'c1' })],
    [assistantMessage('A agenda TribeMD da Alice está conectada.')]
  ]);
  const enviar = vi.fn().mockResolvedValue(true);
  const consultarStatus = vi.fn().mockResolvedValue({
    tribemd: { salvo: true, conectada: true }, amplimed: { salvo: false, conectada: false }
  });
  const deps = {
    pool: { query } as unknown as pg.Pool,
    ativo: true, envioAtivo: true, segredo: 'segredo-de-teste',
    instancia: 'notomed_assistente', allowlist: ['51999998888'],
    modeloTeste, consultarStatus, enviar,
    ...overrides
  };
  const app = express();
  app.use(express.json());
  app.use('/webhook/evolution', criarRouterWebhookAgente(deps));
  return { app, query, modeloTeste, enviar, consultarStatus };
}

async function comServidor(
  app: ReturnType<typeof express>,
  fn: (postar: (body: unknown, segredo?: string, rota?: string) => Promise<Response>) => Promise<void>
) {
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const endereco = server.address() as AddressInfo;
  const postar = (body: unknown, segredo = 'segredo-de-teste', rota='/webhook/evolution') => fetch(
    'http://127.0.0.1:' + endereco.port + rota,
    { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': segredo }, body: JSON.stringify(body) }
  );
  try { await fn(postar); }
  finally { await new Promise<void>((r, j) => server.close(e => e ? j(e) : r())); }
}

describe('Noto SDK — webhook autenticado e isolado', () => {
  it('entrega o código Amplimed ao Cofre antes de gravar conversa ou chamar o modelo', async () => {
    const receberCodigoAmplimed = vi.fn().mockReturnValue(true);
    const { app, query, modeloTeste, enviar } = preparar({ receberCodigoAmplimed, persistirConversa: true });
    const resposta = 'AMPLIMED deadbeef 444444';
    const mensagem = {...evento, data:{...evento.data, message:{conversation:resposta}}};
    await comServidor(app, async postar => {
      expect((await postar(mensagem, 'invalido')).status).toBe(401);
      expect(receberCodigoAmplimed).not.toHaveBeenCalled();
      expect((await postar(mensagem)).status).toBe(204);
    });
    expect(receberCodigoAmplimed).toHaveBeenCalledExactlyOnceWith('conta-a', '5551999998888', resposta);
    expect(query).toHaveBeenCalledOnce();
    expect(JSON.stringify(query.mock.calls)).not.toContain('444444');
    expect(modeloTeste.calls).toHaveLength(0);
    expect(enviar).not.toHaveBeenCalled();
  });
  it('usa o estado recuperado do Cofre no primeiro turno e exige a ferramenta', async () => {
    let estado:Record<string,unknown>={agendaEscolhida:'tribemd',
      descoberta:{agenda:'tribemd',nomes:['Alice Souza']}};
    let leituras=0;
    const query=vi.fn(async(sql:string,params:unknown[]=[])=>{
      if(sql.includes('distinct conta_id'))return {rows:[{conta_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}]};
      if(sql.startsWith('select id,nome_completo from medicos'))return {rows:[]};
      if(sql.startsWith('select estado from noto_agent_conversas')){
        leituras++;return {rows:[{estado:structuredClone(estado)}]};
      }
      if(sql.startsWith('insert into noto_agent_mensagens'))return {rows:[{mensagem_id:params[2]}]};
      if(sql.startsWith('update public.noto_agent_conversas as c')){
        estado={...estado,faseAgenda:'CONFIRMACAO_PENDENTE',origemDescoberta:'legado_validado',
          perguntaPendente:'confirmar_profissional'};
        return {rows:[{conta_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}]};
      }
      if(sql.startsWith('update public.noto_agent_conversas c set')){
        estado={...estado,faseAgenda:'VINCULO_CONFIRMADO',
          profissionalConfirmadoId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',descoberta:{agenda:'tribemd',nomes:[]}};
        return {rows:[{conta_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}]};
      }
      if(sql.startsWith('update noto_agent_mensagens')||sql.startsWith('insert into noto_agent_conversas'))return {rows:[]};
      throw Error('SQL não previsto: '+sql);
    });
    const modeloTeste=new ScriptedModel([[functionCall('confirmar_profissionais_descobertos',{
      agenda:'tribemd',profissionalBase:null,decisao:'confirmar',nomes:[]
    },{callId:'confirmar'})]]);
    const confirmarProfissionais=vi.fn().mockResolvedValue({ok:true,medicos:[{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',nome:'Alice Souza'}]});
    const agendarPesquisa=vi.fn().mockResolvedValue('agendada');
    const {app,enviar}=preparar({pool:{query} as unknown as pg.Pool,modeloTeste,
      persistirConversa:true,listarTrabalhos:async()=>[],
      referenciaContaAgenda:async()=> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',confirmarProfissionais,agendarPesquisa});
    await comServidor(app,async postar=>expect((await postar({...evento,data:{...evento.data,
      message:{conversation:'Sim, sou eu.'}}})).status).toBe(200));
    expect(leituras).toBeGreaterThanOrEqual(3);
    expect(modeloTeste.calls[0]!.request.modelSettings.toolChoice).toBe('confirmar_profissionais_descobertos');
    expect(confirmarProfissionais).toHaveBeenCalledOnce();
    expect(agendarPesquisa).toHaveBeenCalledExactlyOnceWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Alice Souza');
    expect(enviar.mock.calls.map(c=>c[1]).join(' ')).toContain('Vinculei Alice Souza à sua conta.');
    expect(enviar.mock.calls.map(c=>c[1]).join(' ')).not.toContain('Vou pesquisar');
    modeloTeste.assertComplete();
  });

  it('adiamento preserva sugestão e vínculo após o save tardio do webhook',async()=>{
    const id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const pesquisa={nome:'Alice Souza',estado:'aguardando_confirmacao',razao:'ENCONTRADO',
      candidatos:[{crm:'12345/RS',uf:'RS',rqes:[],origem:'OpenSerp'}]};
    let estado:Record<string,unknown>={faseAgenda:'VINCULO_CONFIRMADO',profissionalConfirmadoId:id,
      pesquisasRegistro:{[id]:pesquisa}};
    const query=vi.fn(async(sql:string,params:unknown[]=[])=>{
      if(sql.includes('distinct conta_id'))return {rows:[{conta_id:'conta-a'}]};
      if(sql.startsWith('select id,nome_completo from medicos'))return {rows:[{id,nome_completo:'Alice Souza'}]};
      if(sql.startsWith('select estado from noto_agent_conversas'))return {rows:[{estado:structuredClone(estado)}]};
      if(sql.startsWith('insert into noto_agent_mensagens'))return {rows:[{mensagem_id:params[2]}]};
      if(sql.startsWith('insert into noto_agent_conversas')){
        const delta=JSON.parse(String(params[1]));
        expect(delta).not.toHaveProperty('pesquisasRegistro');
        estado={...estado,...delta};return {rows:[]};
      }
      if(sql.startsWith('update noto_agent_mensagens'))return {rows:[]};
      throw Error('SQL não previsto');
    });
    const adiarConfirmacaoRegistro=vi.fn(async()=>{
      estado={...estado,pesquisasRegistro:{[id]:{...pesquisa,confirmacaoAdiada:true}}};return true;
    });
    const aprovarRegistroProfissional=vi.fn();
    const modeloTeste=new ScriptedModel([
      [functionCall('revisar_registro_profissional',{profissional:'Alice',decisao:'adiar'},{callId:'duvida'})],
      [assistantMessage('Podemos continuar.')]
    ]);
    const {app,enviar}=preparar({pool:{query} as unknown as pg.Pool,persistirConversa:true,
      modeloTeste,adiarConfirmacaoRegistro,aprovarRegistroProfissional});
    await comServidor(app,async postar=>expect((await postar({...evento,data:{...evento.data,
      message:{conversation:'Não sei confirmar esses dados agora.'}}})).status).toBe(200));
    expect(estado).toMatchObject({profissionalConfirmadoId:id,faseAgenda:'VINCULO_CONFIRMADO',
      pesquisasRegistro:{[id]:{...pesquisa,confirmacaoAdiada:true}}});
    expect(aprovarRegistroProfissional).not.toHaveBeenCalled();
    expect(enviar.mock.calls.map(c=>c[1]).join(' ')).toContain('Desde quando');
    modeloTeste.assertComplete();
  });

  it.each(['periodo',null,undefined] as const)('período persiste sem histórico de emissão ou reabrir CRM (pergunta=%s)',async(pergunta)=>{
    const id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const pesquisa={nome:'Alice Souza',estado:'aguardando_confirmacao',confirmacaoAdiada:true,
      candidatos:[{crm:'36948/RS',uf:'RS',rqes:[],origem:'OpenSerp'}]};
    let estado:Record<string,unknown>={profissionalConfirmadoId:id,faseAgenda:'VINCULO_CONFIRMADO',
      ...(pergunta!==undefined?{perguntaPendente:pergunta}:{}),pesquisasRegistro:{[id]:pesquisa}};
    const query=vi.fn(async(sql:string,params:unknown[]=[])=>{
      if(sql.includes('distinct conta_id'))return {rows:[{conta_id:'conta-a'}]};
      if(sql.startsWith('select id,nome_completo from medicos'))return {rows:[{id,nome_completo:'Alice Souza'}]};
      if(sql.startsWith('select estado from noto_agent_conversas'))return {rows:[{estado:structuredClone(estado)}]};
      if(sql.startsWith('insert into noto_agent_mensagens'))return {rows:[{mensagem_id:params[2]}]};
      if(sql.startsWith('update public.noto_agent_conversas c set')){
        estado={...estado,periodoConferencia:{profissionalId:params[1],inicio:params[2]},perguntaPendente:null};
        return {rows:[{conta_id:'conta-a'}]};
      }
      if(sql.startsWith('insert into noto_agent_conversas')){
        const delta=JSON.parse(String(params[1]));
        expect(delta).not.toHaveProperty('periodoConferencia');
        expect(delta).not.toHaveProperty('perguntaPendente');
        expect(delta).not.toHaveProperty('pesquisasRegistro');
        estado={...estado,...delta};return {rows:[]};
      }
      if(sql.startsWith('update noto_agent_mensagens'))return {rows:[]};
      throw Error('SQL não previsto');
    });
    const modeloTeste=new ScriptedModel([[functionCall('registrar_periodo_conferencia',{
      decisao:'definir',inicio:'2026-11-01'
    },{callId:'periodo'})]]);
    const {app,enviar}=preparar({pool:{query} as unknown as pg.Pool,persistirConversa:true,
      modeloTeste,painelUrl:'https://homologacao.example.test',consultarProntidao:async()=>({
        certificadoValido:false,dadosProfissionaisCompletos:false,dadosFiscaisConfirmados:false,liberadoParaEmitir:false})});
    await comServidor(app,async postar=>expect((await postar({...evento,data:{...evento.data,
      message:{conversation:'Desde 1 de novembro de 2026.'}}})).status).toBe(200));
    expect(estado).toMatchObject({periodoConferencia:{profissionalId:id,inicio:'2026-11-01'},
      perguntaPendente:null,pesquisasRegistro:{[id]:pesquisa}});
    const texto=enviar.mock.calls.map(c=>c[1]).join(' ');
    expect(texto).toContain('etapa=certificado');
    expect(texto).not.toMatch(/não emite|36948/);
    expect(modeloTeste.calls[0]!.request.modelSettings.toolChoice).toBe('continuar_onboarding');
    modeloTeste.assertComplete();
  });

  it.each([true,false])('CRM e certificado: URL única sem preview, independente da fala, aceite=%s',async(aceiteLink)=>{
    const id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const pesquisa={nome:'Alice Souza',estado:'aguardando_confirmacao',confirmacaoAdiada:true,razao:'ENCONTRADO',
      candidatos:[{crm:'36948/RS',uf:'RS',rqes:[],origem:'OpenSerp'}]};
    let estado:Record<string,unknown>={profissionalConfirmadoId:id,faseAgenda:'VINCULO_CONFIRMADO',
      perguntaPendente:null,pesquisasRegistro:{[id]:pesquisa}};
    const query=vi.fn(async(sql:string,params:unknown[]=[])=>{
      if(sql.includes('distinct conta_id'))return {rows:[{conta_id:'conta-a'}]};
      if(sql.startsWith('select id,nome_completo from medicos'))return {rows:[{id,nome_completo:'Alice Souza'}]};
      if(sql.startsWith('select estado from noto_agent_conversas'))return {rows:[{estado:structuredClone(estado)}]};
      if(sql.startsWith('insert into noto_agent_mensagens'))return {rows:[{mensagem_id:params[2]}]};
      if(sql.startsWith('insert into noto_agent_conversas')){
        const delta=JSON.parse(String(params[1]));expect(delta).not.toHaveProperty('pesquisasRegistro');
        estado={...estado,...delta};return {rows:[]};
      }
      if(sql.startsWith('update noto_agent_mensagens'))return {rows:[]};
      throw Error('SQL não previsto');
    });
    const aprovarRegistroProfissional=vi.fn(async()=>{
      estado={...estado,pesquisasRegistro:{[id]:{...pesquisa,estado:'confirmada'}}};
      return {ok:true,nome:'Alice Souza',crm:'36948/RS',rqe:null};
    });
    const modeloTeste=new ScriptedModel([
      [functionCall('continuar_onboarding',{profissional:'Alice',intencoes:['aprovar_registro','consultar_certificado'],
        inicioPeriodo:null,crmConfirmado:'36948/RS',rqeConfirmado:null,camposConfirmados:['crm']},{callId:'composto'})],
      [assistantMessage(JSON.stringify({texto:'Pronto, o CRM ficou salvo. Abra a página segura para cadastrar o certificado.',
        fatos:{vinculo:'confirmado',crm:'confirmado',crmValor:'36948/RS',periodo:'pendente',inicioPeriodo:null,emitiuNota:false,consultouNotas:false},
        acoesConcluidas:['crm_salvo','pagina_certificado_preparada']}))]
    ]);
    const url='https://homologacao.example.test/?medicoId='+id+'&etapa=certificado';
    const enviar=vi.fn(async(_telefone:string,texto:string)=>texto===url?aceiteLink:true);
    const registrarDiagnostico=vi.fn();
    const {app}=preparar({pool:{query} as unknown as pg.Pool,persistirConversa:true,modeloTeste,enviar,
      diagnosticoAtivo:true,registrarDiagnostico,aprovarRegistroProfissional,painelUrl:'https://homologacao.example.test',
      consultarProntidao:async()=>({certificadoValido:false,dadosProfissionaisCompletos:true,dadosFiscaisConfirmados:false,liberadoParaEmitir:false})});
    const pedido={...evento,data:{...evento.data,message:{conversation:'O CRM 36948/RS está certo, pode confirmar e salvar. E me manda o link da página do certificado, que não veio.'}}};
    await comServidor(app,async postar=>{
      expect((await postar(pedido)).status).toBe(aceiteLink?200:503);
      expect(enviar.mock.calls.map(c=>c[1])).toEqual(aceiteLink
        ? [url,'Pronto, o CRM ficou salvo.','Abra a página segura para cadastrar o certificado.']
        : [url]);
      expect((await postar(pedido)).status).toBe(200);
    });
    expect(aprovarRegistroProfissional).toHaveBeenCalledExactlyOnceWith('conta-a',id,{confirmarRqe:false});
    expect(enviar.mock.calls.filter(c=>c[1]===url)).toHaveLength(1);
    expect(enviar).toHaveBeenCalledWith('5551999998888',url,{linkPreview:false});
    expect(estado).toMatchObject({faseAgenda:'VINCULO_CONFIRMADO',pesquisasRegistro:{[id]:{estado:'confirmada'}}});
    expect(registrarDiagnostico.mock.calls[0]?.[0]).toMatchObject({
      linkCertificado:{produzidos:1,nosBaloes:1,aceitosApi:aceiteLink?1:0},envio:aceiteLink?'ENVIADO':'FALHOU'});
    modeloTeste.assertComplete();
  });

  it('rejeita segredo inválido antes de consultar banco ou modelo', async () => {
    const { app, query, modeloTeste, enviar } = preparar();
    await comServidor(app, async postar => expect((await postar(evento, 'errado')).status).toBe(401));
    expect(query).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
    expect(modeloTeste.calls).toHaveLength(0);
  });

  it('executa o loop com tool real apenas na conta autorizada e deduplica evento', async () => {
    const { app, query, modeloTeste, enviar, consultarStatus } = preparar();
    await comServidor(app, async postar => {
      expect((await postar(evento)).status).toBe(200);
      expect((await postar(evento)).status).toBe(200);
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(consultarStatus).toHaveBeenCalledExactlyOnceWith('alice-id');
    expect(enviar).toHaveBeenCalledTimes(1);
    modeloTeste.assertComplete();
  });

  it('ignora mensagens próprias, grupos, instâncias alheias e números não autorizados', async () => {
    const { app, query, enviar } = preparar();
    await comServidor(app, async postar => {
      for (const body of [
        { ...evento, data: { ...evento.data, key: { ...evento.data.key, fromMe: true } } },
        { ...evento, data: { ...evento.data, key: { ...evento.data.key, remoteJid: '123456@g.us' } } },
        { ...evento, instance: 'notomed_oficial' },
        { ...evento, data: { ...evento.data, key: { ...evento.data.key, remoteJid: '5511999990000@s.whatsapp.net' } } }
      ]) expect((await postar(body)).status).toBe(204);
    });
    expect(query).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
  });

  it('não seleciona contas ambíguas', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ conta_id: 'a' }, { conta_id: 'b' }] });
    const { app, enviar } = preparar({ pool: { query } as unknown as pg.Pool });
    await comServidor(app, async postar => expect((await postar(evento)).status).toBe(204));
    expect(query).toHaveBeenCalledTimes(1);
    expect(enviar).not.toHaveBeenCalled();
  });

  it('mantém o envio desligado quando a flag está desativada', async () => {
    const { app, query, enviar } = preparar({ envioAtivo: false });
    await comServidor(app, async postar => expect((await postar(evento)).status).toBe(204));
    expect(query).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
  });

  it('sem cadastro, permite a orientação geral, não acessa cofres', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const modeloTeste = new ScriptedModel([
      [functionCall('consultar_contexto_conta', {}, { callId: 'c1' })],
      [assistantMessage('Sou o Noto! Qual agenda você usa: TribeMD, Amplimed ou outra?')]
    ]);
    const consultarStatus = vi.fn();
    const { app, enviar } = preparar({
      pool: { query } as unknown as pg.Pool, modeloTeste, consultarStatus, painelUrl: 'https://noto.exemplo.com/'
    });
    await comServidor(app, async postar => expect((await postar(evento)).status).toBe(200));
    expect(query).toHaveBeenCalledTimes(1);
    expect(consultarStatus).not.toHaveBeenCalled();
    expect(enviar).toHaveBeenCalledWith('5551999998888', expect.stringContaining('Qual agenda'));
    modeloTeste.assertComplete();
  });

  it('preserva contexto de resposta curta na mesma conta sem armazenar mensagens do usuário', async () => {
    const modeloTeste = new ScriptedModel([
      [assistantMessage('Você utiliza TribeMD, Amplimed ou outra?')],
      [assistantMessage('Perfeito, Amplimed. Vamos identificar o profissional antes de conectar.')]
    ]);
    const { app, enviar } = preparar({ modeloTeste });
    await comServidor(app, async postar => {
      expect((await postar(evento)).status).toBe(200);
      expect((await postar({
        ...evento, data: { ...evento.data, key: { ...evento.data.key, id: 'mensagem-2' }, message: { conversation: 'Amplimed' } }
      })).status).toBe(200);
    });
    expect(modeloTeste.calls).toHaveLength(2);
    expect(JSON.stringify(modeloTeste.calls[1]?.request.input)).toContain('Você utiliza TribeMD');
    expect(enviar.mock.calls.map(c => c[1])).toEqual(['Você utiliza TribeMD, Amplimed ou outra?', 'Perfeito, Amplimed.', 'Vamos identificar o profissional antes de conectar.']);
    modeloTeste.assertComplete();
  });
  it('diagnóstico por mensagem registra ferramentas e tokens sem guardar texto, telefone ou ID bruto', async () => {
    const registrarDiagnostico = vi.fn();
    const { app, enviar } = preparar({ diagnosticoAtivo: true, registrarDiagnostico });
    await comServidor(app, async postar => expect((await postar(evento)).status).toBe(200));
    expect(enviar).toHaveBeenCalledOnce();
    expect(registrarDiagnostico).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      tipo: 'noto_agent_execucao', versao: 1, conta: 'CADASTRADA', envio: 'ENVIADO',
      agente: expect.objectContaining({
        codigo: 'RESPOSTA',
        ferramentas: [expect.objectContaining({ nome: 'consultar_status_agendas', codigo: 'STATUS_CONECTADO' })],
        uso: expect.objectContaining({ tokensTotal: expect.any(Number) })
      }),
      mensagemRef: expect.stringMatching(/^[a-f0-9]{24}$/),
      respostaRef: expect.stringMatching(/^[a-f0-9]{24}$/)
    }));
    const registro = JSON.stringify(registrarDiagnostico.mock.calls);
    for (const privado of ['5551999998888', 'mensagem-1', 'Noto, verifica a agenda da Alice', 'Alice Souza', 'alice-id']) {
      expect(registro).not.toContain(privado);
    }
  });

  it('diagnóstico desativado não gera registros', async () => {
    const registrarDiagnostico = vi.fn();
    const { app } = preparar({ diagnosticoAtivo: false, registrarDiagnostico });
    await comServidor(app, async postar => expect((await postar(evento)).status).toBe(200));
    expect(registrarDiagnostico).not.toHaveBeenCalled();
  });

});


describe('mensagens naturais e efeitos seguros no webhook', () => {
  function bancoComReserva() {
    const registros=new Set<string>();
    const query=vi.fn(async (sql:string, parametros:unknown[]=[]) => {
      if (sql.includes('distinct conta_id')) return {rows:[{conta_id:'conta-a'}]};
      if (sql.includes('from medicos')) return {rows:[{id:'alice-id',nome_completo:'Alice Souza'}]};
      if (sql.startsWith('select estado from noto_agent_conversas')) return {rows:[{estado:{agendaEscolhida:'tribemd',profissionalConfirmadoId:'alice-id'}}]};
      if (sql.startsWith('insert into noto_agent_mensagens')) {
        const chave=JSON.stringify(parametros);
        if(registros.has(chave))return {rows:[]};
        registros.add(chave);return {rows:[{mensagem_id:parametros[2]}]};
      }
      if (sql.startsWith('update noto_agent_mensagens')||sql.startsWith('insert into noto_agent_conversas')) return {rows:[],rowCount:1};
      throw Error('SQL_NAO_PERMITIDO_NO_TESTE');
    });
    return {query};
  }

  it('marca lida, reage por intenção, digita, envia balões em ordem e conclui verificação com ✅', async () => {
    const {query}=bancoComReserva();
    const enviar=vi.fn().mockResolvedValue(true);
    const marcarLida=vi.fn().mockResolvedValue(true);
    const reagir=vi.fn().mockResolvedValue(true);
    const presenca=vi.fn().mockResolvedValue(true);
    const modeloTeste=new ScriptedModel([
      [functionCall('consultar_status_agendas',{profissional:'Alice'},{callId:'verificar'})],
      [assistantMessage('Conferi sua agenda. A TribeMD está conectada. Podemos continuar.')]
    ]);
    const consultarStatus=vi.fn().mockResolvedValue({
      tribemd:{salvo:true,conectada:true},amplimed:{salvo:false,conectada:false}
    });
    const {app}=preparar({pool:{query} as unknown as pg.Pool,modeloTeste,consultarStatus,
      enviar,marcarLida,reagir,presenca,persistirConversa:true});
    const eventoVerificar={...evento,data:{...evento.data,message:{conversation:'Consegue verificar a agenda da Alice?'}}};
    await comServidor(app,async postar=>{
      expect((await postar(eventoVerificar)).status).toBe(200);
      expect((await postar(eventoVerificar)).status).toBe(200);
    });
    expect(marcarLida).toHaveBeenCalledExactlyOnceWith(evento.data.key);
    expect(reagir.mock.calls.map(c=>c[1])).toEqual(['🔎','✅']);
    expect(presenca.mock.calls[0]).toEqual(['5551999998888','composing']);
    expect(presenca.mock.calls.at(-1)).toEqual(['5551999998888','paused']);
    expect(enviar.mock.calls.map(c=>c[1])).toEqual([
      'Conferi sua agenda.','A TribeMD está conectada.','Podemos continuar.'
    ]);
    expect(query.mock.calls.some(c=>String(c[0]).includes('insert into noto_agent_mensagens'))).toBe(true);
    expect(query.mock.calls.some(c=>String(c[0]).includes('insert into noto_agent_conversas'))).toBe(true);
    expect(consultarStatus).toHaveBeenCalledExactlyOnceWith('alice-id');
    modeloTeste.assertComplete();
  });

  it('parada parcial preserva reserva; webhook repetido não duplica balões nem marca tarefa como concluída', async () => {
    const {query}=bancoComReserva();
    const enviar=vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const reagir=vi.fn().mockResolvedValue(true);
    const presenca=vi.fn().mockResolvedValue(true);
    const modeloTeste=new ScriptedModel([[assistantMessage('Vou conferir. Ainda não consegui confirmar a conexão.')]]);
    const {app}=preparar({pool:{query} as unknown as pg.Pool,modeloTeste,enviar,reagir,presenca,
      persistirConversa:true});
    await comServidor(app,async postar=>{
      expect((await postar(evento)).status).toBe(503);
      expect((await postar(evento)).status).toBe(200);
    });
    expect(enviar.mock.calls.map(c=>c[1])).toEqual(['Vou conferir.','Ainda não consegui confirmar a conexão.']);
    expect(reagir.mock.calls.some(c=>c[1]==='✅')).toBe(false);
    expect(query.mock.calls.some(c=>String(c[0]).includes('update noto_agent_mensagens')&&c[1]?.[3]==='incerta')).toBe(true);
    expect(presenca.mock.calls.at(-1)).toEqual(['5551999998888','paused']);
    modeloTeste.assertComplete();
  });

  it('não envia visto, reação ou presença antes da autorização do número e do segredo', async () => {
    const marcarLida=vi.fn(),reagir=vi.fn(),presenca=vi.fn();
    const {app,query}=preparar({marcarLida,reagir,presenca});
    await comServidor(app,async postar=>{
      expect((await postar(evento,'segredo-errado')).status).toBe(401);
      expect((await postar({...evento,data:{...evento.data,key:{...evento.data.key,remoteJid:'5511888777666@s.whatsapp.net'}}})).status).toBe(204);
    });
    expect(query).not.toHaveBeenCalled();
    expect(marcarLida).not.toHaveBeenCalled();
    expect(reagir).not.toHaveBeenCalled();
    expect(presenca).not.toHaveBeenCalled();
  });
});


describe('retry seguro no modo durável',()=>{
  it('falha de consulta antes da reserva permite replay; depois da reserva o mesmo evento não reenvia',async()=>{
    let indisponivel=true;
    const reservados=new Set<string>();
    const query=vi.fn(async(sql:string,params:unknown[]=[])=>{
      if(sql.includes('distinct conta_id')){
        if(indisponivel){indisponivel=false;throw Error('BANCO_INDISPONIVEL');}
        return {rows:[{conta_id:'conta-a'}]};
      }
      if(sql.includes('from medicos'))return {rows:[{id:'alice-id',nome_completo:'Alice Souza'}]};
      if(sql.startsWith('select estado from noto_agent_conversas'))return {rows:[{estado:{}}]};
      if(sql.startsWith('insert into noto_agent_mensagens')){
        const chave=JSON.stringify(params);
        if(reservados.has(chave))return {rows:[]};
        reservados.add(chave);return {rows:[{mensagem_id:params[2]}]};
      }
      if(sql.startsWith('update noto_agent_mensagens')||sql.startsWith('insert into noto_agent_conversas'))return {rows:[],rowCount:1};
      throw Error('QUERY_NAO_PREVISTA');
    });
    const enviar=vi.fn().mockResolvedValue(true);
    const modeloTeste=new ScriptedModel([[assistantMessage('Consegui receber sua mensagem.')]]); 
    const {app}=preparar({pool:{query} as unknown as pg.Pool,modeloTeste,enviar,persistirConversa:true});
    await comServidor(app,async postar=>{
      expect((await postar(evento)).status).toBe(503);
      expect((await postar(evento)).status).toBe(200);
      expect((await postar(evento)).status).toBe(200);
    });
    expect(enviar).toHaveBeenCalledOnce();
    expect(reservados.size).toBe(1);
    modeloTeste.assertComplete();
  });
});


describe('comportamento visível e privacidade de tarefas', () => {
  it('falhas de visto, reação e presença não impedem resposta nem a parada da digitação', async () => {
    const marcarLida=vi.fn().mockRejectedValue(new Error('indisponível'));
    const reagir=vi.fn().mockRejectedValue(new Error('indisponível'));
    const presenca=vi.fn().mockRejectedValue(new Error('indisponível'));
    const modeloTeste=new ScriptedModel([[assistantMessage('Vou ajudar com isso.')]]); 
    const {app,enviar}=preparar({modeloTeste,marcarLida,reagir,presenca});
    await comServidor(app,async postar => {
      expect((await postar(evento)).status).toBe(200);
    });
    expect(enviar).toHaveBeenCalled();
    expect(presenca.mock.calls.at(-1)?.[1]).toBe('paused');
    modeloTeste.assertComplete();
  });

  it('não envia IDs originais de tarefas ao modelo', async () => {
    const modeloTeste=new ScriptedModel([[assistantMessage('Vou continuar a verificação.')]]); 
    const idPrivado='BAE569F0E38F858D';
    const resposta=await responderAgente({
      texto:'Sim, pode continuar.',
      profissionais:[{id:'alice-id',nome:'Alice Souza'}],
      estadoConversa:{ agendaEscolhida:'amplimed', tarefasPendentes:[{
        tipo:'verificar_agenda', instancia:'notomed_assistente', mensagemId:idPrivado,
        remetenteRef:'a'.repeat(24), criadaEm:Date.now(), profissionalId:'alice-id'
      }] }
    },{modeloTeste,consultarStatus:vi.fn()});
    expect(resposta).toContain('Vou continuar');
    expect(JSON.stringify(modeloTeste.calls[0]?.request.input)).not.toContain(idPrivado);
    expect(JSON.stringify(modeloTeste.calls[0]?.request.input)).not.toContain('a'.repeat(24));
    modeloTeste.assertComplete();
  });
});

describe('tarefas entre mensagens: ✅ sempre no balão original', () => {
  it('retoma a verificação no turno seguinte e reage ao pedido inicial após a ferramenta comprovar', async () => {
    const modeloTeste = new ScriptedModel([
      [assistantMessage('Vou conferir assim que você confirmar o profissional.')],
      [functionCall('consultar_status_agendas', { profissional: 'Alice' }, { callId: 'retomada' })],
      [assistantMessage('Conferi. A agenda está conectada.')]
    ]);
    const reagir = vi.fn().mockResolvedValue(true);
    const enviar = vi.fn().mockResolvedValue(true);
    const {app,consultarStatus} = preparar({ modeloTeste, reagir, enviar });
    const pedido = { ...evento, data: { ...evento.data,
      message: {conversation: 'Consegue verificar a agenda da Alice?'} } };
    const continuacao = { ...evento, data: { ...evento.data,
      key: {...evento.data.key, id: 'mensagem-2'},
      message: {conversation:'Sim, pode continuar.'} } };
    await comServidor(app,async postar => {
      expect((await postar(pedido)).status).toBe(200);
      expect((await postar(continuacao)).status).toBe(200);
      expect((await postar(continuacao)).status).toBe(200);
    });
    expect(reagir.mock.calls.map(c => c[1])).toEqual(['🔎','👍','✅']);
    expect(reagir.mock.calls.at(-1)?.[0]).toEqual(evento.data.key);
    expect(consultarStatus).toHaveBeenCalledOnce();
    modeloTeste.assertComplete();
  });

  it('não conclui solicitação de envio de link só porque verificou a agenda', async () => {
    const modeloTeste = new ScriptedModel([
      [assistantMessage('Preciso confirmar a agenda antes de enviar o link.')],
      [functionCall('consultar_status_agendas', { profissional: 'Alice' }, { callId: 'consulta' })],
      [assistantMessage('A agenda não está conectada.')]
    ]);
    const reagir = vi.fn().mockResolvedValue(true);
    const {app} = preparar({ modeloTeste, reagir });
    const pedido = {...evento,data:{...evento.data,message:{conversation:'Pode enviar o link da agenda da Alice?'}}};
    const outra = {...evento,data:{...evento.data,key:{...evento.data.key,id:'mensagem-2'},
      message:{conversation:'Sim, pode verificar.'}}};
    await comServidor(app,async postar=>{
      expect((await postar(pedido)).status).toBe(200);
      expect((await postar(outra)).status).toBe(200);
    });
    expect(reagir.mock.calls.some(c => c[1]==='✅')).toBe(false);
    modeloTeste.assertComplete();
  });

  it('não põe ✅ numa agenda indisponível nem numa mera resposta sem ferramenta', async () => {
    const modeloTeste = new ScriptedModel([
      [assistantMessage('Vou verificar a conexão.')],
      [functionCall('consultar_status_agendas', {profissional:'Alice'},{callId:'falhou'})],
      [assistantMessage('Não consegui verificar a agenda agora.')]
    ]);
    const reagir = vi.fn().mockResolvedValue(true);
    const consultarStatus = vi.fn().mockResolvedValue({
      tribemd:{salvo:true,conectada:false},
      amplimed:{salvo:false,conectada:false,indisponivel:true}
    });
    const {app} = preparar({ modeloTeste, reagir, consultarStatus });
    await comServidor(app,async postar=>{
      expect((await postar({...evento,data:{...evento.data,message:{conversation:'Consegue verificar a agenda da Alice?'}}})).status).toBe(200);
      expect((await postar({...evento,data:{...evento.data,key:{...evento.data.key,id:'mensagem-2'},
        message:{conversation:'Sim, continue.'}}})).status).toBe(200);
    });
    expect(reagir.mock.calls.some(c=>c[1]==='✅')).toBe(false);
    modeloTeste.assertComplete();
  });
});

describe('webhook: referência pertence à conta autenticada',()=>{
  const contaId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const chaveConta='conta_'+contaId;
  it('não usa cadastro provisório como médico; referência do link é obtida sob conta_id verificado',async()=>{
    const query=vi.fn(async(sql:string,params:unknown[])=>{
      if(sql.includes('distinct conta_id'))return {rows:[{conta_id:contaId}]};
      if(sql.includes('select id,nome_completo from medicos')) {
        expect(params).toEqual([contaId]);
        return {rows:[{id:'provisorio-6133',nome_completo:'Médico 6133'}]};
      }
      if(sql.includes('select id from medicos where conta_id=$1')) {
        expect(params).toEqual([contaId]);
        return {rows:[{id:'provisorio-6133'}]};
      }
      throw Error('Consulta inesperada '+sql);
    });
    const modeloTeste=new ScriptedModel([
      [functionCall('solicitar_link_seguro_agenda',{agenda:'tribemd',profissional:null},{callId:'primeiro-link'})],
      [assistantMessage('O serviço aceitou o envio do link seguro, sem confirmação de entrega ainda.')]
    ]);
    const solicitarLinkAgenda=vi.fn().mockResolvedValue({aceitoParaEnvio:true});
    const {app}=preparar({
      pool:{query} as unknown as pg.Pool,modeloTeste,
      solicitarLinkAgenda,consultarStatus:vi.fn().mockResolvedValue({
        tribemd:{salvo:false,conectada:false},amplimed:{salvo:false,conectada:false}
      })
    });
    const eventoNovo={...evento,data:{...evento.data,key:{...evento.data.key,id:'primeira-6133'},message:{conversation:'Quero conectar a TribeMD, me envie o link'}}};
    await comServidor(app,async postar=>expect((await postar(eventoNovo)).status).toBe(200));
    expect(solicitarLinkAgenda).toHaveBeenCalledExactlyOnceWith(chaveConta,'tribemd','5551999998888');
    expect(query.mock.calls.filter(([sql])=>String(sql).startsWith('select id from medicos where conta_id=$1'))).toHaveLength(1);
    expect(JSON.stringify(modeloTeste.lastCall?.request.input)).not.toContain('6133');
    modeloTeste.assertComplete();
  });


  it('conta nova sem qualquer linha em medicos inicia via token do Cofre da conta',async()=>{
    const query=vi.fn(async(sql:string,params:unknown[])=>{
      if(sql.includes('distinct conta_id'))return {rows:[{conta_id:contaId}]};
      if(sql.includes('select id,nome_completo from medicos') ||
         sql.includes('select id from medicos where conta_id=$1')) {
        expect(params).toEqual([contaId]);return {rows:[]};
      }
      throw Error('SQL não permitido');
    });
    const modeloTeste=new ScriptedModel([
      [functionCall('solicitar_link_seguro_agenda',{agenda:'tribemd',profissional:null},{callId:'conta-zero-medicos'})],
      [assistantMessage('O link seguro foi aceito para envio. A senha fica somente na página de conexão.')]
    ]);
    const solicitarLinkAgenda=vi.fn().mockResolvedValue({aceitoParaEnvio:true});
    const {app}=preparar({pool:{query} as unknown as pg.Pool,modeloTeste,solicitarLinkAgenda,
      consultarStatus:vi.fn().mockResolvedValue({
        tribemd:{salvo:false,conectada:false},amplimed:{salvo:false,conectada:false}
      })});
    const req={...evento,data:{...evento.data,key:{...evento.data.key,id:'nova-conta-zero-medicos'},
      message:{conversation:'Quero conectar a Tribe, pode mandar o link seguro?'}}};
    await comServidor(app,async postar=>expect((await postar(req)).status).toBe(200));
    expect(solicitarLinkAgenda).toHaveBeenCalledExactlyOnceWith(chaveConta,'tribemd','5551999998888');
    expect(query.mock.calls.some(([sql])=>/insert into medicos/i.test(String(sql)))).toBe(false);
    expect(JSON.stringify(modeloTeste.lastCall?.request.input)).not.toContain(contaId);
    modeloTeste.assertComplete();
  });
  it('conta já conectada sem médico conserva a sessão da própria conta',async()=>{
    const query=vi.fn(async(sql:string)=>{
      if(sql.includes('distinct conta_id'))return {rows:[{conta_id:contaId}]};
      if(sql.includes('select id,nome_completo from medicos'))return {rows:[]};
      throw Error('SQL não permitido');
    });
    const modeloTeste=new ScriptedModel([
      [functionCall('orientar_conexao_agenda',{agenda:'tribemd',profissional:null},{callId:'retomar-conectado'})],
      [assistantMessage('A sua TribeMD já está conectada. Vou descobrir os médicos da agenda.')]
    ]);
    const consultarStatus=vi.fn().mockResolvedValue({
      tribemd:{salvo:true,conectada:true},amplimed:{salvo:false,conectada:false}
    });
    const solicitarLinkAgenda=vi.fn();
    const {app}=preparar({pool:{query} as unknown as pg.Pool,modeloTeste,consultarStatus,solicitarLinkAgenda});
    const req={...evento,data:{...evento.data,key:{...evento.data.key,id:'conta-conectada-zero-medicos'},
      message:{conversation:'A minha Tribe está conectada?'}}};
    await comServidor(app,async postar=>expect((await postar(req)).status).toBe(200));
    expect(consultarStatus).toHaveBeenCalledWith(chaveConta);
    expect(solicitarLinkAgenda).not.toHaveBeenCalled();
    modeloTeste.assertComplete();
  });
  it('sem conta autenticada não lê referência técnica nem envia link de agenda',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[]});
    const solicitarLinkAgenda=vi.fn();
    const modeloTeste=new ScriptedModel([
      [functionCall('solicitar_link_seguro_agenda',{agenda:'tribemd',profissional:null},{callId:'sem-conta'})],
      [assistantMessage('Preciso confirmar sua conta antes de liberar a página segura.')]
    ]);
    const {app}=preparar({pool:{query} as unknown as pg.Pool,modeloTeste,solicitarLinkAgenda});
    const novo={...evento,data:{...evento.data,key:{...evento.data.key,id:'sem-conta-xyz'},message:{conversation:'Quero conectar TribeMD'}}};
    await comServidor(app,async postar=>expect((await postar(novo)).status).toBe(200));
    expect(query).toHaveBeenCalledTimes(1);
    expect(solicitarLinkAgenda).not.toHaveBeenCalled();
  });
});

describe('Evolution MESSAGES_UPDATE: acompanhamento passivo e seguro de links',()=>{
  const atualizarEstadoLink=vi.fn().mockResolvedValue(true);
  const recibo={
    event:'messages.update',instance:'notomed_assistente',
    data:{keyId:'3EB0ABCDEFGH9',remoteJid:'5551999998888@s.whatsapp.net',
      fromMe:true,status:'SERVER_ACK'}
  };
  it('webhook assinado registra recibo com IA pausada, sem enviar mensagens nem chamar modelo',async()=>{
    atualizarEstadoLink.mockClear();
    const {app,query,enviar,modeloTeste}=preparar({
      ativo:false,envioAtivo:false,atualizarEstadoLink
    });
    await comServidor(app,async postar=>{
      expect((await postar(recibo)).status).toBe(200);
    });
    expect(atualizarEstadoLink).toHaveBeenCalledExactlyOnceWith(recibo);
    expect(query).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
    expect(modeloTeste.calls).toHaveLength(0);
  });
  it('nega recibos sem segredo ou de outra instancia, sem side effects',async()=>{
    atualizarEstadoLink.mockClear();
    const {app,query,enviar}=preparar({ativo:false,envioAtivo:false,atualizarEstadoLink});
    await comServidor(app,async postar=>{
      expect((await postar(recibo,'errado')).status).toBe(401);
      expect((await postar({...recibo,instance:'notomed_oficial'})).status).toBe(204);
    });
    expect(atualizarEstadoLink).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
  });
});

describe('correlação de recibos Evolution no webhook, inclusive byEvents',()=>{
  const dados={
    event:'messages.update',instance:'notomed_assistente',
    data:{keyId:'3EB0AAAAAAAAAAAA',remoteJid:'5551999998888@s.whatsapp.net',
      fromMe:true,status:'DELIVERY_ACK'}
  };
  it('processa /messages-update com o mesmo segredo/instância e IA pausada',async()=>{
    const atualizarEstadoLink=vi.fn().mockResolvedValue(true);
    const {app,modeloTeste,enviar,query}=preparar({
      ativo:false,envioAtivo:false,atualizarEstadoLink
    });
    await comServidor(app,async postar=>{
      expect((await postar(dados,'segredo-de-teste','/webhook/evolution/messages-update')).status).toBe(200);
    });
    expect(atualizarEstadoLink).toHaveBeenCalledExactlyOnceWith(dados);
    expect(query).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
    expect(modeloTeste.calls).toHaveLength(0);
  });
  it('byEvents não contorna autenticação e não processa instância errada',async()=>{
    const atualizarEstadoLink=vi.fn();
    const aviso=vi.spyOn(console,'info').mockImplementation(()=>{});
    try{
      const {app,query,enviar}=preparar({ativo:false,envioAtivo:false,atualizarEstadoLink});
      await comServidor(app,async postar=>{
        expect((await postar(dados,'segredo-errado','/webhook/evolution/messages-update')).status).toBe(401);
        expect((await postar({...dados,instance:'instancia-outra'},'segredo-de-teste','/webhook/evolution/messages-update')).status).toBe(204);
      });
      expect(atualizarEstadoLink).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(enviar).not.toHaveBeenCalled();
      expect(JSON.stringify(aviso.mock.calls)).not.toContain('3EB0AAAAAAAAAAAA');
      expect(JSON.stringify(aviso.mock.calls)).not.toContain('5551999998888');
    }finally{aviso.mockRestore();}
  });
});


describe('panorama fiscal: evidência, envio e foco persistido no webhook', () => {
  for (const entregueAoTransporte of [true, false]) {
    it(entregueAoTransporte
      ? 'registra foco somente após consulta e balões aceitos, sem conteúdo fiscal na memória'
      : 'não confirma o foco conversacional quando o envio falha', async () => {
      const estadosSalvos: Array<Record<string, unknown>> = [];
      const query = vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('distinct conta_id')) return { rows: [{conta_id:'conta-a'}] };
        if (sql.startsWith('select id,nome_completo from medicos')) {
          expect(params).toEqual(['conta-a']);
          return { rows: [{id:'alice-id',nome_completo:'Alice Souza'}] };
        }
        if (sql.startsWith('select estado from noto_agent_conversas')) return { rows: [{estado:{}}] };
        if (sql.startsWith('insert into noto_agent_mensagens')) return { rows: [{mensagem_id:params[2]}] };
        if (sql.startsWith('insert into noto_agent_conversas')) {
          estadosSalvos.push(JSON.parse(String(params[1])));
          return { rows: [], rowCount:1 };
        }
        if (sql.startsWith('update noto_agent_mensagens')) return { rows: [], rowCount:1 };
        throw new Error('SQL inesperado no panorama');
      });
      const modeloTeste = new ScriptedModel([
        [functionCall('consultar_panorama_operacional', {profissional:'Alice'}, {callId:'fiscal'})],
        [assistantMessage('Encontrei 999 notas sem emissão.')]
      ]);
      const consultarPanorama = vi.fn().mockResolvedValue({
        ok:true, janelaDias:30,
        profissionais:[{nome:'Alice Souza',solicitacoes:[{status:'pronta',quantidade:2}],
          notas:[{status:'autorizada',quantidade:1}]}],
        limite:'REGISTROS_FISCAIS_DA_BASE'
      });
      const enviar = vi.fn().mockResolvedValue(entregueAoTransporte);
      const {app} = preparar({
        pool:{query} as unknown as pg.Pool, modeloTeste, consultarPanorama, enviar,
        persistirConversa:true
      });
      const pedido = {...evento, data:{...evento.data,
        message:{conversation:'Noto, como está a situação fiscal da Alice?'}}};
      await comServidor(app, async postar => {
        expect((await postar(pedido)).status).toBe(entregueAoTransporte ? 200 : 503);
      });
      expect(consultarPanorama).toHaveBeenCalledExactlyOnceWith('conta-a',['alice-id']);
      expect(enviar.mock.calls.map(c=>c[1]).join(' ')).not.toContain('999');
      if (entregueAoTransporte) {
        expect(estadosSalvos).toHaveLength(1);
        expect(estadosSalvos[0]?.ultimaConsultaFiscal).toEqual({
          escopo:'profissional', profissionalNome:'Alice Souza', verificadaEm:expect.any(String)
        });
        expect(JSON.stringify(estadosSalvos)).not.toMatch(/cpf|paciente|autorizada|pronta|quantidade/i);
      } else {
        expect(estadosSalvos).toHaveLength(0);
      }
      modeloTeste.assertComplete();
    });
  }
});
