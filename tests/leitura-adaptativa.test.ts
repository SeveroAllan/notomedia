import { describe, expect, it } from 'vitest';
import { checarLeitura, montarAmostraConferencia, podeGerarNota, requisicaoSomenteLeitura, separarElegiveis } from '../src/agenda/leitura-adaptativa.js';

const c = (n: number, extra: Record<string, unknown> = {}) => ({ idExterno: 'a' + n, dataHora: '2026-10-20T09:00:00-03:00', profissional: 'Dra. Ana', status: 'realizada', tipoCobranca: 'particular', valorCentavos: 25000, telefone: '51999990000', pacienteNome: 'Paciente Ficticio ' + n, ...extra });
const janela = { inicio: '2026-10-01', fim: '2026-10-31' };
const profs = ['Dra. Ana', 'Dra. Bia'];

describe('leitura adaptativa de agenda', () => {
  it('leitura consistente é confiável', () => {
    expect(checarLeitura({ consultas: [c(1), c(2, { profissional: 'dra bia' })], janela, totaisTela: { atendimentos: 2, valorCentavos: 50000 } }, profs).confiavel).toBe(true);
  });
  it.each([
    ['profissional fora da lista', c(1, { profissional: 'Dr. X' }), 'PROFISSIONAL_DESCONHECIDO'],
    ['fora da janela', c(1, { dataHora: '2026-01-01T09:00:00-03:00' }), 'FORA_DA_JANELA'],
    ['particular sem valor', c(1, { valorCentavos: null }), 'VALOR_PARTICULAR_AUSENTE'],
    ['telefone curto', c(1, { telefone: '123' }), 'TELEFONE_INVALIDO'],
    ['campo extra', c(1, { cpf: '1' }), 'FORMATO_INVALIDO']
  ])('%s não é confiável', (_n, item, codigo) => {
    const r = checarLeitura({ consultas: [item], janela }, profs);
    expect(r.confiavel).toBe(false); expect(r.problemas.map(p => p.codigo)).toContain(codigo);
  });
  it('total da tela diferente ou duplicada derrubam a confiança', () => {
    expect(checarLeitura({ consultas: [c(1)], janela, totaisTela: { valorCentavos: 1 } }, profs).problemas.map(p => p.codigo)).toContain('TOTAL_VALOR_DIVERGE');
    expect(checarLeitura({ consultas: [c(1), c(1)], janela }, profs).problemas.map(p => p.codigo)).toContain('DUPLICADA');
  });
  it('cortesia e convênio ficam fora e são contados', () => {
    const { consultas } = checarLeitura({ consultas: [c(1), c(2, { tipoCobranca: 'cortesia', valorCentavos: 0 }), c(3, { tipoCobranca: 'convenio' })], janela }, profs);
    const r = separarElegiveis(consultas);
    expect(r.elegiveis).toHaveLength(1); expect(r.foraCortesia).toBe(1); expect(r.foraOutros).toBe(1);
  });
  it('amostra mistura profissionais e não leva telefone nem paciente', () => {
    const lista = [1, 2, 3, 4].map(n => c(n)).concat([5, 6].map(n => c(n, { profissional: 'Dra. Bia' })));
    const a = montarAmostraConferencia(checarLeitura({ consultas: lista, janela }, profs).consultas, 4);
    expect(new Set(a.map(x => x.profissional)).size).toBe(2);
    expect(JSON.stringify(a)).not.toMatch(/Paciente|telefone|5199/);
  });
  it('observação nunca gera nota; só leitura bloqueia escrita', () => {
    expect(podeGerarNota('observacao', true)).toBe(false); expect(podeGerarNota('aprovado', false)).toBe(false); expect(podeGerarNota('aprovado', true)).toBe(true);
    expect(requisicaoSomenteLeitura('POST', '/agenda')).toBe(false); expect(requisicaoSomenteLeitura('GET', '/agenda/cancelar')).toBe(false); expect(requisicaoSomenteLeitura('GET', '/agenda')).toBe(true);
  });
});
