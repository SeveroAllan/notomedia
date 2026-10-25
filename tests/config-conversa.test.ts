import { expect, it } from 'vitest';
import { carregarConfig } from '../src/config.js';
it.each([undefined, '', 'false', '1', 'TRUE', 'true'])('conversa livre exige true literal: %s', valor => {
  expect(carregarConfig({ CONVERSA_LIVRE_ATIVA: valor }).conversaLivreAtiva).toBe(valor === 'true');
});

it('planner usa modelo forte por padrão e aceita override explícito', () => {
  expect(carregarConfig({}).openaiPlannerModel).toBe('gpt-6.1-sol');
  expect(carregarConfig({ OPENAI_PLANNER_MODEL: 'modelo-planejador' }).openaiPlannerModel).toBe('modelo-planejador');
});

it.each([undefined,'false','true'])('permissões continuam opt-in e só ligam com true literal: %s',valor=>{
  expect(carregarConfig({PERMISSOES_ATIVA:valor}).permissoesAtiva).toBe(valor==='true');
});
