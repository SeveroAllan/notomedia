/** Um balão é uma unidade de pensamento, não um intervalo arbitrário de caracteres. */
export function separarBaloes(texto: string): string[] {
  const original = texto.trim();
  if (!original) return [];
  const links: string[] = [];
  const semLinks = original.replace(/https:\/\/[^\s<>]+/gi, url => {
    const inteiro = url.replace(/[.,!?;]+$/, '');
    links.push(inteiro);
    return url.slice(inteiro.length);
  });
  const frases = semLinks.split(/\n+|(?<=[.!?])\s+(?=[A-ZÀ-Ý])/u)
    .map(t => t.trim()).filter(Boolean);
  const baloes: string[] = [];
  for (const frase of frases) {
    const palavras = frase.split(/\s+/);
    if (palavras.length <= 32) { baloes.push(frase); continue; }
    // Só divide frases muito longas em ponto-e-vírgula ou dois-pontos, nunca no meio de uma vírgula.
    const partes = frase.split(/(?<=[;:])\s+/).filter(Boolean);
    let atual = '';
    for (const parte of partes) {
      if ((atual + ' ' + parte).trim().split(/\s+/).length > 32 && atual) {
        baloes.push(atual);
        atual = '';
      }
      atual = [atual, parte].filter(Boolean).join(' ');
    }
    if (atual) baloes.push(atual);
  }
  // Nunca descartar uma cláusula de segurança, pendência ou autorização.
  // Limita a quantidade de mensagens, consolidando a cauda sem perder conteúdo.
  const espacos = Math.max(1, 12 - links.length);
  const textoFinal = baloes.length <= espacos ? baloes :
    [...baloes.slice(0, espacos - 1), baloes.slice(espacos - 1).join(' ')];
  return [...textoFinal, ...links];
}

export type ReacaoWhatsApp = '👍' | '❤️' | '🔎' | '👀' | '✅' | '✍️' | '👂';
export type TipoMidiaMensagem = 'texto' | 'audio' | 'imagem' | 'documento';

export function reacaoContextual(
  texto: string,
  opcoes?: { tipoMidia?: TipoMidiaMensagem; seletiva?: boolean }
): ReacaoWhatsApp | null {
  if (opcoes?.tipoMidia === 'audio') return '👂';
  if (opcoes?.tipoMidia === 'imagem' || opcoes?.tipoMidia === 'documento') return '👀';

  const t = texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  if (!t) return null;
  if (/\b(obrigad[ao]|valeu|agradec|gratidao)\b/.test(t)) return '❤️';
  if (/\b(corrig|alter|ajust|mud[ae]|troqu|troc[ae]|escrev|anot|atualiz|edit[ae]|emit[aeir]|ger[ae]r?\s+(?:a\s+)?nota|fazer\s+(?:a\s+)?nota|tirar\s+(?:a\s+)?nota)\w*/.test(t)) return '✍️';
  if (/\b(olha|olhe|da uma olhada|ve essa|veja essa|nessa nota|nesta nota|nesse comprovante|neste comprovante|esse pdf|essa foto|essa imagem|nesse arquivo)\b/.test(t)) return '👀';
  if (/\b(verific|confir|confer|consult|procure|busque|pesquis|descubr|analise|veja|preciso que|pode fazer|consegue|me ajude|quero que|envie|mande)\w*|\b(poderia|pode|consegue)\s+ver\b|\bve\s+pra\s+mim\b/.test(t)) return '🔎';
  if (!opcoes?.seletiva) {
    if (/\?$|^(como|qual|quando|onde|porque|por que|quanto|quem|o que|sera que)\b/.test(t)) return '👀';
    if (/^(sim|isso|certo|correto|pode|confirmo|ok|ta bom|beleza|perfeito|entendi|exato|concordo|👍)\b/.test(t)) return '👍';
  }
  return null;
}

export function ehReacaoAcaoAtiva(emoji: ReacaoWhatsApp | null): boolean {
  return emoji === '🔎' || emoji === '✍️' || emoji === '👀' || emoji === '👂';
}

export function solicitouVerificacao(texto: string): boolean {
  return /\b(verific|confir|confer|consult|procure|pesquis|veja|chequ)\w*/i.test(texto.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}
