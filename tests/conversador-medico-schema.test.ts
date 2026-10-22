import { describe, it, expect } from 'vitest';
import { ConversadorMedico } from '../src/onboarding/conversador-medico.js';
const base = { texto: 'Desde o dia 4', mensagens: [], resumo: null, agora: new Date('2026-10-22T12:00:00Z'), acoesPermitidas: ['nenhuma'], fatos: { ambiente: 'homologacao', agenda: { nome: null, conectada: false }, link: { ativo: false, enviados: 0 }, periodo: null, semAgendaDigital: false, lote: null } } as never;
const com = (saida: unknown) => new ConversadorMedico('k', 'm', (async () => JSON.stringify(saida)) as never);
describe('decisao tolerante a campos extras ou nulos', () => {
  it('aceita parametros com nulos, periodo desconhecido e chave extra', async () => {
    const r = await com({ fala: ['Entendi o período. Qual agenda você usa?'], acao: null, parametros: { desde: '2026-10-04', agenda: null, periodo: 'desde_dia_4', extra: 'x' } }).responder(base);
    expect(r.fala[0]).toContain('agenda'); expect(r.parametros?.desde).toBe('2026-10-04');
  });
  it('confirmacao continua estrita', async () => {
    const r = await com({ fala: ['ok'], acao: null, parametros: { confirmacao: { intencao: 'sim', confianca: 1, extra: 1 } } }).responder(base);
    expect(r.fala[0]).toContain('Não consegui');
  });
});
describe('reação curta sem fala', () => {
  it('aceita só reação quando não há nada novo a dizer', async () => {
    const r = await com({ fala: [], acao: null, reacao: '👍' }).responder({ ...(base as object), texto: 'Ta bom' } as never);
    expect(r.fala).toEqual([]); expect(r.reacao).toBe('👍');
  });
});
