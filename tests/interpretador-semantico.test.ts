import { expect, it, vi } from 'vitest';
import { completarOpenAi } from '../src/io/nvidia/chat-client.js';
import { InterpretadorSemantico, PROMPT_INTERPRETACAO_SEMANTICA, planejarPorSemantica, type InterpretacaoSemantica } from '../src/onboarding/interpretador-semantico.js';
import type { FatosConversa } from '../src/onboarding/conversador-medico.js';

const agora=new Date('2026-10-21T15:00:00Z');
const fatos:FatosConversa={ambiente:'homologacao',agenda:{nome:'amplimed',conectada:true},link:{ativo:false,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:false};
const frame:InterpretacaoSemantica={
  dominio:'agenda',objetivo:'consultar',objeto:'consultas',granularidade:'colecao',
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

it('planner mapeia significado de agenda para consultar_agenda, não listar_pendencias',()=>{
  const d=planejarPorSemantica(frame,fatos,['nenhuma','consultar_agenda','listar_pendencias']);
  expect(d).toMatchObject({acao:'consultar_agenda',parametros:{desde:'2026-10-19',ate:'2026-10-21'}});
});

it('planner distingue pendência fiscal de consulta geral pelo objeto semântico',()=>{
 const fiscal:InterpretacaoSemantica={...frame,dominio:'fiscal',objetivo:'consultar',objeto:'pendencias_fiscais'};
 const d=planejarPorSemantica(fiscal,fatos,['nenhuma','consultar_agenda','listar_pendencias']);
 expect(d).toMatchObject({acao:'listar_pendencias',parametros:{desde:'2026-10-19',ate:'2026-10-21'}});
});

it('planner não força ação quando a semântica está incompleta ou pouco confiável',()=>{
  expect(planejarPorSemantica({...frame,confianca:.4},fatos,['consultar_agenda'])).toBeNull();
  expect(planejarPorSemantica({...frame,faltando:['periodo'],periodo:{inicio:null,fim:null,referencia:'nenhum'}},fatos,['consultar_agenda'])).toBeNull();
});
