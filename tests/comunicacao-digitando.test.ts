import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { ComunicacaoHomologacao } from '../src/whatsapp/comunicacao-homologacao.js';

function cenario(overrides: Record<string, unknown> = {}) {
  const eventos: string[] = [];
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [{ telefone: '5511999990000', ambiente: 'homologacao' }] })
  } as any;
  const config = {
    conversaLivreAtiva: true,
    envioMedicoRealAtivo: true,
    evolutionAssistantInstanceName: 'assistente',
    envioRealAllowlist: ['5511999990000'],
    appPepper: 'pepper-ficticio'
  } as AppConfig;
  const transporte = {
    enviarTexto: vi.fn(),
    iniciarDigitacao: vi.fn(async () => ({
      parar: async () => { eventos.push('fim'); }
    })),
    ...overrides
  } as any;
  const logs: string[] = [];
  return {
    eventos,
    transporte,
    logs,
    comunicacao: new ComunicacaoHomologacao(pool, config, transporte, texto => logs.push(texto))
  };
}

describe('sessão de digitando da conversa', () => {
  it('permanece ativa durante o processamento e usa o telefone do operador', async () => {
    const { comunicacao, transporte, eventos } = cenario({
      iniciarDigitacao: vi.fn(async () => {
        eventos.push('inicio');
        return { parar: async () => { eventos.push('fim'); } };
      })
    });

    const resultado = await comunicacao.duranteDigitacao(
      'medico-ficticio',
      { id: 'mensagem-1', remoteJid: '123456789@lid', fromMe: false },
      '5511999990000',
      async () => {
        eventos.push('processando');
        return 42;
      }
    );

    expect(resultado).toBe(42);
    expect(eventos).toEqual(['inicio', 'processando', 'fim']);
    expect(transporte.iniciarDigitacao).toHaveBeenCalledWith({
      instanciaNome: 'assistente',
      contatoTelefone: '5511999990000'
    });
  });

  it('falha da presença não impede o processamento da conversa', async () => {
    const { comunicacao, logs } = cenario({
      iniciarDigitacao: vi.fn(async () => { throw new Error('falha-ficticia'); })
    });

    await expect(comunicacao.duranteDigitacao(
      'medico-ficticio',
      { id: 'mensagem-2', remoteJid: '5511999990000@s.whatsapp.net', fromMe: false },
      '5511999990000',
      async () => 'resposta'
    )).resolves.toBe('resposta');

    expect(logs.some(log => log.includes('PRESENCA_DIGITACAO_FALHOU'))).toBe(true);
  });
});
