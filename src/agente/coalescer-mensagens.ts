/**
 * Agrupador (debounce) de rajadas de mensagens curtas enviadas pelo mesmo
 * remetente no WhatsApp (ex.: "Oi" / "emite a nota" / "da Marina" em 2s).
 * Evita múltiplas chamadas paralelas da IA e respostas atropeladas.
 * Com `janelaMs <= 0`, executa imediatamente sem atraso (ideal para testes).
 */

export interface ResultadoCoalescencia {
  executar: boolean;
  textoUnificado: string;
}

export interface CoalescedorMensagens {
  aguardar(chave: string, texto: string): Promise<ResultadoCoalescencia>;
}

interface LotePendente {
  textos: string[];
  timer: ReturnType<typeof setTimeout>;
  resolverUltimo: (res: ResultadoCoalescencia) => void;
}

export function criarCoalescedorMensagens(opcoes: { janelaMs?: number } = {}): CoalescedorMensagens {
  const janelaMs = opcoes.janelaMs ?? 0;
  if (janelaMs <= 0) {
    return {
      aguardar: async (_chave, texto) => ({ executar: true, textoUnificado: texto })
    };
  }

  const pendentes = new Map<string, LotePendente>();

  return {
    aguardar(chave: string, texto: string): Promise<ResultadoCoalescencia> {
      return new Promise<ResultadoCoalescencia>(resolve => {
        const existente = pendentes.get(chave);
        if (existente) {
          clearTimeout(existente.timer);
          existente.resolverUltimo({ executar: false, textoUnificado: '' });
          existente.textos.push(texto);
          existente.resolverUltimo = resolve;
          existente.timer = setTimeout(() => {
            pendentes.delete(chave);
            existente.resolverUltimo({
              executar: true,
              textoUnificado: existente.textos.join('\n')
            });
          }, janelaMs);
          existente.timer.unref();
          return;
        }

        const lote: LotePendente = {
          textos: [texto],
          resolverUltimo: resolve,
          timer: setTimeout(() => {
            pendentes.delete(chave);
            lote.resolverUltimo({
              executar: true,
              textoUnificado: lote.textos.join('\n')
            });
          }, janelaMs)
        };
        lote.timer.unref();
        pendentes.set(chave, lote);
      });
    }
  };
}
