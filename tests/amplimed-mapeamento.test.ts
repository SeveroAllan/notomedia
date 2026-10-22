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
