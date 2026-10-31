/** Sete dígitos contíguos já são identificadores longos; anos e datas ISO permanecem legíveis. */
export function sanitizarTextoMedico(texto: string): string {
  return texto
    .replace(/\b(?:senha|password|token|api[_ -]?key|secret|segredo)["']?\s*[:=]\s*[^\r\n;]+/gi, '[OCULTO]')
    .replace(/\bBearer\s+\S+/gi, '[OCULTO]')
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu, '[OCULTO]')
    .replace(/\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2}\b/g, '[OCULTO]')
    .replace(/\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}\b/g, '[OCULTO]')
    .replace(/(?<!\d)(?:\+\d{1,3}[\s.-]*)?(?:\(?\d{2,3}\)?[\s.-]*)?\d{4,5}[\s.-]\d{4}(?!\d)/g, '[OCULTO]')
    .replace(/\d{7,}/g, '[OCULTO]');
}

export const MENSAGEM_INSTABILIDADE = 'Tive uma instabilidade e não consegui concluir agora.';

export function mensagemInstabilidade(historico: readonly string[], verificacaoEmAndamento = false): string {
  const opcoes = verificacaoEmAndamento ? [
    'Tive uma falha na consulta. Estou verificando novamente e volto com o resultado.',
    'A primeira leitura falhou. Já comecei uma nova verificação e te trago o resultado por aqui.',
    'Estou refazendo a leitura da agenda e aviso quando ela terminar.',
    'A verificação está em andamento. Assim que concluir, trago o resultado por aqui.'
  ] : [MENSAGEM_INSTABILIDADE, 'Ainda não consegui concluir a verificação. Não tenho um resultado confirmado para te passar.',
    'A consulta não terminou desta vez. Prefiro conferir antes de te dar uma resposta.',
    'Ainda não consegui concluir esse pedido. Não tenho o resultado para te passar.',
    'Não consegui completar essa consulta agora. Você pode tentar novamente mais tarde.',
    'Ainda não foi possível terminar essa consulta. O resultado segue sem confirmação.',
    'A leitura encontrou um problema e terminou sem um resultado confirmado.',
    'Desta vez, não consegui terminar a verificação. O resultado ainda não está confirmado.'];
  return opcoes.find(texto => !historico.some(anterior => anterior.includes(texto))) ?? 'Não tenho um resultado confirmado desta consulta.';
}
/** Registro consumível por um futuro agente; nunca copiar o detalhe para mensagens. */
export function registroErroNoto(codigo: string, categoria: 'tecnico' | 'acionavel' | 'validacao', contexto: { medicoId?: string; solicitacaoId?: string; etapa?: string; detalhe?: string; codigoErroOriginal?: string; motivoErro?: string } = {}): string {
  const seguro = Object.fromEntries(Object.entries(contexto).map(([k, v]) => [k, sanitizarTextoMedico(String(v)).slice(0, 500)]));
  return `NOTO_ERRO ${JSON.stringify({ codigo: /^[A-Z0-9_]{1,80}$/.test(codigo) ? codigo : 'ERRO_NAO_MAPEADO', categoria, contexto: seguro })}`;
}

/** Só diagnóstico interno: remove identidades usadas na DPS antes de truncar o motivo. */
export function sanitizarErroFiscal(motivo: unknown, identificadores: readonly (string | null | undefined)[] = []): string {
  if (typeof motivo !== 'string') return '[OCULTO]';
  let seguro = motivo.replace(/<[A-Za-z!?][\s\S]*>/g, '[OCULTO]');
  const termos = identificadores.flatMap(v => typeof v === 'string' && v.trim() ? [v.trim(), ...v.trim().split(/\s+/).filter(t => t.length >= 3)] : []);
  for (const termo of [...new Set(termos)].sort((a,b) => b.length - a.length)) {
    for (const variante of new Set([termo, termo.normalize('NFD').replace(/\p{M}/gu, '')])) {
      const literal = variante.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      seguro = seguro.replace(new RegExp(`(?<![\\p{L}\\p{N}])${literal}(?![\\p{L}\\p{N}])`, 'giu'), '[OCULTO]');
    }
  }
  return sanitizarTextoMedico(seguro).replace(/R\$\s*[\d.,]+/gi, '[OCULTO]').slice(0, 500);
}
