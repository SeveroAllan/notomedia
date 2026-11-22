/**
 * Regras puras de verificação determinística entre o texto gerado pelo modelo
 * e as evidências tipadas das ferramentas executadas no turno. Separado de
 * `agente.ts` para manter a validação de linguagem testável sem o SDK de IA.
 */

import type { CodigoFerramenta, EventoFerramenta } from '../diagnostico.js';
import { escolhaAgendaExplicita, type AgendaEscolhida, type EstadoConversa } from '../estado-conversa.js';

export interface ContextoValidacaoFala {
  texto: string;
  estadoConversa?: EstadoConversa;
  situacaoUltimoLink?: { agenda: AgendaEscolhida; estado: string };
}

export function agendaDaPergunta(texto: string): AgendaEscolhida | undefined {
  if (!texto.includes('?')) return undefined;
  const tribe = /\btribe(?:md)?\b/i.test(texto);
  const amplimed = /\bamplimed\b/i.test(texto);
  return tribe === amplimed ? undefined : tribe ? 'tribemd' : 'amplimed';
}

export function respostaCompativelComFerramentas(
  resposta: string,
  eventos: readonly EventoFerramenta[]
): boolean {
  const normalizada = resposta.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const oracoes = normalizada.split(/[.!?;\n]+|\b(?:mas|porem|contudo|entretanto|todavia|so que)\b/).filter(Boolean);
  const incerta = (prefixo: string) =>
    /\b(?:nao sei se|nao posso (?:confirmar|afirmar) se|nao consegui verificar se|nao tenho como confirmar se|nao tenho evidencia de que)(?:\s+(?:a|o|uma|um|minha|sua))?\s*$/.test(prefixo);
  const negada = (prefixo: string) =>
    /\b(?:nao|nunca|jamais)\s*$/.test(prefixo) || incerta(prefixo);
  const naoConfigurada = eventos.some(e => e.codigo === 'INTEGRACAO_NAO_CONFIGURADA');
  if (naoConfigurada && /(?:tentar (?:de novo|novamente|mais tarde|depois)|tente (?:de novo|novamente|mais tarde|depois)|instabilidade|instavel|fora do ar|falha (?:da|na|do) (?:tribemd|tribe|amplimed)|(?:tribemd|tribe|amplimed) (?:falhou|esta fora|indisponivel))/.test(normalizada)) {
    return false;
  }

  const estadosIndisponiveis = eventos.some(e =>
    ['STATUS_INDISPONIVEL', 'STATUS_PARCIAL', 'FERRAMENTA_INDISPONIVEL', 'INTEGRACAO_NAO_CONFIGURADA'].includes(e.codigo));
  const evidenciaConectada = eventos.some(e =>
    e.codigo === 'STATUS_CONECTADO' || e.codigo === 'CONEXAO_EXISTENTE'
    || e.codigo === 'AGENDA_ATENDIMENTOS_CONSULTADOS' || e.codigo === 'AGENDA_LEITURA_INICIADA');
  const evidenciaDesconectada = eventos.some(e => e.codigo === 'STATUS_NAO_CONECTADO');
  const linkAutonomoEnviado = eventos.some(e =>
    (e.nome === 'preparar_link_agenda_inteligente'
      || e.nome === 'enviar_link_cadastro_profissionais'
      || e.nome === 'enviar_link_certificado_profissional')
    && e.codigo === 'LINK_ACEITO_PARA_ENVIO');

  for (const oracao of oracoes) {
    const acao = /\b(?:emiti|emitimos|cancelei|cancelamos|enviei|enviamos)\s+(?:(?:a|uma|o|um|as|os)\s+)?(?:notas?|documentos?|comprovantes?)\b/g;
    for (const match of oracao.matchAll(acao)) {
      const antes = oracao.slice(0, match.index).trimEnd();
      const cancelamentoVerificado = /\b(?:cancelei|cancelamos)\b/.test(match[0])
        && eventos.some(e => e.codigo === 'EMISSAO_CANCELADA');
      if (!negada(antes) && !cancelamentoVerificado) return false;
    }

    const passivo = /\b(?:notas?|documentos?|comprovantes?)\s+(?:(?:ja|ainda|nao|nunca|jamais)\s+)*(?:foi|foram|esta|estao)\s+(?:(?:nao|nunca|jamais)\s+)?(?:emitid[ao]s?|cancelad[ao]s?|enviad[ao]s?)\b/g;
    for (const match of oracao.matchAll(passivo)) {
      const antes = oracao.slice(0, match.index).trimEnd();
      if (!/\b(?:nao|nunca|jamais)\b/.test(match[0]) && !incerta(antes)) return false;
    }

    const verificarAcao = (expressao: RegExp, codigo: CodigoFerramenta): boolean => {
      for (const match of oracao.matchAll(expressao)) {
        const antes = oracao.slice(0, match.index).trimEnd();
        if (!negada(antes) && !eventos.some(e => e.codigo === codigo)) return false;
      }
      return true;
    };

    if (!linkAutonomoEnviado && (/\b(?:enviei|mandei|reenviei|enviamos|mandamos|reenviamos)\b[^.!?;\n]{0,30}\blink\b|\b(?:voce|tu)\s+(?:ja\s+)?(?:recebeu|recebeste)\b[^.!?;\n]{0,20}\blink\b/.test(oracao))) {
      const match = oracao.match(/\b(?:enviei|mandei|reenviei|enviamos|mandamos|reenviamos|recebeu|recebeste)\b/);
      if (!negada(oracao.slice(0, match?.index ?? 0).trimEnd())) return false;
    }
    if (/\b(?:verifiquei|conferi|consultei)\b[^.!?;\n]{0,50}\b(?:certificado|dados fiscais|adn|agenda|sistema)\b/.test(oracao)
      && eventos.length === 0) {
      const match = oracao.match(/\b(?:verifiquei|conferi|consultei)\b/);
      if (!negada(oracao.slice(0, match?.index ?? 0).trimEnd())) return false;
    }
    if (/\b(?:o|esse|meu|seu)\s+link\b[^.!?;\n]{0,65}\b(?:foi|esta|chegou)\s+(?:ja\s+)?(?:entregue|recebido)\b|\b(?:whatsapp|aparelho)\s+(?:ja\s+)?(?:recebeu|confirmou a entrega)\s+(?:(?:o|do|um)\s+)?link\b/.test(oracao)
        && !eventos.some(e => e.codigo === 'LINK_ENTREGUE' || e.codigo === 'LINK_LIDO')) return false;
    if (!verificarAcao(/\b(?:registrei|atualizei|salvei)\s+(?:(?:o|um|os)\s+)?(?:crm|rqe|nome completo|dados profissionais)\b/g, 'DADOS_PROFISSIONAIS_SALVOS')) return false;
    if (!verificarAcao(/\b(?:crm|rqe|dados profissionais)\s+(?:(?:ja|esta|foi)\s+)*(?:registrad[oa]s?|atualizad[oa]s?|salv[oa]s?)\b/g, 'DADOS_PROFISSIONAIS_SALVOS')) return false;
    if (!verificarAcao(/\b(?:foi adicionad[oa]|foram adicionad[oa]s|cadastrei|adicionei)\b[^.!?;\n]{0,65}\b(?:conta|medic[oa]s?|profissionais)\b/g, 'PROFISSIONAIS_CONFIRMADOS')) return false;
    if (/\b(?:encontrei|identifiquei|localizei|achei|ha|tem)\b[^.!?;\n]{0,70}\b(?:profissionais|medic[oa]s)\b[^.!?;\n]{0,60}\b(?:agenda|clinica)\b/.test(oracao)
      && !eventos.some(e => e.codigo === 'PROFISSIONAIS_ENCONTRADOS' || e.codigo === 'PROFISSIONAIS_NAO_IDENTIFICADOS')) return false;
    if (/\b(?:encontrei|achei|localizei)\b[^.!?;\n]{0,100}\bna agenda\b/.test(oracao)
      && !eventos.some(e => e.codigo === 'PROFISSIONAIS_ENCONTRADOS' || e.codigo === 'AGENDA_ATENDIMENTOS_CONSULTADOS' || e.codigo === 'AGENDA_LEITURA_INICIADA')) {
      const m = oracao.match(/\b(?:encontrei|achei|localizei)\b/);
      if (!negada(oracao.slice(0, m?.index ?? 0).trimEnd())) return false;
    }

    const estado = /\b(?:agenda|tribemd|amplimed)\b[^.!?;\n]{0,100}?\b(?:desconectad[ao]s?|conectad[ao]s?|ativ[ao]s?)\b/g;
    for (const match of oracao.matchAll(estado)) {
      const antes = oracao.slice(0, match.index).trimEnd();
      if (incerta(antes) || /\b(?:pode|podem|talvez|possivelmente)\b/.test(match[0])) continue;
      if (estadosIndisponiveis) return false;
      const desconectada = /\bdesconectad[ao]s?\b/.test(match[0]) ||
        /\b(?:nao|nunca|jamais)\b[^,;.!?\n]{0,40}\b(?:conectad[ao]s?|ativ[ao]s?)\b/.test(match[0]);
      if (desconectada ? !evidenciaDesconectada || evidenciaConectada : !evidenciaConectada) return false;
    }
  }
  return true;
}

export function descreverReconexao(eventos: readonly EventoFerramenta[]): string | null {
  if (!eventos.some(e => e.nome === 'descobrir_profissionais_agenda' && e.codigo === 'CONEXAO_PENDENTE')) return null;
  const link = eventos.some(e => e.nome === 'solicitar_link_seguro_agenda' && e.codigo === 'LINK_ACEITO_PARA_ENVIO');
  return 'A conexão com a agenda caiu. ' + (link ? 'Abra a página segura para reconectar.' : 'Precisamos reconectar pela página segura para conferir os profissionais.');
}

export function acompanhamentoVerificado(
  entrada: ContextoValidacaoFala,
  eventos: readonly EventoFerramenta[]
): string | null {
  const tem = (codigo: CodigoFerramenta) => eventos.some(e => e.codigo === codigo);
  const agenda = escolhaAgendaExplicita(entrada.texto)
    ?? agendaDaPergunta(entrada.texto)
    ?? entrada.estadoConversa?.agendaEscolhida
    ?? entrada.situacaoUltimoLink?.agenda;
  const nomeAgenda = agenda === 'tribemd' ? 'TribeMD' : agenda === 'amplimed' ? 'Amplimed' : 'agenda';

  if (tem('LINK_ACEITO_PARA_ENVIO')) {
    if (eventos.some(e => e.nome === 'enviar_link_cadastro_profissionais' && e.codigo === 'LINK_ACEITO_PARA_ENVIO')) {
      return 'Preencha os dados dos profissionais pela página segura. Assim que salvar, envio o link do Certificado A1 de cada um.';
    }
    if (eventos.some(e => e.nome === 'enviar_link_certificado_profissional' && e.codigo === 'LINK_ACEITO_PARA_ENVIO')) {
      return 'Envie o Certificado A1 pela página segura de cada profissional. Assim que salvar, puxo os dados tributários automaticamente e te aviso aqui.';
    }
    return 'Depois de preencher a página segura, não precisa me avisar. A verificação da agenda começa ali.';
  }
  if (tem('CONEXAO_EXISTENTE')) {
    return [
      `A agenda ${nomeAgenda} já está conectada.`,
      'Antes de vincular qualquer médico, precisamos verificar os profissionais na fonte.',
      'Nenhum profissional será adicionado sem sua confirmação.'
    ].join(' ');
  }
  if (tem('LINK_ENTREGUE') || tem('LINK_LIDO')) {
    return [
      tem('LINK_LIDO') ? 'O WhatsApp registrou a leitura do link seguro.' : 'O WhatsApp confirmou a entrega do link seguro.',
      'Isso não confirma o login na agenda.',
      'A verificação dos médicos começa depois da conexão autenticada.'
    ].join(' ');
  }
  if (agenda && tem('AGENDA_FORA_DO_FOCO') &&
      eventos.every(e => e.codigo === 'AGENDA_FORA_DO_FOCO' || e.nome === 'consultar_contexto_conta')) {
    return agendaDaPergunta(entrada.texto) && agenda !== entrada.estadoConversa?.agendaEscolhida
      ? `Posso conferir a conexão da ${nomeAgenda} para continuar.`
      : `A agenda escolhida é a ${nomeAgenda}. Posso conferir a conexão dela para continuar.`;
  }
  if (tem('AGENDA_RECUSADA')) return 'Qual agenda você quer conectar agora?';
  return null;
}
