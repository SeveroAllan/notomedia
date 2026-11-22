/**
 * Regras puras de cortesia temporal e retomada de conversa após hiato longo.
 * Calcula saudação pelo fuso de Brasília (Bom dia / Boa tarde / Boa noite),
 * detecta se faz horas que o Noto e o médico não se falam e orienta/formata
 * aberturas humanas ("Boa noite, tudo bem? Desculpa incomodar...").
 */

export type PeriodoDiaBr = 'manha' | 'tarde' | 'noite';

export interface AvaliacaoCortesiaTemporal {
  horarioBr: string;
  periodoDia: PeriodoDiaBr;
  saudacao: 'Bom dia' | 'Boa tarde' | 'Boa noite';
  minutosSemFalar: number | null;
  hiatoLongo: boolean;
  orientacaoCortesiaTurno: string;
}

const MINUTOS_HIATO_LONGO = 180; // 3 horas sem interação

function extrairHoraMinutoDiaSp(agora: Date): { hora: number; minuto: number; diaIso: string; horarioBr: string } {
  const diaIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora);
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(agora);
  const hStr = partes.find(p => p.type === 'hour')?.value ?? '12';
  const mStr = partes.find(p => p.type === 'minute')?.value ?? '00';
  const hora = Number(hStr) % 24;
  const minuto = Number(mStr);
  return {
    hora,
    minuto,
    diaIso,
    horarioBr: `${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`
  };
}

function classificarPeriodoDia(hora: number): {
  periodoDia: PeriodoDiaBr;
  saudacao: 'Bom dia' | 'Boa tarde' | 'Boa noite';
} {
  if (hora >= 5 && hora < 12) return { periodoDia: 'manha', saudacao: 'Bom dia' };
  if (hora >= 12 && hora < 18) return { periodoDia: 'tarde', saudacao: 'Boa tarde' };
  return { periodoDia: 'noite', saudacao: 'Boa noite' };
}

function extrairPrimeiroNome(nomeProfissional?: string | null): string | null {
  const limpo = (nomeProfissional ?? '')
    .replace(/^\s*(?:dr\.?(?:a\.?)?|doutor(?:a)?)\s+/i, '')
    .trim();
  if (!limpo || /^m[eé]dic[oa]\b/i.test(limpo)) return null;
  const primeiro = limpo.split(/\s+/)[0] ?? '';
  return primeiro.length >= 2 ? primeiro : null;
}

export function avaliarCortesiaTemporal(entrada: {
  agora?: Date;
  ultimaInteracaoIso?: string | null;
  nomeProfissional?: string | null;
}): AvaliacaoCortesiaTemporal {
  const agora = entrada.agora ?? new Date();
  const { hora, diaIso, horarioBr } = extrairHoraMinutoDiaSp(agora);
  const { periodoDia, saudacao } = classificarPeriodoDia(hora);
  const primeiroNome = extrairPrimeiroNome(entrada.nomeProfissional);
  const vocativo = primeiroNome ? `, ${primeiroNome}` : '';

  let minutosSemFalar: number | null = null;
  let mudouDeDia = false;

  if (entrada.ultimaInteracaoIso) {
    const msUltima = Date.parse(entrada.ultimaInteracaoIso);
    if (Number.isFinite(msUltima)) {
      minutosSemFalar = Math.max(0, Math.round((agora.getTime() - msUltima) / 60_000));
      const diaUltima = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(msUltima));
      mudouDeDia = diaUltima !== diaIso;
    }
  }

  const hiatoLongo =
    (minutosSemFalar !== null && minutosSemFalar >= MINUTOS_HIATO_LONGO) ||
    (mudouDeDia && (minutosSemFalar ?? 0) >= 60);

  if (hiatoLongo) {
    const horas = Math.max(1, Math.round((minutosSemFalar ?? MINUTOS_HIATO_LONGO) / 60));
    return {
      horarioBr,
      periodoDia,
      saudacao,
      minutosSemFalar,
      hiatoLongo: true,
      orientacaoCortesiaTurno: `Faz cerca de ${horas}h que vocês não se falam (agora são ${horarioBr} — ${saudacao}). Como uma pessoa real, comece com cortesia natural ("${saudacao}${vocativo}! Tudo bem?" ou "Como estão as coisas?") antes de responder ou pedir algo.`
    };
  }

  if (minutosSemFalar === null) {
    return {
      horarioBr,
      periodoDia,
      saudacao,
      minutosSemFalar: null,
      hiatoLongo: false,
      orientacaoCortesiaTurno: `Agora são ${horarioBr} (${saudacao}). Se for o primeiro contato, cumprimente com "${saudacao}${vocativo}!" de forma natural.`
    };
  }

  return {
    horarioBr,
    periodoDia,
    saudacao,
    minutosSemFalar,
    hiatoLongo: false,
    orientacaoCortesiaTurno: `Conversa já ativa (última fala há ${minutosSemFalar} min; agora são ${horarioBr}). Continue o assunto diretamente sem repetir "${saudacao}" no meio do papo.`
  };
}

/**
 * Quando o Noto toma iniciativa de chamar o médico depois de horas de silêncio,
 * adiciona a cortesia humana apropriada ao horário e ao tipo de abordagem.
 */
export function envolverMensagemProativaComCortesia(entrada: {
  texto: string;
  agora?: Date;
  ultimaInteracaoIso?: string | null;
  nomeProfissional?: string | null;
  ehPedidoDeAjudaOuDado?: boolean;
}): string {
  const textoLimpo = entrada.texto.trim();
  if (!textoLimpo) return textoLimpo;

  // Se o texto já abre com saudação explícita, não duplica.
  if (/^(?:ol[áa]|oi|bom\s+dia|boa\s+tarde|boa\s+noite)\b/i.test(textoLimpo)) {
    return textoLimpo;
  }

  const avaliacao = avaliarCortesiaTemporal({
    agora: entrada.agora,
    ultimaInteracaoIso: entrada.ultimaInteracaoIso,
    nomeProfissional: entrada.nomeProfissional
  });

  if (!avaliacao.hiatoLongo) return textoLimpo;

  const primeiroNome = extrairPrimeiroNome(entrada.nomeProfissional);
  const vocativo = primeiroNome ? `, ${primeiroNome}` : '';
  const pedeAjuda = Boolean(entrada.ehPedidoDeAjudaOuDado) || textoLimpo.includes('?');

  if (avaliacao.periodoDia === 'noite') {
    const aberturaNoite = pedeAjuda
      ? `${avaliacao.saudacao}${vocativo}! Tudo bem? Desculpa te incomodar a essa hora, você consegue me ajudar rapidinho com uma informação?`
      : `${avaliacao.saudacao}${vocativo}! Tudo bem? Desculpa te incomodar a essa hora, só passando para te dar um retorno:`;
    return `${aberturaNoite}\n${textoLimpo}`;
  }

  const aberturaDia = pedeAjuda
    ? `${avaliacao.saudacao}${vocativo}, tudo bem por aí? Desculpa incomodar na correria, você consegue me ajudar com um detalhe?`
    : `${avaliacao.saudacao}${vocativo}, tudo bem? Passando rapidinho para te atualizar:`;
  return `${aberturaDia}\n${textoLimpo}`;
}
