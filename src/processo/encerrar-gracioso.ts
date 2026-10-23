/**
 * Encerramento ordenado: para de aceitar requisições, deixa a emissão de NFS-e
 * em andamento terminar e só então fecha o banco. Sem isso, um deploy (SIGTERM)
 * cortava a emissão entre a SEFIN autorizar e a nota ser gravada. Alvos e
 * `sair` são injetados para testar sem derrubar o processo de teste.
 */

import { registrarLinhaSincrona } from '../observabilidade/registrar-sincrono.js';

export interface AlvosEncerramento {
  fecharServidor: () => Promise<void>;
  pararWorker: () => Promise<void>;
  fecharPool: () => Promise<void>;
}

export interface OpcoesEncerramento {
  tempoLimiteMs: number;
  sair: (codigo: number) => void;
}

export type Encerrar = (motivo: string, codigo: number) => Promise<void>;

export function criarEncerramentoGracioso(alvos: AlvosEncerramento, opcoes: OpcoesEncerramento): Encerrar {
  let emAndamento = false;
  return async (motivo, codigo) => {
    if (emAndamento) return;
    emAndamento = true;
    registrarLinhaSincrona(`[Encerramento] ${motivo}: aguardando requisições e emissão em andamento (limite ${opcoes.tempoLimiteMs} ms).`);
    await drenarComLimite(alvos, opcoes.tempoLimiteMs);
    opcoes.sair(codigo);
  };
}

async function drenarComLimite(alvos: AlvosEncerramento, tempoLimiteMs: number): Promise<void> {
  let temporizador: NodeJS.Timeout | undefined;
  const limite = new Promise<void>((resolver) => {
    temporizador = setTimeout(() => {
      registrarLinhaSincrona('[Encerramento] Tempo limite atingido; encerrando mesmo com trabalho pendente.');
      resolver();
    }, tempoLimiteMs);
  });
  await Promise.race([drenar(alvos), limite]);
  clearTimeout(temporizador);
}

async function drenar(alvos: AlvosEncerramento): Promise<void> {
  await Promise.allSettled([alvos.fecharServidor(), alvos.pararWorker()]);
  await alvos.fecharPool().catch((erro: Error) => registrarLinhaSincrona(`[Encerramento] Falha ao fechar o pool: ${erro.message}`));
}
