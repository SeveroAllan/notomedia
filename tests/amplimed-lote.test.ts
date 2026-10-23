import { describe, expect, it } from 'vitest';
import { dataDoIdAmplimed, ehIdAmplimed, prepararLoteAmplimed, tomadorAmplimedAoVivo } from '../src/agenda/amplimed-lote.js';

const det = { nome: 'Paciente Teste Um', cpf: '10000000019', celular: '51993527271' };
const dias = [
  { data: '2026-10-22', elegiveis: [{ paciente: 'Paciente Teste Um', dataHora: '2026-10-22T08:00:00-03:00', idExterno: '2026-10-22T08:00|51993527271', valorCentavos: 25000, detalhe: det }] },
  { data: '2026-10-21', elegiveis: [{ paciente: 'Paciente Teste Quatro', dataHora: '2026-10-21T08:00:00-03:00', idExterno: '2026-10-21T08:00|51993527271', valorCentavos: 18000, detalhe: null }] }
];
describe('lote Amplimed', () => {
  it('reconhece o id do Amplimed pela data e não confunde com id do TribeMD', () => {
    expect(dataDoIdAmplimed('2026-10-22T08:00|51993527271')).toBe('2026-10-22'); expect(ehIdAmplimed('12345')).toBe(false);
  });
  it('só entra no lote quem tem tomador válido; o resto é contado à parte', () => {
    const r = prepararLoteAmplimed(dias);
    expect(r.consultas).toHaveLength(1); expect(r.semTomador).toBe(1);
    expect(r.valoresAoVivo.get('2026-10-22T08:00|51993527271')).toBe(25000);
    expect(r.consultas[0]).toMatchObject({ status: 'realizada', valorConsultaCentavos: 25000, nomeAoVivo: 'Paciente Teste Um' });
  });
  it('a tabela de consultas não recebe CPF nem o valor do paciente em claro no id do paciente', () => {
    expect(JSON.stringify(prepararLoteAmplimed(dias).consultas)).not.toContain('10000000019');
  });
  it('releitura ao vivo devolve o tomador; sem tomador ou sumida da agenda, falha', () => {
    expect(tomadorAmplimedAoVivo(dias, '2026-10-22T08:00|51993527271')).toMatchObject({ cpf: '10000000019', valorCobradoCentavos: 25000, contato: { celular: '51993527271' } });
    expect(() => tomadorAmplimedAoVivo(dias, '2026-10-21T08:00|51993527271')).toThrow('DETALHES_NAO_CONCLUIDOS');
    expect(() => tomadorAmplimedAoVivo(dias, '2026-10-20T08:00|x')).toThrow();
  });
});
