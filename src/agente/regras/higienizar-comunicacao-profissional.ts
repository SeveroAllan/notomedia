/**
 * Regras puras de higiene linguística e clareza profissional em PT-BR para as
 * respostas do Noto no WhatsApp. Elimina vícios de linguagem (pleonasmos,
 * gerundismos, muletas, perguntas duplas redundantes e repetição de ideias na
 * mesma mensagem) sem alterar valores, datas, nomes próprios, CPFs ou URLs.
 */

const STOPWORDS_PT = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das',
  'em', 'no', 'na', 'nos', 'nas', 'por', 'para', 'pra', 'pro', 'com', 'sem', 'que',
  'e', 'ou', 'se', 'ja', 'ainda', 'mas', 'eu', 'voce', 'vc', 'ele', 'ela', 'seu',
  'sua', 'te', 'lhe', 'me', 'aqui', 'la', 'ali', 'isso', 'isto', 'essa', 'esse',
  'esta', 'este', 'estao', 'esta', 'foi', 'foram', 'ser', 'estar', 'ter', 'fazer'
]);

const PLEONASMOS_VICIOSOS: ReadonlyArray<[RegExp, string]> = [
  [/\bentrar\s+para\s+dentro\b/gi, 'entrar'],
  [/\bsair\s+para\s+fora\b/gi, 'sair'],
  [/\bsubir\s+para\s+cima\b/gi, 'subir'],
  [/\bdescer\s+para\s+baixo\b/gi, 'descer'],
  [/\belo\s+de\s+liga[çc][ãa]o\b/gi, 'elo'],
  [/\bh[áa]\s+(\d+\s+)?(anos?|meses|m[êe]s|dias?|horas?|minutos?|semanas?)\s+atr[áa]s\b/gi, 'há $1$2'],
  [/\brepetir\s+(?:de\s+novo|novamente)\b/gi, 'repetir'],
  [/\bvoltar\s+atr[áa]s\b/gi, 'voltar'],
  [/\bplanejar\s+antecipadamente\b/gi, 'planejar'],
  [/\bencarar\s+de\s+frente\b/gi, 'encarar'],
  [/\bfato\s+real\b/gi, 'fato'],
  [/\bfatos\s+reais\b/gi, 'fatos'],
  [/\bacabamento\s+final\b/gi, 'acabamento'],
  [/\bconclus[ãa]o\s+final\b/gi, 'conclusão']
];

const GERUNDISMOS: ReadonlyArray<[RegExp, string]> = [
  [/\b(vou|vamos|posso|pode|podemos)\s+estar\s+verificando\b/gi, '$1 verificar'],
  [/\b(vou|vamos|posso|pode|podemos)\s+estar\s+conferindo\b/gi, '$1 conferir'],
  [/\b(vou|vamos|posso|pode|podemos)\s+estar\s+enviando\b/gi, '$1 enviar'],
  [/\b(vou|vamos|posso|pode|podemos)\s+estar\s+reenviando\b/gi, '$1 reenviar'],
  [/\b(vou|vamos|posso|pode|podemos)\s+estar\s+emitindo\b/gi, '$1 emitir'],
  [/\b(vou|vamos|posso|pode|podemos)\s+estar\s+olhando\b/gi, '$1 olhar'],
  [/\b(vou|vamos|posso|pode|podemos)\s+estar\s+consultando\b/gi, '$1 consultar'],
  [/\b(vou|vamos|posso|pode|podemos)\s+estar\s+preparando\b/gi, '$1 preparar'],
  [/\b(vou|vamos|posso|pode|podemos)\s+estar\s+acompanhando\b/gi, '$1 acompanhar'],
  [/\b(vou|vamos|posso|pode|podemos)\s+estar\s+avisando\b/gi, '$1 avisar'],
  [/\b(vou|vamos|posso|pode|podemos)\s+estar\s+atualizando\b/gi, '$1 atualizar'],
  [/\b(vou|vamos|posso|pode|podemos)\s+estar\s+checando\b/gi, '$1 checar'],
  [/\b(vou|vamos|posso|pode|podemos)\s+estar\s+mandando\b/gi, '$1 mandar'],
  [/\b(vou|vamos|posso|pode|podemos)\s+estar\s+transferindo\b/gi, '$1 transferir'],
  [/\bestarei\s+verificando\b/gi, 'vou verificar'],
  [/\bestarei\s+conferindo\b/gi, 'vou conferir'],
  [/\bestarei\s+enviando\b/gi, 'vou enviar'],
  [/\bestarei\s+reenviando\b/gi, 'vou reenviar'],
  [/\bestarei\s+emitindo\b/gi, 'vou emitir'],
  [/\bestarei\s+acompanhando\b/gi, 'vou acompanhar'],
  [/\bestarei\s+avisando\b/gi, 'vou avisar']
];

const MULETAS_PREENCHIMENTO: ReadonlyArray<[RegExp, string]> = [
  [/\bem\s+resumo,\s*concluindo(?:\s+o\s+que\s+(?:eu\s+)?j[áa]\s+disse(?:\s+antes)?)?,?\s*/gi, ''],
  [/\btipo\s+assim,?\s*/gi, ''],
  [/,?\s*\bn[ée]\?(?=\s|$)/gi, ''],
  [/\bna\s+verdade,\s*/gi, ''],
  [/\bvale\s+ressaltar\s+que\s+/gi, ''],
  [/\bcumpre\s+salientar\s+que\s+/gi, ''],
  [/\bademais,\s*/gi, ''],
  [/\boutrossim,\s*/gi, ''],
  [/\bno\s+momento,\s+o\s+sistema\b/gi, 'por aqui']
];

const CACOFONIAS_COMUNS: ReadonlyArray<[RegExp, string]> = [
  [/\beu\s+vi\s+ela\b/gi, 'eu a vi'],
  [/\bpor\s+cada\b/gi, 'a cada']
];

const INICIOS_COMUNS_PT = new Set([
  'a', 'as', 'o', 'os', 'um', 'uma', 'se', 'que', 'quer', 'vou', 'estou', 'nao', 'sim',
  'beleza', 'combinado', 'hoje', 'agora', 'tambem', 'mas', 'por', 'para', 'quando',
  'ainda', 'tudo', 'ja', 'entao', 'olhei', 'tentei', 'pronto', 'claro', 'certo',
  'perfeito', 'boa', 'bom', 'oi', 'ola', 'desculpa', 'nota', 'notas', 'consulta',
  'consultas', 'certificado', 'agenda', 'caso', 'pode', 'posso', 'preciso', 'aqui',
  'eles', 'elas', 'voce', 'seu', 'sua', 'seus', 'suas', 'em', 'no', 'na', 'nos', 'nas',
  'de', 'do', 'da', 'dos', 'das', 'como', 'qual', 'quais', 'isso', 'essa', 'esse'
]);

const PERGUNTA_REDUNDANTE_FINAL = /^(?:quer|deseja|voc[êe]\s+quer|gostaria)\s+que\s+eu\s+(?:fa[çc]a|tente|resolva|envie|reenvie)\s+isso\??$/i;
const OFERTA_ANTERIOR = /\b(?:se\s+quiser,?\s*posso|caso\s+queira,?\s*posso|posso\s+(?:tentar\s+)?(?:reenviar|emitir|verificar|conferir|fazer))\b/i;

function normalizarSemAcento(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function protegerUrls(texto: string): { protegido: string; restaurar: (s: string) => string } {
  const urls: string[] = [];
  const protegido = texto.replace(/https?:\/\/\S+/gi, url => {
    urls.push(url);
    return `__URL_PROTEGIDA_${urls.length - 1}__`;
  });
  return {
    protegido,
    restaurar: s => s.replace(/__URL_PROTEGIDA_(\d+)__/g, (_m, idx) => urls[Number(idx)] ?? '')
  };
}

function extrairTokensSignificativos(frase: string): Set<string> {
  const limpo = normalizarSemAcento(frase).replace(/[^a-z0-9/\s]/g, ' ');
  return new Set(limpo.split(/\s+/).filter(t => t.length >= 3 && !STOPWORDS_PT.has(t)));
}

function extrairFatosNumericos(frase: string): Set<string> {
  return new Set(frase.match(/\b\d+(?:[.,/]\d+)*\b/g) ?? []);
}

function extrairNomesProprios(frase: string): Set<string> {
  const nomes = new Set<string>();
  const palavras = frase.match(/\b[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõçA-ZÁÉÍÓÚÂÊÔÃÕÇ]{2,}\b/g) ?? [];
  for (const palavra of palavras) {
    const norm = normalizarSemAcento(palavra);
    if (!INICIOS_COMUNS_PT.has(norm)) nomes.add(norm);
  }
  return nomes;
}

function trazFatoNovo(anterior: string, candidata: string): boolean {
  if (candidata.includes('__URL_PROTEGIDA_')) return true;
  const numsAnt = extrairFatosNumericos(anterior);
  for (const n of extrairFatosNumericos(candidata)) {
    if (!numsAnt.has(n)) return true;
  }
  const nomesAnt = extrairNomesProprios(anterior);
  for (const nome of extrairNomesProprios(candidata)) {
    if (!nomesAnt.has(nome)) return true;
  }
  return false;
}

function frasesRedundantes(a: string, b: string): boolean {
  if (trazFatoNovo(a, b)) return false;
  const ta = extrairTokensSignificativos(a);
  const tb = extrairTokensSignificativos(b);
  if (ta.size < 3 || tb.size < 3) return false;
  let comuns = 0;
  for (const t of tb) {
    if (ta.has(t)) comuns++;
  }
  return comuns / Math.min(ta.size, tb.size) >= 0.7;
}

function normalizarEspacoAposPontuacao(texto: string): string {
  return texto.replace(/([.!?])([A-ZÁÉÍÓÚÂÊÔÃÕÇ])/g, (match, pont, letra, offset, str) => {
    const antes = str.slice(Math.max(0, offset - 3), offset).toLowerCase();
    if (pont === '.' && /(?:^|\s)dr$|dra$/.test(antes)) return match;
    return `${pont} ${letra}`;
  });
}

function deduplicarFrasesNoTexto(texto: string): string {
  const vistas: string[] = [];
  const linhasSaida: string[] = [];

  for (const linhaBruta of texto.split('\n')) {
    const linha = linhaBruta.trim();
    if (!linha) continue;
    const frases = linha.split(/(?<=[.!?])\s+/).map(f => f.trim()).filter(Boolean);
    const mantidasLinha: string[] = [];

    for (const frase of frases) {
      const ultima = vistas[vistas.length - 1];
      if (ultima && PERGUNTA_REDUNDANTE_FINAL.test(frase) && OFERTA_ANTERIOR.test(ultima)) continue;
      if (vistas.some(anterior => frasesRedundantes(anterior, frase))) continue;
      vistas.push(frase);
      mantidasLinha.push(frase);
    }

    if (mantidasLinha.length) linhasSaida.push(mantidasLinha.join(' '));
  }

  return linhasSaida.join('\n');
}

function aplicarSubstituicoes(texto: string, tabela: ReadonlyArray<[RegExp, string]>): string {
  let atual = texto;
  for (const [padrao, troca] of tabela) atual = atual.replace(padrao, troca);
  return atual;
}

export function higienizarComunicacaoProfissional(texto: string): string {
  const original = texto.trim();
  if (!original || original.startsWith('{')) return original;

  const { protegido, restaurar } = protegerUrls(original);
  let limpo = normalizarEspacoAposPontuacao(protegido);
  limpo = aplicarSubstituicoes(limpo, PLEONASMOS_VICIOSOS);
  limpo = aplicarSubstituicoes(limpo, GERUNDISMOS);
  limpo = aplicarSubstituicoes(limpo, MULETAS_PREENCHIMENTO);
  limpo = aplicarSubstituicoes(limpo, CACOFONIAS_COMUNS);

  limpo = deduplicarFrasesNoTexto(limpo)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .trim();

  // Capitaliza primeira letra se uma muleta inicial foi cortada (ex.: "Na verdade, posso..." -> "Posso...")
  if (limpo && /^[a-záéíóúâêôãõç]/.test(limpo) && /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/.test(original)) {
    limpo = limpo[0]!.toUpperCase() + limpo.slice(1);
  }

  return restaurar(limpo) || original;
}
