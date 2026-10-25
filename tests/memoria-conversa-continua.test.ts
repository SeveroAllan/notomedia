import type pg from 'pg';
import {expect,it,vi} from 'vitest';
import {ConversadorMedico} from '../src/onboarding/conversador-medico.js';
import {InterpretadorSemantico} from '../src/onboarding/interpretador-semantico.js';
import {PostgresMemoriaConversaMedico} from '../src/onboarding/memoria-conversa.js';

it('memória semântica exige confiança alta, proveniência e conteúdo durável seguro',async()=>{
 const query=vi.fn(async(sql:string,_p:unknown[]=[])=>({rows:sql.includes('returning id::text')?[{id:'9'}]:[]}));
 const memoria=new PostgresMemoriaConversaMedico({query} as unknown as pg.Pool);
 await memoria.registrarMemoriaSemantica('m',{chave:'agenda_preferida',categoria:'preferencia_agenda',valor:'Prefere Amplimed',origemConversa:'c',origemMensagemId:'42',confianca:.89});
 await memoria.registrarMemoriaSemantica('m',{chave:'agenda_preferida',categoria:'preferencia_agenda',valor:'Paciente Ana prefere Amplimed',origemConversa:'c',origemMensagemId:'42',confianca:.97});
 expect(query).not.toHaveBeenCalled();
 await memoria.registrarMemoriaSemantica('m',{chave:'agenda_preferida',categoria:'preferencia_agenda',valor:'Prefere Amplimed',origemConversa:'c',origemMensagemId:'42',confianca:.97});
 expect(query).toHaveBeenCalledOnce();
 expect(query.mock.calls[0]![1]).toEqual(['m','agenda_preferida','preferencia_agenda','Prefere Amplimed','c','42',.97]);
});

it('work log guarda apenas metadados fornecidos e não entra na conversa',async()=>{
 const query=vi.fn(async()=>({rows:[]}));
 const memoria=new PostgresMemoriaConversaMedico({query} as unknown as pg.Pool);
 await memoria.registrarEventoTrabalho('m','c','chave','consultar_agenda','concluida',{agenda:'tribemd',desde:'2026-10-20',ok:true});
 expect(query).toHaveBeenCalledOnce();
 const parametros=query.mock.calls[0]![1] as unknown[];
 expect(parametros.slice(0,5)).toEqual(['m','c','chave','consultar_agenda','concluida']);
 expect(JSON.parse(String(parametros[5]))).toEqual({agenda:'tribemd',desde:'2026-10-20',ok:true});
});

it('chunks raiz voltam em ordem cronológica e continuam sanitizados',async()=>{
 const query=vi.fn(async()=>({rows:[
  {id:'1',nivel:2,inicio_mensagem_id:'1',fim_mensagem_id:'20',resumo:'Preferência CPF 529.982.247-25'},
  {id:'2',nivel:0,inicio_mensagem_id:'21',fim_mensagem_id:'30',resumo:'Depois conectou Amplimed'}
 ]}));
 const memoria=new PostgresMemoriaConversaMedico({query} as unknown as pg.Pool);
 expect(await memoria.lerChunksRaiz('m','c')).toEqual([
  {id:'1',nivel:2,inicioId:'1',fimId:'20',resumo:'Preferência CPF [OCULTO]'},
  {id:'2',nivel:0,inicioId:'21',fimId:'30',resumo:'Depois conectou Amplimed'}
 ]);
});

it('compactação extrai memória somente com origem explícita e sanitiza antes de persistir',async()=>{
 const completar=vi.fn(async()=>JSON.stringify({
  resumo:'O médico prefere Amplimed. CPF 529.982.247-25',
  chunk:'Preferência pela Amplimed. CPF 529.982.247-25',
  memorias:[{chave:'agenda_preferida',categoria:'preferencia_agenda',valor:'Prefere Amplimed. CPF 529.982.247-25',origemId:'12',confianca:.98}]
 }));
 const r=await new ConversadorMedico('k','m',completar as any).compactar({resumo:null,mensagens:[
  {id:'12',papel:'medico',texto:'Prefiro usar a Amplimed'},
  {id:'13',papel:'noto',texto:'Certo'}
 ]});
 expect(r).toEqual({
  resumo:'O médico prefere Amplimed. CPF [OCULTO]',
  chunk:'Preferência pela Amplimed. CPF [OCULTO]',
  memorias:[{chave:'agenda_preferida',categoria:'preferencia_agenda',valor:'Prefere Amplimed. CPF [OCULTO]',origemId:'12',confianca:.98}]
 });
 expect(String(completar.mock.calls[0]![2][0]!.content)).toContain('origemId');
});

it('timeline e memória entram no decisor, mas o prompt declara fatos como autoridade atual',async()=>{
 const completar=vi.fn(async()=>JSON.stringify({fala:['Certo.'],acao:null}));
 const conversador=new ConversadorMedico('k','m',completar as any);
 await conversador.responder({
  texto:'E ontem?',mensagens:['Falamos da Amplimed.'],resumo:'Resumo médio.',
  linhaDoTempo:['[01/10] Médico passou a preferir Amplimed.'],
  memoriasSemanticas:[{chave:'agenda_preferida',categoria:'preferencia_agenda',valor:'Prefere Amplimed'}],
  fatos:{ambiente:'homologacao',agenda:{nome:'tribemd',conectada:true},agendas:{tribemd:{salva:true,conectada:true},amplimed:{salva:true,conectada:true}},link:{ativo:false,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:false},
  agora:new Date('2026-10-25T15:00:00-03:00'),acoesPermitidas:['nenhuma']
 });
 const entrada=JSON.parse(String(completar.mock.calls[0]![2][1]!.content));
 expect(entrada.linhaDoTempo).toEqual(['[01/10] Médico passou a preferir Amplimed.']);
 expect(entrada.memoriasSemanticas).toEqual([{chave:'agenda_preferida',categoria:'preferencia_agenda',valor:'Prefere Amplimed'}]);
 expect(String(completar.mock.calls[0]![2][0]!.content)).toContain('fatos and tool results win');
});

it('interpretador recebe a mesma timeline sem transformar memória em estado operacional',async()=>{
 const completar=vi.fn(async()=>JSON.stringify({
  dominio:'agenda',objetivo:'consultar',objeto:'consultas',granularidade:'colecao',medida:'lista',
  permissaoNecessaria:null,agendaAlvo:'tribemd',periodo:{inicio:'2026-10-24',fim:'2026-10-24',referencia:'explicito'},
  paciente:null,restricoes:{naoEmitir:false,somenteLeitura:true},faltando:[],confianca:.99
 }));
 const i=new InterpretadorSemantico('k','m',completar as any);
 await i.interpretar({
  texto:'Veja ontem',mensagens:[],resumo:null,linhaDoTempo:['Histórico antigo'],
  memoriasSemanticas:[{chave:'agenda_preferida',categoria:'preferencia_agenda',valor:'Prefere Amplimed'}],
  fatos:{ambiente:'homologacao',agenda:{nome:'tribemd',conectada:true},agendas:{tribemd:{salva:true,conectada:true},amplimed:{salva:true,conectada:true}},link:{ativo:false,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:false},
  agora:new Date('2026-10-25T15:00:00-03:00')
 });
 const entrada=JSON.parse(String(completar.mock.calls[0]![2][1]!.content));
 expect(entrada.linhaDoTempo).toEqual(['Histórico antigo']);
 expect(entrada.memoriasSemanticas[0].valor).toBe('Prefere Amplimed');
 expect(String(completar.mock.calls[0]![2][0]!.content)).toContain('fatos is the current operational authority');
});
