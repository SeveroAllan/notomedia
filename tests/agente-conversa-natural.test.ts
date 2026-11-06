import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { separarBaloes, reacaoContextual, solicitouVerificacao } from '../src/agente/baloes.js';
import { evoluirEstadoConversa, lerEstadoConversa, reservarMensagemConversa, salvarEstadoConversa } from '../src/agente/estado-conversa.js';
import { EvolutionApiClient } from '../src/io/evolution/evolution-api-client.js';

describe('balões de WhatsApp como mensagens reais', () => {
  it('separa pensamentos curtos, preservando o contexto', () => {
    expect(separarBaloes('Olá! Sou o Noto.\nVou conferir sua agenda. Qual agenda você usa?'))
      .toEqual(['Olá!', 'Sou o Noto.', 'Vou conferir sua agenda.', 'Qual agenda você usa?']);
  });
  it('mantém o link seguro inteiro e no último balão', () => {
    expect(separarBaloes('Vou te enviar o acesso. Abra este link:\nhttps://noto.example.test/c/abc123'))
      .toEqual(['Vou te enviar o acesso.', 'Abra este link:', 'https://noto.example.test/c/abc123']);
  });
  it('preserva uma frase longa sem pontuação intermediária como unidade de pensamento', () => {
    const texto = 'Vou verificar o estado dessa integração para entender o que já foi conectado e o que falta fazer antes de seguir com o cadastro.';
    const partes = separarBaloes(texto);
    expect(partes).toEqual([texto]);
    expect(partes.join(' ')).toBe(texto);
  });
  it('não deixa o complemento salvar isolado em outro balão', () => {
    const frase='Vou pesquisar CRM e RQE nas fontes públicas e te mostrar os dados antes de salvar.';
    expect(separarBaloes(frase)).toEqual([frase]);
  });
  it('classifica gestos por intenção, sem transformar cada frase em emoji', () => {
    expect(reacaoContextual('Sim, é isso')).toBe('👍');
    expect(reacaoContextual('Muito obrigado!')).toBe('❤️');
    expect(reacaoContextual('Consegue verificar minha agenda?')).toBe('🔎');
    expect(reacaoContextual('Qual agenda eu uso?')).toBe('👀');
    expect(reacaoContextual('Estou pensando em abrir uma clínica')).toBe(null);
    expect(solicitouVerificacao('Confere a agenda?')).toBe(true);
    expect(solicitouVerificacao('Obrigado!')).toBe(false);
  });
});

describe('memória mínima do onboarding', () => {
  it('preserva fase de descoberta pendente sem incluir nomes ou conteúdo clínico',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[]});
    await salvarEstadoConversa({query} as unknown as pg.Pool,'conta-isolada',{
      agendaEscolhida:'tribemd',faseAgenda:'DESCOBERTA_PENDENTE',
      causaDescoberta:'DETALHES_PENDENTES'
    });
    const estado=JSON.parse(String(query.mock.calls[0]?.[1]?.[1]));
    expect(estado).toMatchObject({
      agendaEscolhida:'tribemd',faseAgenda:'DESCOBERTA_PENDENTE',
      causaDescoberta:'DETALHES_PENDENTES'
    });
    expect(JSON.stringify(estado)).not.toMatch(/paciente|cpf|senha|token|nome/i);
    query.mockResolvedValueOnce({rows:[{estado}]});
    expect(await lerEstadoConversa({query} as unknown as pg.Pool,'conta-isolada'))
      .toMatchObject({faseAgenda:'DESCOBERTA_PENDENTE',causaDescoberta:'DETALHES_PENDENTES'});
  });
  const profissionais = [{id:'m-1',nome:'Dra. Alice Silva'},{id:'m-2',nome:'Bruno Lima'}];
  it('salva escolha e identidade explícitas sem confundir com lista cadastrada', () => {
    const escolhido = evoluirEstadoConversa({}, 'É Amplimed da Alice', 'Certo. Vou verificar a conexão.', profissionais);
    expect(escolhido.agendaEscolhida).toBe('amplimed');
    expect(escolhido.profissionalConfirmadoId).toBeUndefined();
    const retomado = evoluirEstadoConversa(escolhido, 'Aliás, e minhas notas?', 'Ainda não consultei notas.', profissionais);
    expect(retomado.agendaEscolhida).toBe('amplimed');
    expect(retomado.profissionalConfirmadoId).toBeUndefined();
    expect(evoluirEstadoConversa(retomado,'Não, é TribeMD','Vou conferir.',profissionais).agendaEscolhida).toBe('tribemd');
  });
  it('um sim genérico não escolhe nem autoriza profissional', () => {
    const s = evoluirEstadoConversa({}, 'sim', 'Qual profissional?', profissionais);
    expect(s.profissionalConfirmadoId).toBeUndefined();
  });
  it('mantém resposta curta vinculada somente a pergunta de identidade determinada', () => {
    const anterior = {perguntaPendente:'profissional' as const, profissionalPerguntadoId:'m-1'};
    expect(evoluirEstadoConversa(anterior,'isso','Vamos seguir.',profissionais).profissionalConfirmadoId).toBeUndefined();
  });
  it('grava apenas tipos limitados, não textos, nomes ou credenciais', async () => {
    const query=vi.fn().mockResolvedValue({rows:[{estado:{
      agendaEscolhida:'amplimed', profissionalConfirmadoId:'m-1', senha:'SENHA_NUNCA_PERSISTIDA'
    }}]});
    const pool={query} as unknown as pg.Pool;
    const lido=await lerEstadoConversa(pool,'conta-1');
    expect(lido).toEqual({agendaEscolhida:'amplimed',profissionalConfirmadoId:'m-1'});
    await salvarEstadoConversa(pool,'conta-1',{...lido});
    expect(JSON.stringify(query.mock.calls)).not.toContain('SENHA_NUNCA_PERSISTIDA');
    expect(JSON.stringify(query.mock.calls)).not.toContain('Alice Silva');
  });
  it('reserva por id real sem guardar texto e respeita conflito', async () => {
    const query=vi.fn().mockResolvedValueOnce({rows:[{mensagem_id:'id12345'}]}).mockResolvedValueOnce({rows:[]});
    const pool={query} as unknown as pg.Pool;
    expect(await reservarMensagemConversa(pool,'conta-1','instancia','id12345')).toBe(true);
    expect(await reservarMensagemConversa(pool,'conta-1','instancia','id12345')).toBe(false);
    expect(query.mock.calls[0][0]).toContain('on conflict do nothing');
  });
});

describe('Evolution: leitura, reação e presença autorizadas', () => {
  afterEach(() => vi.unstubAllGlobals());
  const chave={id:'BAE569F0E38F858D',remoteJid:'5511999990000@s.whatsapp.net',fromMe:false};
  it('envia payload de leitura, reação e digitando pelo canal do assistente', async () => {
    const fetchMock=vi.fn().mockResolvedValue(new Response('{}',{status:200}));
    vi.stubGlobal('fetch',fetchMock);
    const client=new EvolutionApiClient('https://evolution.invalid','api-ficticia','otp','otp');
    expect((await client.marcarLida({
      instanciaNome:'assistente',contatoTelefone:'5511999990000',
      mensagemId:chave.id,chaveMensagem:chave
    })).sucesso).toBe(true);
    expect(await client.reagirMensagem('assistente',chave,'👀')).toBe(true);
    expect(await client.enviarPresenca('assistente','5511999990000','composing')).toBe(true);
    expect(await client.enviarPresenca('assistente','5511999990000','paused')).toBe(true);
    const urls=fetchMock.mock.calls.map(c=>String(c[0]));
    expect(urls).toEqual([
      'https://evolution.invalid/chat/markMessageAsRead/assistente',
      'https://evolution.invalid/message/sendReaction/assistente',
      'https://evolution.invalid/chat/sendPresence/assistente',
      'https://evolution.invalid/chat/sendPresence/assistente'
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({key:chave,reaction:'👀'});
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({number:'5511999990000',presence:'composing'});
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toMatchObject({number:'5511999990000',presence:'paused'});
  });
  it('admite formato alternativo da Evolution apenas quando o payload inicial é rejeitado',async()=>{
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(new Response('{}',{status:400}))
      .mockResolvedValueOnce(new Response('{}',{status:200}));
    vi.stubGlobal('fetch',fetchMock);
    const client=new EvolutionApiClient('https://evolution.invalid','api-ficticia','otp','otp');
    expect(await client.reagirMensagem('assistente',chave,'❤️')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({key:chave,reaction:'❤️'});
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({reactionKey:chave,reactionMessage:'❤️'});
  });
  it('não repete reação quando a Evolution retorna falha de autenticação',async()=>{
    const fetchMock=vi.fn().mockResolvedValue(new Response('{}',{status:401}));
    vi.stubGlobal('fetch',fetchMock);
    const client=new EvolutionApiClient('https://evolution.invalid','api-ficticia','otp','otp');
    expect(await client.reagirMensagem('assistente',chave,'👍')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('nunca reage a outra instância, mensagem própria ou ID suspeito', async () => {
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    const client=new EvolutionApiClient('https://evolution.invalid','api-ficticia','otp','otp');
    expect(await client.reagirMensagem('otp',chave,'✅')).toBe(false);
    expect(await client.reagirMensagem('assistente',{...chave,fromMe:true},'👍')).toBe(false);
    expect(await client.reagirMensagem('assistente',{...chave,id:'<script>'},'👍')).toBe(false);
    expect(await client.enviarPresenca('otp','5511999990000','composing')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


describe('decisões de retomada: a última conversa não pode autorizar por menção incidental',()=>{
  const prof=[{id:'m1',nome:'Dra. Alice Silva'}, {id:'m2',nome:'Dr. Bruno Lima'}];
  it('pergunta sobre uma agenda não muda agenda escolhida nem seleciona médico',()=>{
    const anterior={agendaEscolhida:'tribemd' as const,profissionalConfirmadoId:'m2'};
    const novo=evoluirEstadoConversa(anterior,'A Amplimed da Alice está funcionando?','Vou verificar.',prof);
    expect(novo.agendaEscolhida).toBe('tribemd');
    expect(novo.profissionalConfirmadoId).toBe('m2');
  });
  it('correção declarativa troca a agenda, sem apagar outros fatos confirmados',()=>{
    const anterior={agendaEscolhida:'amplimed' as const,profissionalConfirmadoId:'m2'};
    const novo=evoluirEstadoConversa(anterior,'Não, é TribeMD','Certo, verificarei.',prof);
    expect(novo.agendaEscolhida).toBe('tribemd');
    expect(novo.profissionalConfirmadoId).toBe('m2');
  });
  it('pergunta explícita sobre adicionar médico confirmado na fonte gera alvo único',()=>{
    const anterior={agendaEscolhida:'amplimed' as const,
      descoberta:{agenda:'amplimed' as const,nomes:['Alice Silva','Bruno Lima']}};
    const novo=evoluirEstadoConversa(anterior,
      'Quem é Bruno Lima?',
      'Encontrei Bruno na agenda. Você confirma adicionar Bruno Lima à conta?',prof);
    expect(novo.perguntaPendente).toBe('confirmar_profissional');
    expect(novo.nomeProfissionalPerguntado).toBe('Bruno Lima');
    expect(novo.profissionalConfirmadoId).toBeUndefined();
  });
  it('não cria consentimento pendente para nome que não foi encontrado na fonte',()=>{
    const anterior={descoberta:{agenda:'tribemd' as const,nomes:['Alice Silva']}};
    const novo=evoluirEstadoConversa(anterior,'Quem é Bruno?',
      'Você confirma adicionar Bruno Lima à conta?',prof);
    expect(novo.perguntaPendente).not.toBe('confirmar_profissional');
    expect(novo.nomeProfissionalPerguntado).toBeUndefined();
  });
  it('não descarta avisos fiscais quando há mais de doze balões',()=>{
    const texto=[...Array.from({length:20},(_,i)=>'Mensagem '+(i+1)+'.'),
      'Não há autorização para emitir automaticamente.'].join(' ');
    const baloes=separarBaloes(texto);
    expect(baloes.length).toBeLessThanOrEqual(12);
    expect(baloes.join(' ')).toContain('Não há autorização para emitir automaticamente.');
    expect(baloes.join(' ')).toContain('Mensagem 1.');
  });
});
