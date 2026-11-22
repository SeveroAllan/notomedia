/**
 * Regras puras das preferências de emissão de notas da conta. Isoladas de banco
 * e de IA para manter a modelagem (booleanos sim/não, inferência contextual de
 * rotina diária, pendências e próximo assunto natural) determinística e testável sem I/O.
 */

export type ChavePreferenciaEmissao =
  | 'emitirApenasComComprovante'
  | 'revisaoDiariaAgenda'
  | 'enviarNotaParaPaciente'
  | 'pedirAprovacaoAntesDeEmitir'
  | 'solicitarCpfDiretoPaciente';

export interface PreferenciasEmissaoConta {
  emitirApenasComComprovante: boolean | null;
  revisaoDiariaAgenda: boolean | null;
  enviarNotaParaPaciente: boolean | null;
  pedirAprovacaoAntesDeEmitir: boolean | null;
  solicitarCpfDiretoPaciente: boolean | null;
}

export type AtualizacaoPreferenciasEmissao = Partial<Record<ChavePreferenciaEmissao, boolean | null>>;

export interface AssuntoPreferenciaPendente {
  chave: ChavePreferenciaEmissao;
  contextoConversa: string;
}

export interface ResumoPreferenciasEmissao {
  valores: PreferenciasEmissaoConta;
  pendentes: ChavePreferenciaEmissao[];
  completas: boolean;
  proximoAssunto: AssuntoPreferenciaPendente | null;
  comoFuncionaNaPratica: string | null;
  resumoCombinado: string[];
}

export const PREFERENCIAS_EMISSAO_VAZIAS: PreferenciasEmissaoConta = {
  emitirApenasComComprovante: null,
  revisaoDiariaAgenda: null,
  enviarNotaParaPaciente: null,
  pedirAprovacaoAntesDeEmitir: null,
  solicitarCpfDiretoPaciente: null
};

const ORDEM_ASSUNTOS_CONVERSA: readonly AssuntoPreferenciaPendente[] = [
  {
    chave: 'emitirApenasComComprovante',
    contextoConversa: 'Entender se o médico emite a nota só quando o paciente manda o comprovante de pagamento ou se já emite depois que a consulta termina.'
  },
  {
    chave: 'revisaoDiariaAgenda',
    contextoConversa: 'Apenas se ainda não estiver definido: saber se ele quer que você olhe a agenda todo dia no fim das consultas para preparar as notas.'
  },
  {
    chave: 'pedirAprovacaoAntesDeEmitir',
    contextoConversa: 'Entender se antes de cada nota sair ele prefere dar um ok rapidinho ou se você já pode emitir direto.'
  },
  {
    chave: 'enviarNotaParaPaciente',
    contextoConversa: 'Saber se, quando a nota ficar pronta, você já manda pro paciente pelo WhatsApp conectado dele (como se fosse ele/secretária) ou entrega só pra ele.'
  },
  {
    chave: 'solicitarCpfDiretoPaciente',
    contextoConversa: 'Saber se, quando faltar o CPF de um paciente, você pode pedir direto pra ele pelo WhatsApp conectado (como se fosse o médico/secretária) ou se pergunta primeiro pro médico.'
  }
];

export function mesclarPreferenciasEmissao(
  atual: PreferenciasEmissaoConta,
  atualizacao: AtualizacaoPreferenciasEmissao
): PreferenciasEmissaoConta {
  const escolher = (chave: ChavePreferenciaEmissao): boolean | null => {
    const novo = atualizacao[chave];
    return typeof novo === 'boolean' ? novo : atual[chave];
  };

  const emitirApenasComComprovante = escolher('emitirApenasComComprovante');
  let revisaoDiariaAgenda = escolher('revisaoDiariaAgenda');

  // Inferência natural de rotina: quem emite só com comprovante dispara ao receber
  // o comprovante; quem emite após a consulta acompanha as consultas finalizadas na agenda.
  if (
    typeof atualizacao.emitirApenasComComprovante === 'boolean' &&
    typeof atualizacao.revisaoDiariaAgenda !== 'boolean' &&
    (atual.revisaoDiariaAgenda === null || atual.emitirApenasComComprovante !== atualizacao.emitirApenasComComprovante)
  ) {
    revisaoDiariaAgenda = !atualizacao.emitirApenasComComprovante;
  }

  return {
    emitirApenasComComprovante,
    revisaoDiariaAgenda,
    enviarNotaParaPaciente: escolher('enviarNotaParaPaciente'),
    pedirAprovacaoAntesDeEmitir: escolher('pedirAprovacaoAntesDeEmitir'),
    solicitarCpfDiretoPaciente: escolher('solicitarCpfDiretoPaciente')
  };
}

/**
 * Reconcilia determinísticamente a proposta do modelo com a fala real do médico
 * e o estado atual das preferências, impedindo inversões como interpretar
 * "Depois do comprovante" como pós-consulta ou "Pergunta pra mim" (na etapa de CPF)
 * como alteração da aprovação de nota já combinada.
 */
export function reconciliarPreferenciasComFalaDoMedico(
  falaMedico: string | undefined,
  atual: PreferenciasEmissaoConta,
  propostaLlm: AtualizacaoPreferenciasEmissao
): AtualizacaoPreferenciasEmissao {
  if (!falaMedico?.trim()) return propostaLlm;
  const norm = falaMedico
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  const corrigida: AtualizacaoPreferenciasEmissao = { ...propostaLlm };
  const proximoPendente = sugerirProximoAssuntoPreferencias(atual)?.chave ?? null;

  // 1. Gatilho: comprovante vs. pós-consulta
  const citaComprovante = /\b(?:comprovante|com\s+provante|pagamento)\b/.test(norm) && !/\bsem\s+comprovante\b/.test(norm);
  const citaPosConsulta = /\b(?:depois\s+da\s+consulta|apos\s+a\s+consulta|logo\s+depois\s+da\s+consulta|fim\s+da\s+consulta)\b/.test(norm);
  if (citaComprovante && !citaPosConsulta) {
    corrigida.emitirApenasComComprovante = true;
    if (!/\b(?:todo\s+dia|diaria|olhar\s+a\s+agenda)\b/.test(norm)) {
      corrigida.revisaoDiariaAgenda = false;
    }
  } else if (citaPosConsulta && !citaComprovante) {
    corrigida.emitirApenasComComprovante = false;
  }

  // 2. Envio da nota: para o médico vs. para o paciente
  const notaParaMedico = /\b(?:(?:envia|enviar|envie|manda|mandar|mande|entrega|entregar)\s+(?:a\s+nota\s+)?(?:so\s+)?(?:pra|para)\s+mim|prefiro\s+que\s+(?:envie|mande)\s+(?:pra|para)\s+mim|nao\s+(?:envia|enviar|envie|manda|mandar)\s+(?:pro|para\s+o)\s+paciente)\b/.test(norm);
  const notaParaPaciente = !notaParaMedico && /\b(?:direto\s+(?:pro|para\s+o|no\s+whatsapp\s+do)\s+paciente|(?:envia|enviar|envie|manda|mandar)\s+direto\s+(?:pro|para\s+o)\s+paciente)\b/.test(norm);
  if (notaParaMedico) {
    corrigida.enviarNotaParaPaciente = false;
  } else if (notaParaPaciente && proximoPendente !== 'solicitarCpfDiretoPaciente') {
    corrigida.enviarNotaParaPaciente = true;
  }

  // 3. CPF faltante: "pergunta pra mim" quando a pergunta pendente é CPF (ou cita CPF)
  const pedePerguntarAoMedico = /\b(?:pergunta(?:r)?\s+(?:antes\s+)?(?:pra|para)\s+mim|me\s+pergunta|fala\s+comigo|primeiro\s+(?:pra|para)\s+mim)\b/.test(norm);
  const citaAprovacaoNota = /\b(?:aprova(?:r|cao)?|revisa(?:r)?|ok\s+antes|antes\s+de\s+emitir|pedir\s+(?:meu\s+)?ok|confirmar\s+antes\s+de\s+emitir)\b/.test(norm);

  if (pedePerguntarAoMedico && (proximoPendente === 'solicitarCpfDiretoPaciente' || /\bcpf\b/.test(norm))) {
    corrigida.solicitarCpfDiretoPaciente = false;
  }

  // Nunca sobrescrever pedirAprovacaoAntesDeEmitir já salvo se o médico não falou de aprovação/revisão de nota
  if (
    typeof atual.pedirAprovacaoAntesDeEmitir === 'boolean' &&
    typeof corrigida.pedirAprovacaoAntesDeEmitir === 'boolean' &&
    corrigida.pedirAprovacaoAntesDeEmitir !== atual.pedirAprovacaoAntesDeEmitir &&
    !citaAprovacaoNota &&
    proximoPendente !== 'pedirAprovacaoAntesDeEmitir'
  ) {
    corrigida.pedirAprovacaoAntesDeEmitir = atual.pedirAprovacaoAntesDeEmitir;
  }

  return corrigida;
}

export function listarPreferenciasPendentes(prefs: PreferenciasEmissaoConta): ChavePreferenciaEmissao[] {
  return ORDEM_ASSUNTOS_CONVERSA
    .filter(item => typeof prefs[item.chave] !== 'boolean')
    .map(item => item.chave);
}

export function preferenciasEmissaoCompletas(prefs: PreferenciasEmissaoConta): boolean {
  return listarPreferenciasPendentes(prefs).length === 0;
}

export function sugerirProximoAssuntoPreferencias(
  prefs: PreferenciasEmissaoConta
): AssuntoPreferenciaPendente | null {
  return ORDEM_ASSUNTOS_CONVERSA.find(item => typeof prefs[item.chave] !== 'boolean') ?? null;
}

export function explicarRotinaNaPratica(prefs: PreferenciasEmissaoConta): string | null {
  if (prefs.emitirApenasComComprovante === true && prefs.revisaoDiariaAgenda === false) {
    return 'Quando o paciente mandar o comprovante de pagamento no WhatsApp, eu já vejo a consulta dele na agenda e preparo a nota.';
  }
  if (prefs.emitirApenasComComprovante === true && prefs.revisaoDiariaAgenda === true) {
    return 'Preparo a nota quando chega o comprovante e também dou uma olhada todo dia na agenda e nas conversas para ver se ficou algum comprovante sem nota.';
  }
  if (prefs.emitirApenasComComprovante === false && prefs.revisaoDiariaAgenda === true) {
    return 'Todo dia eu olho na sua agenda as consultas que já foram finalizadas e preparo a nota de cada uma.';
  }
  if (prefs.emitirApenasComComprovante === false && prefs.revisaoDiariaAgenda === false) {
    return 'Preparo a nota depois da consulta sempre que você me avisar ou pedir por aqui.';
  }
  return null;
}

export function descreverPreferenciasCombinadas(prefs: PreferenciasEmissaoConta): string[] {
  const itens: string[] = [];
  const rotina = explicarRotinaNaPratica(prefs);
  if (rotina) itens.push(rotina);
  if (prefs.pedirAprovacaoAntesDeEmitir === true) itens.push('pedir um ok seu antes de emitir cada nota');
  if (prefs.pedirAprovacaoAntesDeEmitir === false) itens.push('emitir direto assim que estiver tudo certo');
  if (prefs.enviarNotaParaPaciente === true) itens.push('mandar a nota pronta direto no WhatsApp do paciente');
  if (prefs.enviarNotaParaPaciente === false) itens.push('entregar a nota só para você, sem mandar ao paciente');
  if (prefs.solicitarCpfDiretoPaciente === true) itens.push('pedir o CPF educadamente direto pro paciente quando faltar');
  if (prefs.solicitarCpfDiretoPaciente === false) itens.push('perguntar o CPF pra você quando faltar na agenda');
  return itens;
}

export function avaliarPreferenciasEmissao(prefs: PreferenciasEmissaoConta): ResumoPreferenciasEmissao {
  const pendentes = listarPreferenciasPendentes(prefs);
  return {
    valores: prefs,
    pendentes,
    completas: pendentes.length === 0,
    proximoAssunto: sugerirProximoAssuntoPreferencias(prefs),
    comoFuncionaNaPratica: explicarRotinaNaPratica(prefs),
    resumoCombinado: descreverPreferenciasCombinadas(prefs)
  };
}
