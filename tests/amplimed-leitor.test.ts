import { describe, expect, it } from 'vitest';
import { lerAgendaAmplimedTexto } from '../src/agenda/amplimed-leitor.js';
import { checarLeitura } from '../src/agenda/leitura-adaptativa.js';

// Texto real da agenda da conta TESTE do Amplimed (dados fictícios), 22/10/2026.
const tela = `Compromissos
quinta-feira, 22 de out de 2026
08:00 - 08:30
Paciente Teste Um | Avaliação | Particular | R$ 250,00 | 51990000001
09:00 - 09:30
Paciente Teste Dois | Avaliação | Cortesia | R$ 0,00 | 51999000234
10:00 - 10:30
Paciente Teste Tres | Avaliação | Amil | R$ 0,00 | 51999000345
 Recolher
3 Agendamento(s)`;

describe('leitor da agenda Amplimed (fixture da conta teste)', () => {
  const consultas = lerAgendaAmplimedTexto(tela, { data: '2026-10-22', profissional: 'Allan Severo (teste Noto)', status: 'realizada' });
  it('lê as 3 consultas com cobrança e valor', () => {
    expect(consultas.map(c => [c.pacienteNome, c.tipoCobranca, c.valorCentavos])).toEqual([
      ['Paciente Teste Um', 'particular', 25000], ['Paciente Teste Dois', 'cortesia', 0], ['Paciente Teste Tres', 'convenio', 0]]);
  });
  it('passa nas checagens e bate com o total da tela', () => {
    const r = checarLeitura({ consultas, totaisTela: { atendimentos: 3 }, janela: { inicio: '2026-10-22', fim: '2026-10-22' } }, ['Allan Severo (teste Noto)']);
    expect(r.problemas.filter(p => p.codigo !== 'VALOR_PARTICULAR_AUSENTE')).toEqual([]);
  });
  it('sem status informado não presume atendimento', () => {
    expect(lerAgendaAmplimedTexto(tela, { data: '2026-10-22', profissional: 'x' }).every(c => c.status === 'agendada')).toBe(true);
  });
});

import { montarLeituraAmplimed } from '../src/agenda/amplimed-leitor.js';
describe('montarLeituraAmplimed', () => {
  const ev = (h: string, cor: string) => ({ texto: `${h} - 08:30\nPaciente Teste Um | Avaliação | Particular | R$ 250,00 | 51990000001`, cor });
  const o = { data: '2026-10-22', profissional: 'Allan Severo (teste Noto)' };
  it('verde entra; cor desconhecida vira problema e não entra', () => {
    const ok = montarLeituraAmplimed([ev('08:00', 'green')], o);
    expect(ok.confiavel).toBe(true); expect(ok.consultas).toHaveLength(1); expect(ok.consultas[0]!.status).toBe('realizada');
    const dv = montarLeituraAmplimed([ev('08:00', 'green'), ev('09:00', 'orange')], o);
    expect(dv.confiavel).toBe(false); expect(dv.consultas).toHaveLength(1); expect(dv.problemas.map(p => p.codigo)).toContain('STATUS_DESCONHECIDO');
  });
});
