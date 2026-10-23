/**
 * Escrita síncrona de linhas de diagnóstico no stderr. Em container, stdout/stderr
 * são pipes: console.* é assíncrono no Node e process.exit/SIGKILL descartam o que
 * ainda está no buffer — foi assim que a classe do erro da conversa se perdeu na
 * morte súbita do container. writeSync entrega os bytes ao descritor antes de
 * retornar, então a linha consta no log do orquestrador mesmo se o processo
 * morrer em seguida. O conteúdo já chega sanitizado pelos chamadores
 * (registroErroNoto/sanitizarErroFiscal); aqui nada é inspecionado ou guardado.
 * Em teste (NODE_ENV=test) a linha segue pelo console no canal indicado, para os
 * espiões do arsenal capturarem como antes; o caminho síncrono é coberto em
 * tests/registrar-sincrono.test.ts com escritor injetado.
 */

import { writeSync } from 'node:fs';

type EscritorSincrono = (descritor: number, dados: string) => unknown;

export interface OpcoesRegistroSincrono {
  escrever?: EscritorSincrono;
  descritor?: number;
  /** Canal do console usado em NODE_ENV=test; cada chamador mantém o canal que já usava. */
  consoleTeste?: 'error' | 'warn';
}

export function registrarLinhaSincrona(linha: string, opcoes: OpcoesRegistroSincrono = {}): void {
  const { escrever, descritor = 2, consoleTeste = 'error' } = opcoes;
  const dados = linha.endsWith('\n') ? linha : `${linha}\n`;
  try {
    if (escrever) escrever(descritor, dados);
    else if (process.env['NODE_ENV'] === 'test') console[consoleTeste](dados.slice(0, -1));
    else writeSync(descritor, dados);
  } catch {
    try { console.error(linha); } catch { /* Sem canal restante: nada a fazer. */ }
  }
}

/** Atalho para linhas que viviam em console.warn (mantém o canal nos testes). */
export function registrarLinhaSincronaConsoleAviso(linha: string): void {
  registrarLinhaSincrona(linha, { consoleTeste: 'warn' });
}
