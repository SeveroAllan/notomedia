import { describe, expect, it } from 'vitest';
import { cobrancaAmplimed, statusAmplimed } from '../src/agenda/amplimed-mapeamento.js';

describe('mapeamento Amplimed', () => {
  it('só FINALIZADO vira realizada; bloqueado e desconhecido não viram nada', () => {
    expect(statusAmplimed('FINALIZADO')).toBe('realizada');
    expect(statusAmplimed('Não Compareceu')).toBe('faltou');
    expect(statusAmplimed('EM ATENDIMENTO')).toBe('agendada');
    expect(statusAmplimed('BLOQUEADO')).toBe('desconhecido');
    expect(statusAmplimed('Faturado TISS')).toBe('desconhecido');
  });
  it('particular e cortesia reconhecidos; convênio e vazio não são particulares', () => {
    expect(cobrancaAmplimed('Particular')).toBe('particular');
    expect(cobrancaAmplimed(' cortesia ')).toBe('cortesia');
    expect(cobrancaAmplimed('Unimed')).toBe('convenio');
    expect(cobrancaAmplimed(null)).toBe('desconhecido');
  });
});

import { statusAmplimedPorCor } from '../src/agenda/amplimed-mapeamento.js';
describe('status pela cor (legenda da conta teste)', () => {
  it('mapeia todas as cores da legenda, em hex, rgb e nome CSS', () => {
    const casos: [string, string][] = [['#6C757D', 'agendada'], ['#1FBED9', 'agendada'], ['#E3A62C', 'agendada'], ['#D75353', 'cancelada'], ['#F76397', 'faltou'],
      ['#840000', 'cancelada'], ['#343A40', 'agendada'], ['#008000', 'realizada'], ['green', 'realizada'], ['rgb(0, 128, 0)', 'realizada'],
      ['#800080', 'desconhecido'], ['purple', 'desconhecido'], ['orange', 'desconhecido'], ['', 'desconhecido']];
    for (const [cor, esperado] of casos) expect(statusAmplimedPorCor(cor)).toBe(esperado);
  });
  it('só o verde conta como atendido', () => {
    const todas = ['#6C757D', '#1FBED9', '#E3A62C', '#D75353', '#F76397', '#840000', '#343A40', '#800080'];
    expect(todas.filter(c => statusAmplimedPorCor(c) === 'realizada')).toEqual([]);
  });
});
