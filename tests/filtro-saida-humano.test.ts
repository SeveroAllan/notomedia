import { describe, expect, it } from 'vitest';
import {
  assinaturaMensagemSaida,
  chaveTelefoneCanonica,
  criarFiltroSaidaHumano
} from '../src/agente/filtro-saida-humano.js';

describe('filtro de saída humana (serialização por telefone canônico + anti-repetição)', () => {
  it('unifica variantes de telefone brasileiro (com/sem 55 e 9º dígito) na mesma fila', async () => {
    expect(chaveTelefoneCanonica('555199990001')).toBe('5199990001');
    expect(chaveTelefoneCanonica('51999990001')).toBe('5199990001');
    expect(chaveTelefoneCanonica('+55 (51) 99999-0001')).toBe('5199990001');

    const filtro = criarFiltroSaidaHumano();
    const ordem: string[] = [];

    const p1 = filtro.enfileirarEnvio('555199990001', async () => {
      ordem.push('inicio-turno-1');
      await new Promise(r => setTimeout(r, 30));
      ordem.push('fim-turno-1');
    });
    const p2 = filtro.enfileirarEnvio('51999990001', async () => {
      ordem.push('alerta-worker');
    });

    await Promise.all([p1, p2]);
    expect(ordem).toEqual(['inicio-turno-1', 'fim-turno-1', 'alerta-worker']);
  });

  it('suprime rajadas de erros repetidos do mesmo lote e libera após expirar a janela', () => {
    let relogio = 1000;
    const filtro = criarFiltroSaidaHumano({ janelaDedupMs: 60_000, agora: () => relogio });

    expect(filtro.deveSuprimirRepeticao('51999990001', 'Erro fiscal 1', 'erro_fiscal_conta:PARAMETROS')).toBe(false);
    expect(filtro.deveSuprimirRepeticao('555199990001', 'Erro fiscal 2', 'erro_fiscal_conta:PARAMETROS')).toBe(true);
    expect(filtro.deveSuprimirRepeticao('51999990001', 'Erro fiscal 3', 'erro_fiscal_conta:PARAMETROS')).toBe(true);

    relogio += 65_000;
    expect(filtro.deveSuprimirRepeticao('51999990001', 'Erro fiscal 4', 'erro_fiscal_conta:PARAMETROS')).toBe(false);
    expect(assinaturaMensagemSaida('Olá! Tudo certo em 28/09/2026.')).toBe('ola tudo certo em data');
  });
});
