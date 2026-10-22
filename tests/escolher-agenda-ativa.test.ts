import { describe, expect, it } from 'vitest';
import { escolherAgendaAtiva } from '../src/cofre/router.js';
const e = (salvo: boolean, conectada: boolean, consentimentoEm: string | null = null) => ({ salvo, conectada, consentimentoEm });
describe('escolherAgendaAtiva', () => {
  it('só uma salva: essa', () => {
    expect(escolherAgendaAtiva(e(true, true, 'a'), e(false, false))).toBe('tribemd');
    expect(escolherAgendaAtiva(e(false, false), e(true, true, 'a'))).toBe('amplimed');
  });
  it('as duas conectadas: a conectada por último (caso da Alice)', () => {
    expect(escolherAgendaAtiva(e(true, true, '2026-10-22T13:38:00Z'), e(true, true, '2026-10-22T17:45:00Z'))).toBe('amplimed');
    expect(escolherAgendaAtiva(e(true, true, '2026-10-22T18:00:00Z'), e(true, true, '2026-10-22T17:45:00Z'))).toBe('tribemd');
  });
  it('uma conectada e a outra com atenção: a conectada', () => {
    expect(escolherAgendaAtiva(e(true, false, '2026-10-22T20:00:00Z'), e(true, true, '2026-10-22T10:00:00Z'))).toBe('amplimed');
    expect(escolherAgendaAtiva(e(true, true, '2026-10-22T10:00:00Z'), e(true, false, '2026-10-22T20:00:00Z'))).toBe('tribemd');
  });
});
