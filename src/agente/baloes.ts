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
    if (palavras.length <= 15) { baloes.push(frase); continue; }
    // Tenta quebrar por ideia em pontuação natural, sem cortar links, códigos ou valores.
    const partes = frase.split(/(?<=[,;:])\s+/).filter(Boolean);
    let atual = '';
    for (const parte of partes) {
      if ((atual + ' ' + parte).trim().split(/\s+/).length > 15 && atual) {
        baloes.push(atual);
        atual = '';
      }
      const tokens = parte.split(/\s+/);
      if (tokens.length > 15) {
        if (atual) { baloes.push(atual); atual = ''; }
        for (let i = 0; i < tokens.length; i += 15) baloes.push(tokens.slice(i, i + 15).join(' '));
      } else atual = [atual, parte].filter(Boolean).join(' ');
    }
    if (atual) baloes.push(atual);
  }
  // Links sempre sozinhos e por último, sem abrir mão de conteúdo anterior.
  return [...baloes, ...links].slice(0, 12);
}

export function reacaoContextual(texto: string): '❤️' | '👍' | '🔎' | '👀' | null {
  const t = texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  if (/\b(obrigad[ao]|valeu|agradec|gratidao)\b/.test(t)) return '❤️';
  if (/\b(verific|confir|confer|consult|procure|busque|pesquis|descubr|analise|veja|preciso que|pode fazer|consegue|me ajude|quero que|envie|mande)\w*/.test(t)) return '🔎';
  if (/\?$|^(como|qual|quando|onde|porque|por que|quanto|quem|o que|sera que)\b/.test(t)) return '👀';
  if (/^(sim|isso|certo|correto|pode|confirmo|ok|ta bom|beleza|perfeito|entendi|exato|concordo|👍)\b/.test(t)) return '👍';
  return null;
}

export function solicitouVerificacao(texto: string): boolean {
  return /\b(verific|confir|confer|consult|procure|pesquis|veja|chequ)\w*/i.test(texto.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}
