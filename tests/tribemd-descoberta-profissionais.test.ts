import { describe, expect, it } from 'vitest';
import { descobrirProfissionais, extrairAgendaTribemd } from '../src/desenvolvedor/tribemd-agenda.js';

const item = (id: number, extra: Record<string, unknown>) => ({ id, paciente_id: id, status: 10, pacientes: { nome: 'Paciente ' + id }, datahora_atendimento: '2026-10-13T12:00:00-03:00', ...extra });

describe('descoberta de profissionais pela agenda', () => {
  it('junta nomes distintos, ignora acento e caixa, e não traz paciente', () => {
    const r = extrairAgendaTribemd({ atendimentos: [item(1, { profissional: { nome: 'João Silva' } }), item(2, { profissional: { nome: 'joao silva' } }), item(3, { medico: 'Paulo Reis' })] }, '2026-10-20');
    const nomes = descobrirProfissionais(r.consultas);
    expect(nomes).toEqual(['João Silva', 'Paulo Reis']);
    expect(JSON.stringify(nomes)).not.toMatch(/Paciente/);
  });
  it('sem campo de profissional, devolve lista vazia e a leitura segue', () => {
    const r = extrairAgendaTribemd({ atendimentos: [item(1, {})] }, '2026-10-20');
    expect(r.consultas).toHaveLength(1);
    expect(descobrirProfissionais(r.consultas)).toEqual([]);
  });
});
