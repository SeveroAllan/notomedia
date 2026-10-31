import { describe, expect, it, vi } from 'vitest';
import { responderAgente } from '../src/agente/agente.js';

const profissionais = [
  { id: 'alice-id', nome: 'Dra. Alice Silva' },
  { id: 'bruno-id', nome: 'Dr. Bruno Lima' }
];
const conectada = { tribemd: { salvo: true, conectada: true }, amplimed: { salvo: false, conectada: false } };
const desconectada = { tribemd: { salvo: false, conectada: false }, amplimed: { salvo: false, conectada: false } };

describe('Noto Agent — entrada natural guiada por fatos', () => {
  it('se apresenta e pergunta a agenda antes de assumir dados no cadastro vazio', async () => {
    const completar = vi.fn().mockResolvedValue(JSON.stringify({ agenda: null }));
    const consultarStatus = vi.fn();
    const resposta = await responderAgente(
      { texto: 'Oi', profissionais: [], semConta: true, painelUrl: 'https://noto.exemplo.com/' },
      { completar, consultarStatus }
    );
    expect(resposta).toContain('sou o Noto');
    expect(resposta).toContain('qual agenda');
    expect(resposta).toContain('TribeMD, Amplimed ou outra');
    expect(consultarStatus).not.toHaveBeenCalled();
  });

  it('entende a agenda escolhida e orienta a criação segura de conta', async () => {
    const resposta = await responderAgente(
      { texto: 'Uso Amplimed', profissionais: [], semConta: true, painelUrl: 'https://noto.exemplo.com/' },
      {
        completar: vi.fn().mockResolvedValue(JSON.stringify({ agenda: 'amplimed' })),
        consultarStatus: vi.fn()
      }
    );
    expect(resposta).toContain('você usa Amplimed');
    expect(resposta).toContain('vincular seu WhatsApp');
    expect(resposta).toContain('https://noto.exemplo.com');
    expect(resposta).toContain('sem enviar senhas');
  });

  it('não inventa Alice quando não há profissionais, mas conduz ao próximo passo', async () => {
    const resposta = await responderAgente(
      { texto: 'Consulte a agenda da Alice', profissionais: [] },
      { completar: vi.fn().mockResolvedValue(JSON.stringify({ agenda: null })), consultarStatus: vi.fn() }
    );
    expect(resposta).toContain('qual agenda');
    expect(resposta).not.toContain('agenda da Alice está');
  });

  it('não envia credenciais recebidas ao modelo', async () => {
    const completar = vi.fn();
    const resposta = await responderAgente(
      { texto: 'Minha senha: chaveMuitoSecreta123', profissionais: [] },
      { completar, consultarStatus: vi.fn() }
    );
    expect(resposta).toContain('não envie senhas');
    expect(completar).not.toHaveBeenCalled();
  });

  it('apresenta o Noto e pergunta qual agenda usa quando não há conexão', async () => {
    const resposta = await responderAgente(
      { texto: 'Oi, como funciona?', profissionais: [profissionais[0]!] },
      {
        completar: vi.fn().mockResolvedValueOnce(JSON.stringify({ acao: 'orientar', profissional: null }))
          .mockRejectedValueOnce(new Error('IA indisponível')),
        consultarStatus: vi.fn().mockResolvedValue(desconectada)
      }
    );
    expect(resposta).toContain('Eu sou o Noto');
    expect(resposta).toContain('TribeMD, Amplimed ou outra agenda');
  });

  it('reconhece escolha de agenda, sem pedir senha nem disparar emissão', async () => {
    const resposta = await responderAgente(
      { texto: 'Uso Amplimed', profissionais: [profissionais[0]!], painelUrl: 'https://noto.exemplo.com/' },
      {
        completar: vi.fn().mockResolvedValue(JSON.stringify({ acao: 'conectar_agenda', agenda: 'amplimed', profissional: null })),
        consultarStatus: vi.fn().mockResolvedValue(desconectada)
      }
    );
    expect(resposta).toContain('Amplimed');
    expect(resposta).toContain('Cofre');
    expect(resposta).toContain('https://noto.exemplo.com');
    expect(resposta).toContain('não envie senha aqui');
  });

  it('não pede reconexão quando a agenda escolhida já está ativa', async () => {
    const resposta = await responderAgente(
      { texto: 'Eu uso TribeMD', profissionais: [profissionais[0]!] },
      {
        completar: vi.fn().mockResolvedValue(JSON.stringify({ acao: 'conectar_agenda', agenda: 'tribemd', profissional: null })),
        consultarStatus: vi.fn().mockResolvedValue(conectada)
      }
    );
    expect(resposta).toContain('já está conectada');
    expect(resposta).toContain('Não precisa configurar novamente');
  });

  it('não adivinha a identidade quando há profissionais homônimos', async () => {
    const consultarStatus = vi.fn().mockResolvedValue(conectada);
    const resposta = await responderAgente(
      { texto: 'Veja a agenda da Alice', profissionais: [
        { id: 'a1', nome: 'Alice Souza' }, { id: 'a2', nome: 'Alice Lima' }
      ] },
      {
        completar: vi.fn().mockResolvedValue(JSON.stringify({ acao: 'consultar_agendas', profissional: 'Alice' })),
        consultarStatus
      }
    );
    expect(resposta).toContain('mais de um profissional');
  });

  it('faz uma pergunta por vez para escolher profissional antes de conectar', async () => {
    const resposta = await responderAgente(
      { texto: 'Uso Amplimed', profissionais },
      {
        completar: vi.fn().mockResolvedValue(JSON.stringify({ acao: 'conectar_agenda', agenda: 'amplimed', profissional: null })),
        consultarStatus: vi.fn().mockResolvedValue(desconectada)
      }
    );
    expect(resposta).toContain('Para qual profissional');
    expect(resposta).toContain('Alice');
    expect(resposta).toContain('Bruno');
  });

  it('consulta apenas conexões e não afirma que verificou notas fiscais', async () => {
    const completar = vi.fn(async (_mensagens: Array<{ role: 'system' | 'user'; content: string }>, _json?: boolean): Promise<string> =>
      JSON.stringify({ acao: 'consultar_agendas', profissional: 'Alice' }));
    const consultarStatus = vi.fn().mockResolvedValue(conectada);
    const resposta = await responderAgente(
      { texto: 'Noto, como está a agenda da Alice?', profissionais },
      { completar, consultarStatus }
    );
    expect(consultarStatus).toHaveBeenCalledWith('alice-id');
    expect(completar.mock.calls[0]?.[1]).toBe(true);
    expect(resposta).toContain('TribeMD conectada');
    expect(resposta).toContain('não a existência de consultas ou notas pendentes');
  });

  it('não executa ações fiscais fora do catálogo e responde de forma orientativa', async () => {
    const resposta = await responderAgente(
      { texto: 'Emite as notas de ontem', profissionais: [profissionais[0]!] },
      {
        completar: vi.fn().mockResolvedValueOnce(JSON.stringify({ acao: 'orientar', profissional: null }))
          .mockRejectedValueOnce(new Error('indisponível')),
        consultarStatus: vi.fn().mockResolvedValue(desconectada)
      }
    );
    expect(resposta).toContain('Eu sou o Noto');
    expect(resposta).toContain('TribeMD, Amplimed ou outra agenda');
  });

  it('não inventa conexão quando não consegue consultar a fonte', async () => {
    const resposta = await responderAgente(
      { texto: 'Oi', profissionais: [profissionais[0]!] },
      {
        completar: vi.fn().mockResolvedValueOnce(JSON.stringify({ acao: 'orientar', profissional: null }))
          .mockRejectedValueOnce(new Error('indisponível')),
        consultarStatus: vi.fn().mockRejectedValue(new Error('cofre indisponível'))
      }
    );
    expect(resposta).toContain('Não consegui conferir todas as conexões');
  });
});