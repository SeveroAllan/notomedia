import { describe, expect, it, vi } from 'vitest';
import { responderAgente } from '../src/agente/agente.js';

const profissionais = [
  { id: 'alice-id', nome: 'Dra. Alice Silva' },
  { id: 'bruno-id', nome: 'Dr. Bruno Lima' }
];
const estado = { tribemd: { salvo: true, conectada: true }, amplimed: { salvo: false, conectada: false } };

describe('Noto Agent — primeira ferramenta de leitura', () => {
  it('interpreta linguagem natural e consulta somente o profissional identificado', async () => {
    const completar = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ acao: 'consultar_agendas', profissional: 'Alice' }))
      .mockResolvedValueOnce('A agenda TribeMD de Alice está conectada. A Amplimed ainda não foi configurada.');
    const consultarStatus = vi.fn().mockResolvedValue(estado);
    const resposta = await responderAgente(
      { texto: 'Noto, como está a agenda da Alice?', profissionais },
      { completar, consultarStatus }
    );
    expect(consultarStatus).toHaveBeenCalledTimes(1);
    expect(consultarStatus).toHaveBeenCalledWith('alice-id');
    expect(completar).toHaveBeenCalledTimes(2);
    expect(completar.mock.calls[0]?.[1]).toBe(true);
    expect(resposta).toContain('TribeMD');
  });

  it('não adivinha a identidade quando há profissionais homônimos', async () => {
    const consultarStatus = vi.fn();
    const resposta = await responderAgente(
      { texto: 'Veja a agenda da Alice', profissionais: [
        { id: 'a1', nome: 'Alice Souza' }, { id: 'a2', nome: 'Alice Lima' }
      ] },
      { completar: vi.fn().mockResolvedValue(JSON.stringify({ acao: 'consultar_agendas', profissional: 'Alice' })), consultarStatus }
    );
    expect(resposta).toContain('mais de um');
    expect(consultarStatus).not.toHaveBeenCalled();
  });

  it('não executa ações fiscais fora do catálogo', async () => {
    const consultarStatus = vi.fn();
    const resposta = await responderAgente(
      { texto: 'Emite as notas de ontem', profissionais },
      { completar: vi.fn().mockResolvedValue(JSON.stringify({ acao: 'outro' })), consultarStatus }
    );
    expect(resposta).toContain('não estão habilitadas');
    expect(consultarStatus).not.toHaveBeenCalled();
  });

  it('não expõe resultados inventados quando a IA falha', async () => {
    const consultarStatus = vi.fn();
    const resposta = await responderAgente(
      { texto: 'Como está tudo?', profissionais },
      { completar: vi.fn().mockRejectedValue(new Error('indisponível')), consultarStatus }
    );
    expect(resposta).toContain('Não consegui interpretar');
    expect(consultarStatus).not.toHaveBeenCalled();
  });

  it('informa indisponibilidade sem inventar conexão', async () => {
    const resposta = await responderAgente(
      { texto: 'Verifique as agendas da Alice', profissionais },
      {
        completar: vi.fn()
          .mockResolvedValueOnce(JSON.stringify({ acao: 'consultar_agendas', profissional: 'Alice' }))
          .mockRejectedValueOnce(new Error('IA indisponível')),
        consultarStatus: vi.fn().mockRejectedValue(new Error('cofre indisponível'))
      }
    );
    expect(resposta).toContain('consulta indisponível');
  });
});
