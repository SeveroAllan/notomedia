/**
 * Serializa a execução completa de turnos por chave de conversa (`conta+telefone`).
 * Separado de `webhook.ts` para manter controle de concorrência testável sem
 * Express/Postgres e garantir que duas mensagens próximas nunca rodem duas
 * chamadas paralelas ao LLM sobre o mesmo histórico defasado.
 */

export interface FilaTurnosConversa {
  executar<T>(chave: string, fn: (aguardouAnterior: boolean) => Promise<T>): Promise<T>;
}

export function criarFilaTurnosConversa(): FilaTurnosConversa {
  const filas = new Map<string, Promise<void>>();

  return {
    async executar<T>(chave: string, fn: (aguardouAnterior: boolean) => Promise<T>): Promise<T> {
      const anterior = filas.get(chave);
      let liberar!: () => void;
      const atual = new Promise<void>(resolve => { liberar = resolve; });
      const encadeado = (anterior ?? Promise.resolve()).catch(() => undefined).then(() => atual);
      filas.set(chave, encadeado);

      if (anterior) await anterior.catch(() => undefined);
      try {
        return await fn(Boolean(anterior));
      } finally {
        liberar();
        if (filas.get(chave) === encadeado) {
          filas.delete(chave);
        }
      }
    }
  };
}
