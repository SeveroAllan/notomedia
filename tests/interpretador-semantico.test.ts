import { expect, it, vi } from 'vitest';
import { completarOpenAi } from '../src/io/nvidia/chat-client.js';
import { InterpretadorSemantico, PROMPT_INTERPRETACAO_SEMANTICA, planejarPorSemantica, reconciliarInterpretacaoSemantica, type InterpretacaoSemantica } from '../src/onboarding/interpretador-semantico.js';
import type { FatosConversa } from '../src/onboarding/conversador-medico.js';

const agora=new Date('2026-10-21T15:00:00Z');
const fatos:FatosConversa={ambiente:'homologacao',agenda:{nome:'amplimed',conectada:true},link:{ativo:false,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:false};
const frame:InterpretacaoSemantica={
  dominio:'agenda',objetivo:'consultar',objeto:'consultas',granularidade:'colecao',medida:'lista',permissaoNecessaria:null,
  periodo:{inicio:'2026-10-19',fim:'2026-10-21',referencia:'explicito'},paciente:null,
  restricoes:{naoEmitir:false,somenteLeitura:false},faltando:[],confianca:.98
};

it('interpreta formulações linguísticas diferentes no mesmo frame sem regras de frase no código',async()=>{
  const completar=vi.fn<typeof completarOpenAi>(async()=>JSON.stringify(frame));
  const i=new InterpretadorSemantico('k','gpt-6.1-sol',completar);
  const frases=[
    'Me fale sobre minhas consultas dessa semana.',
    'Quais consultas eu tenho esta semana?',
    'Como está minha agenda nos últimos dias?',
    'Quero saber o que tive marcado no período atual.',
    'Dá uma olhada nos meus atendimentos recentes.'
  ];
  for(const texto of frases) expect(await i.interpretar({texto,mensagens:[],resumo:null,fatos,agora})).toEqual(frame);
  expect(PROMPT_INTERPRETACAO_SEMANTICA.toLowerCase()).not.toContain('me fale');
  expect(PROMPT_INTERPRETACAO_SEMANTICA.toLowerCase()).not.toContain('dessa semana');
  expect(completar).toHaveBeenCalledTimes(frases.length);
  expect(completar.mock.calls[0]![3]).toMatchObject({reasoningEffort:'medium',formatoJson:true});
});

it('entrega plano anterior ao interpretador para resolver referência financeira contextual',async()=>{
  const completar=vi.fn<typeof completarOpenAi>(async()=>JSON.stringify({...frame,dominio:'fiscal',medida:'valor_realizado',periodo:{inicio:'2026-10-19',fim:'2026-10-21',referencia:'contextual'}}));
  const i=new InterpretadorSemantico('k','gpt-6.1-sol',completar);
  const plano={objetivo:'consultar:consultas',etapa:'executar_capacidade',faltando:[],proximosPassos:['consultar_agenda'],aguardando:null};
  const r=await i.interpretar({texto:'Quanto foi faturado?',mensagens:['Na sua agenda desta semana encontrei 11 consultas.'],resumo:null,plano,fatos,agora});
  expect(r?.medida).toBe('valor_realizado');
  const payload=JSON.parse(String(completar.mock.calls[0]![2][1]!.content));
  expect(payload.plano).toEqual(plano);
  expect(PROMPT_INTERPRETACAO_SEMANTICA).toContain("Use medida='valor_realizado' when a short financial question");
});

it('interpretador usa instruções em inglês para entrada pt-BR',()=>{
 expect(PROMPT_INTERPRETACAO_SEMANTICA).toContain('Brazilian Portuguese (pt-BR)');
 expect(PROMPT_INTERPRETACAO_SEMANTICA).toContain('Return only the semantic JSON object.');
 expect(PROMPT_INTERPRETACAO_SEMANTICA).not.toContain('Interprete a mensagem');
});

it('pergunta sobre envio recente usa entregas, sem agenda nem reenvio',async()=>{
 const entrega={notaFiscalId:'nf-1',solicitacaoId:'sol-1',ndps:42,paciente:'Paciente Teste',datasConsulta:'20/10/2026',valorCentavos:25000,destino:'medico' as const,origem:'pedido_historico' as const,resultado:'enviado' as const,registradaEm:'2026-10-25T09:00:00.000Z'};
 const f:FatosConversa={...fatos,entregasRecentes:[entrega]};
 const esperado:InterpretacaoSemantica={...frame,dominio:'documento',objetivo:'consultar',objeto:'entregas',granularidade:'colecao',periodo:{inicio:null,fim:null,referencia:'nenhum'}};
 const completar=vi.fn<typeof completarOpenAi>(async()=>JSON.stringify(esperado));
 const i=new InterpretadorSemantico('k','gpt-6.1-sol',completar);
 expect(await i.interpretar({texto:'Que notas são essas?',mensagens:[],resumo:null,fatos:f,agora})).toEqual(esperado);
 const payload=JSON.parse(String(completar.mock.calls[0]![2][1]!.content));
 expect(payload.fatos.entregasRecentes).toEqual([entrega]);
 expect(PROMPT_INTERPRETACAO_SEMANTICA).toContain("Use objeto='entregas'");
 expect(planejarPorSemantica(esperado,f,['nenhuma','consultar_agenda','reenviar_nota_medico'])).toBeNull();
});

it('planner mapeia significado de agenda para consultar_agenda, não listar_pendencias',()=>{
  const d=planejarPorSemantica(frame,fatos,['nenhuma','consultar_agenda','listar_pendencias']);
  expect(d).toMatchObject({acao:'consultar_agenda',parametros:{desde:'2026-10-19',ate:'2026-10-21'}});
});

it('planner distingue pendência fiscal de consulta geral pelo objeto semântico',()=>{
 const fiscal:InterpretacaoSemantica={...frame,dominio:'fiscal',objetivo:'consultar',objeto:'pendencias_fiscais'};
 const d=planejarPorSemantica(fiscal,fatos,['nenhuma','consultar_agenda','listar_pendencias']);
 expect(d).toMatchObject({acao:'listar_pendencias',parametros:{desde:'2026-10-19',ate:'2026-10-21'}});
});

it('reconcilia pré-requisitos reais: agenda ausente vira pendência e modo manual não empurra conexão',()=>{
 const emitir:InterpretacaoSemantica={...frame,dominio:'fiscal',objetivo:'emitir',objeto:'notas',periodo:{inicio:'2026-10-19',fim:'2026-10-21',referencia:'explicito'},faltando:[]};
 const semConexao={...fatos,agenda:{nome:'tribemd',conectada:false},semAgendaDigital:false};
 expect(reconciliarInterpretacaoSemantica(emitir,semConexao).faltando).toContain('agenda');
 const manual={...semConexao,semAgendaDigital:true};
 const r=reconciliarInterpretacaoSemantica(emitir,manual);
 expect(r.faltando).not.toContain('agenda');expect(r.faltando).toContain('dados_consulta');
 expect(planejarPorSemantica(r,manual,['nenhuma','pedir_link_agenda','registrar_modo_sem_agenda'])).toBeNull();
});

it('planner oferece a escolha específica somente quando a permissão necessária está pendente',()=>{
 const i:InterpretacaoSemantica={...frame,dominio:'permissoes',objetivo:'configurar',objeto:'permissoes',permissaoNecessaria:'entregar_paciente',faltando:['permissao']};
 const pendente:FatosConversa={...fatos,permissoes:{emitirAutonomo:'sempre_perguntar',entregarPaciente:null,pendentes:true,faltantes:['entregar_paciente']}};
 const d=planejarPorSemantica(i,pendente,['nenhuma','pedir_link_permissoes']);
 expect(d).toMatchObject({acao:'pedir_link_permissoes',parametros:{permissao:'entregar_paciente'}});
 const escolhido:FatosConversa={...pendente,permissoes:{emitirAutonomo:'sempre_perguntar',entregarPaciente:'paciente',pendentes:false,faltantes:[]}};
 const reconciliado=reconciliarInterpretacaoSemantica(i,escolhido);
 expect(reconciliado.faltando).not.toContain('permissao');
 expect(planejarPorSemantica(reconciliado,escolhido,['nenhuma'])).toBeNull();
});

it('agenda conhecida e desconectada vira próximo passo proativo sem depender da frase original',()=>{
 const i:InterpretacaoSemantica={...frame,dominio:'fiscal',objetivo:'emitir',objeto:'notas',faltando:['agenda']};
 const f={...fatos,agenda:{nome:'tribemd',conectada:false},semAgendaDigital:false};
 expect(planejarPorSemantica(i,f,['nenhuma','pedir_link_agenda'])).toMatchObject({acao:'pedir_link_agenda',parametros:{agenda:'tribemd'}});
});

it('planner não força ação quando a semântica está incompleta ou pouco confiável',()=>{
  expect(planejarPorSemantica({...frame,confianca:.4},fatos,['consultar_agenda'])).toBeNull();
  expect(planejarPorSemantica({...frame,faltando:['periodo'],periodo:{inicio:null,fim:null,referencia:'nenhum'}},fatos,['consultar_agenda'])).toBeNull();
});

it.each(['valor_agenda','valor_realizado','valor_recebido','valor_notas','valor_indefinido'] as const)('preserva medida financeira %s sem converter consulta em lote',medida=>{
 const d=planejarPorSemantica({...frame,dominio:'fiscal',medida},fatos,['nenhuma','consultar_agenda','iniciar_lote']);
 expect(d).toMatchObject({acao:'consultar_agenda',parametros:{medida,desde:'2026-10-19'}});
 expect(d?.acao).not.toBe('iniciar_lote');
});
