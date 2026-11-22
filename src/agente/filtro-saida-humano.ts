/**
 * Filtro de saída humana para o WhatsApp do Noto:
 * 1) normaliza chaves de telefone brasileiro (com/sem 55 e 9º dígito) para
 *    serializar balões sem jamais intercalar falas concorrentes;
 * 2) suprime rajadas repetitivas (ex.: 4 erros fiscais iguais em um lote);
 * 3) evita repetir avisos idênticos em uma janela curta.
 */

const JANELA_DEDUP_PADRAO_MS = 90_000;

export function chaveTelefoneCanonica(telefone: string): string {
  const digitos = telefone.replace(/\D/g, '');
  const semPais = digitos.startsWith('55') && digitos.length >= 12 ? digitos.slice(2) : digitos;
  if (semPais.length === 11 && semPais[2] === '9') {
    return semPais.slice(0, 2) + semPais.slice(3);
  }
  return semPais || digitos;
}

export function assinaturaMensagemSaida(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/\b\d{2}\/\d{2}\/\d{4}\b/g, '[data]')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function criarFiltroSaidaHumano(opcoes?: { janelaDedupMs?: number; agora?: () => number }) {
  const janelaMs = opcoes?.janelaDedupMs ?? JANELA_DEDUP_PADRAO_MS;
  const agoraFn = opcoes?.agora ?? (() => Date.now());
  const filasPorTelefone = new Map<string, Promise<unknown>>();
  const ultimasPorChave = new Map<string, number>();

  function limparExpiradas(agora: number) {
    if (ultimasPorChave.size < 200) return;
    for (const [k, expira] of ultimasPorChave) {
      if (expira <= agora) ultimasPorChave.delete(k);
    }
  }

  return {
    /** Serializa envios de um mesmo destinatário independente do formato do número. */
    enfileirarEnvio<T>(telefone: string, tarefa: () => Promise<T>): Promise<T> {
      const chave = chaveTelefoneCanonica(telefone);
      const anterior = filasPorTelefone.get(chave) ?? Promise.resolve();
      const proximo = anterior.catch(() => undefined).then(tarefa);
      filasPorTelefone.set(chave, proximo);
      return proximo;
    },

    /** Impede rajadas repetidas do mesmo texto ou da mesma categoria de alerta em janela curta. */
    deveSuprimirRepeticao(telefone: string, texto: string, categoriaAlerta?: string): boolean {
      const agora = agoraFn();
      limparExpiradas(agora);
      const tel = chaveTelefoneCanonica(telefone);
      const chave = categoriaAlerta
        ? `cat:${tel}:${categoriaAlerta}`
        : `txt:${tel}:${assinaturaMensagemSaida(texto)}`;
      const expiraEm = ultimasPorChave.get(chave);
      if (expiraEm && expiraEm > agora) return true;
      ultimasPorChave.set(chave, agora + janelaMs);
      return false;
    },

    /** Limpa a janela de deduplicação de alertas quando o médico envia nova mensagem pedindo retentativa. */
    limparHistoricoTelefone(telefone: string): void {
      const tel = chaveTelefoneCanonica(telefone);
      for (const k of ultimasPorChave.keys()) {
        if (k.startsWith(`cat:${tel}:`) || k.startsWith(`txt:${tel}:`)) {
          ultimasPorChave.delete(k);
        }
      }
    }
  };
}
