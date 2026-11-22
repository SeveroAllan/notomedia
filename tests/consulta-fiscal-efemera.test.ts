import { describe, expect, it } from 'vitest';
import { chaveConsultaFiscal, registrarEscolha, resolverAgrupamento, type ConsultaFiscalEfemera } from '../src/fiscal/consulta-fiscal-efemera.js';

const segredo = 'segredo-ficticio-de-32-caracteres-ou-mais';
const consulta = (id: string, inicio = '2026-11-01T13:00:00Z'): ConsultaFiscalEfemera => ({
  contaId: 'conta-1', medicoId: 'medico-1', origemAgenda: 'amplimed',
  referenciaConsulta: id, inicioConsulta: inicio, profissionalConfirmado: true,
  tomador: { nome: 'Pessoa Privada', cpfCnpj: '00000000000' }, valorCentavos: 10000,
});

describe('agenda efêmera e idempotência', () => {
  it('gera chave estável sem revelar dados do paciente', () => {
    const a = consulta('ag-1');
    const chave = chaveConsultaFiscal(a, segredo);
    expect(chave).toMatch(/^[0-9a-f]{64}$/);
    expect(chaveConsultaFiscal({ ...a, tomador: { nome: 'Outro Nome', cpfCnpj: '11111111111' } }, segredo)).toBe(chave);
    expect(chaveConsultaFiscal(a, segredo)).toBe(chave);
  });
  it('distingue consultas diferentes no mesmo dia e horários alterados', () => {
    expect(chaveConsultaFiscal(consulta('ag-1'), segredo)).not.toBe(chaveConsultaFiscal(consulta('ag-2'), segredo));
    expect(chaveConsultaFiscal(consulta('ag-1'), segredo)).not.toBe(chaveConsultaFiscal(consulta('ag-1','2026-11-01T14:00:00Z'), segredo));
  });
  it('rejeita consulta sem profissional confirmado', () => {
    expect(() => chaveConsultaFiscal({ ...consulta('ag-1'), profissionalConfirmado: false }, segredo)).toThrow();
  });
  it('pergunta quando não há regra ou tomador confirmado', () => {
    const c = [consulta('ag-1'), consulta('ag-2')];
    expect(resolverAgrupamento(c).tipo).toBe('perguntar');
    expect(resolverAgrupamento(c, undefined, true).tipo).toBe('perguntar');
  });
  it('aplica regra permanente apenas ao mesmo médico e conta', () => {
    const c = [consulta('ag-1'), consulta('ag-2')];
    const escolha = registrarEscolha('agrupar','sempre','conta-1','medico-1','operador-1');
    expect(escolha.persistir).toBe(true);
    if (!escolha.persistir) throw new Error('esperada preferência');
    expect(resolverAgrupamento(c, escolha.preferencia, true)).toEqual({ tipo:'aplicar', decisao:'agrupar' });
    expect(resolverAgrupamento([{...c[0]!, medicoId:'medico-2'},c[1]!], escolha.preferencia, true).tipo).toBe('perguntar');
  });
  it('não persiste decisão somente desta vez', () => {
    expect(registrarEscolha('separar','somente_esta_vez','conta-1','medico-1','operador-1'))
      .toEqual({ persistir:false, decisao:'separar' });
  });
});
