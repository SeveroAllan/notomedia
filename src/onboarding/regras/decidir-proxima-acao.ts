import { PERGUNTA_INICIO_NOTAS } from '../falas.js';
import { z } from 'zod';
import { CONFIANCA_MINIMA_COMPROVANTE } from '../../atendimento/comprovante.js';

interface HistoricoPergunta {
  feitaEm: string | null;
  repeticoes: number;
}
interface UltimaNotaConhecida {
  paciente?: string | null;
  dataEmissao: string;
  valorCentavos: number;
  diasDesdeEmissao: number;
}
export type EstadoConversaRetroativo = 'aguardando_data_inicio' | 'aguardando_confirmacao_lote' | 'confirmado' | 'processando' | 'simulado' | 'concluido' | 'recusado';
export interface EstadoMedicoAposOnboarding {
  agora?: Date;
  intervaloReperguntaDias?: number;
  fiscal: { certificado: 'ok' | 'problema'; dadosFiscais: 'ok' | 'problema' };
  agenda: { nome: string | null; conectada: boolean };
  ultimaNota: UltimaNotaConhecida | null;
  historico: {
    /** Refere-se à ocorrência fiscal atual, não a problemas anteriores já resolvidos. */
    problemaFiscalComunicado: boolean;
    problemaFiscal?: HistoricoPergunta;
    boasVindasComunicadas: boolean;
    perguntaNota: HistoricoPergunta & { resposta: { temNota: boolean; desde: string | null } | null };
    perguntaAgenda: HistoricoPergunta;
    agendasNaoAtendidasComunicadas: string[];
    consultasListadas: boolean;
    aguardandoComprovanteComunicado: boolean;
  };
}
export type ProximaAcaoNoto =
  | { tipo: 'problema_fiscal'; campos: Array<'certificado' | 'dados_fiscais'> }
  | { tipo: 'boas_vindas'; ultimaNota: UltimaNotaConhecida | null }
  | { tipo: 'perguntar_nota_pendente' }
  | { tipo: 'pedir_agenda'; agendaInformada: string | null }
  | { tipo: 'agenda_nao_atendida'; agenda: string; registrarInteresse: true }
  | { tipo: 'listar_consultas_sem_nota'; agenda: 'tribemd'; desde: string | null }
  | { tipo: 'aguardar_comprovante' }
  | { tipo: 'reperguntar'; pergunta: 'nota_pendente' | 'agenda' | 'problema_fiscal' }
  | { tipo: 'nenhuma' };

/** Histórico precisa refletir comunicações confirmadas; decidir não grava nem marca envio. */
export function decidirProximaAcao(
  estado: EstadoMedicoAposOnboarding,
  agora = estado.agora,
  intervaloReperguntaDias = estado.intervaloReperguntaDias
): ProximaAcaoNoto {
  const historico = estado.historico;
  const campos: Array<'certificado' | 'dados_fiscais'> = [];
  if (estado.fiscal.certificado === 'problema') campos.push('certificado');
  if (estado.fiscal.dadosFiscais === 'problema') campos.push('dados_fiscais');
  if (campos.length && !historico.problemaFiscalComunicado) return { tipo: 'problema_fiscal', campos };
  if (campos.length) return historico.problemaFiscal
    ? decidirRepergunta(historico.problemaFiscal, 'problema_fiscal', agora, intervaloReperguntaDias) : { tipo: 'nenhuma' };
  if (!historico.boasVindasComunicadas) return { tipo: 'boas_vindas', ultimaNota: estado.ultimaNota ? { ...estado.ultimaNota } : null };
  if (!historico.perguntaNota.feitaEm) return { tipo: 'perguntar_nota_pendente' };

  const resposta = historico.perguntaNota.resposta;
  const agenda = estado.agenda.nome?.trim() || null;
  const agendaAtendida = agenda?.toLowerCase() === 'tribemd';
  if (resposta?.temNota && !estado.agenda.conectada && !historico.perguntaAgenda.feitaEm && (!agenda || agendaAtendida)) {
    return { tipo: 'pedir_agenda', agendaInformada: agenda };
  }
  if (agenda && !agendaAtendida && !historico.agendasNaoAtendidasComunicadas.some(nome => nome.trim().toLowerCase() === agenda.toLowerCase())) {
    return { tipo: 'agenda_nao_atendida', agenda, registrarInteresse: true };
  }
  if (resposta?.temNota && estado.agenda.conectada && agendaAtendida && !historico.consultasListadas) {
    return { tipo: 'listar_consultas_sem_nota', agenda: 'tribemd', desde: resposta.desde };
  }
  if (resposta?.temNota === false && !historico.aguardandoComprovanteComunicado) return { tipo: 'aguardar_comprovante' };
  if (!resposta) return decidirRepergunta(historico.perguntaNota, 'nota_pendente', agora, intervaloReperguntaDias);
  if (resposta.temNota && !estado.agenda.conectada && !agenda) {
    return decidirRepergunta(historico.perguntaAgenda, 'agenda', agora, intervaloReperguntaDias);
  }
  return { tipo: 'nenhuma' };
}

function decidirRepergunta(
  historico: HistoricoPergunta,
  pergunta: 'nota_pendente' | 'agenda' | 'problema_fiscal',
  agora: Date | undefined,
  intervaloDias: number | undefined
): ProximaAcaoNoto {
  if (!agora || intervaloDias === undefined) return { tipo: 'nenhuma' };
  const intervaloMs = intervaloDias * 24 * 60 * 60 * 1000;
  if (historico.feitaEm && historico.repeticoes === 0 && Number.isFinite(intervaloMs) && intervaloMs > 0 &&
      agora.getTime() - Date.parse(historico.feitaEm) >= intervaloMs) return { tipo: 'reperguntar', pergunta };
  return { tipo: 'nenhuma' };
}

export function montarBoasVindas(
  nomeMedico: string,
  ultimaNota: UltimaNotaConhecida | null
): [string, string, string, string] | [string, string, string, string, string] {
  const primeiroNome = nomeMedico.trim().split(/\s+/)[0].toLocaleLowerCase('pt-BR').slice(0, 400);
  const nomeSaudacao = primeiroNome.charAt(0).toLocaleUpperCase('pt-BR') + primeiroNome.slice(1);
  const baloes: [string, string, string] = [
    `Olá, Dr(a). ${nomeSaudacao}! Sou o Noto, seu assistente de notas fiscais.`,
    'Toda vez que um paciente seu mandar um comprovante, eu confiro a consulta na sua agenda e emito a nota. A nota vai direto para a conversa do paciente, pelo seu próprio WhatsApp.',
    'Se você pedir, também entrego uma nota nova ou antiga por aqui.'
  ];
  if (!ultimaNota?.paciente) return [...baloes, PERGUNTA_INICIO_NOTAS];
  const dias = ultimaNota.diasDesdeEmissao;
  const quando = dias === 0 ? 'hoje' : dias === 1 ? 'ontem' : `há ${dias} dias`;
  const valor = (ultimaNota.valorCentavos / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
  const resumo = `Vi que sua última nota foi para ${ultimaNota.paciente}, de R$ ${valor}, emitida ${quando}.`;
  const pergunta = PERGUNTA_INICIO_NOTAS;
  return [...baloes, resumo.slice(0, 500), pergunta];
}

/** Reconhece somente respostas inequívocas; a data civil vem do chamador. */
export function interpretarRespostaNota(texto: string, dataMensagem: string): { temNota: boolean; desde: string | null } | null {
  const resposta = texto.trim().toLocaleLowerCase('pt-BR');
  if (resposta === 'não') return { temNota: false, desde: null };
  const diaMensagem = new Date(dataMensagem + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataMensagem) || !Number.isFinite(diaMensagem.getTime()) || diaMensagem.toISOString().slice(0, 10) !== dataMensagem) return null;
  if (resposta === 'sim, desde hoje') return { temNota: true, desde: dataMensagem };
  if (resposta === 'sim, desde ontem') {
    diaMensagem.setUTCDate(diaMensagem.getUTCDate() - 1);
    return { temNota: true, desde: diaMensagem.toISOString().slice(0, 10) };
  }
  const dia = /^sim, desde dia (\d{1,2})$/.exec(resposta);
  if (!dia) return null;
  const mes = new Date(dataMensagem + 'T00:00:00Z');
  if (Number(dia[1]) > mes.getUTCDate()) mes.setUTCMonth(mes.getUTCMonth() - 1, 1);
  const desde = mes.toISOString().slice(0, 8) + dia[1].padStart(2, '0');
  const data = new Date(desde + 'T00:00:00Z');
  if (!Number.isFinite(data.getTime()) || data.toISOString().slice(0, 10) !== desde || desde > dataMensagem) return null;
  return { temNota: true, desde };
}

export function montarPerguntaComunicacao(acao: ProximaAcaoNoto): string | null {
  if (acao.tipo === 'perguntar_nota_pendente' || acao.tipo === 'reperguntar' && acao.pergunta === 'nota_pendente') {
    return PERGUNTA_INICIO_NOTAS;
  }
  if (acao.tipo === 'pedir_agenda' || acao.tipo === 'reperguntar' && acao.pergunta === 'agenda') {
    return 'Para eu achar suas consultas, preciso da sua agenda. Posso te mandar o link?';
  }
  return null;
}

export const respostaNotaExtraidaSchema = z.object({
  temNota: z.enum(['sim', 'não', 'incerto', 'fora_do_assunto']), desde: z.string().nullable(), confianca: z.number().finite().min(0).max(1)
}).strict();
export type RespostaNotaExtraida = z.infer<typeof respostaNotaExtraidaSchema>;
// Limite técnico do contexto, sem alterar regras de decisão ou intervalos.
export const LIMITE_MENSAGENS_CONTEXTO_MEDICO = 4;
export const contextoRespostaMedicoSchema = z.object({
  acaoPendente: z.enum(['perguntar_nota_pendente', 'pedir_agenda']),
  pergunta: z.string(), mensagens: z.array(z.string()).max(LIMITE_MENSAGENS_CONTEXTO_MEDICO)
}).strict();
export type ContextoRespostaMedico = z.infer<typeof contextoRespostaMedicoSchema>;
export interface ExtratorRespostaMedico {
  extrair(texto: string, dataMensagem: string, contexto: ContextoRespostaMedico): Promise<RespostaNotaExtraida>;
}

/** A IA extrai; confiança, calendário e ausência de resposta são validados em código. */
export function validarRespostaNotaExtraida(extraido: unknown, texto: string, dataMensagem: string | null): { temNota: boolean; desde: string | null } | null {
  const resultado = respostaNotaExtraidaSchema.safeParse(extraido);
  if (!resultado.success || !dataMensagem || !interpretarRespostaNota('sim, desde hoje', dataMensagem)) return null;
  const campos = resultado.data;
  if (campos.confianca < CONFIANCA_MINIMA_COMPROVANTE || campos.temNota === 'incerto' || campos.temNota === 'fora_do_assunto') return null;
  if (campos.temNota === 'não') return campos.desde === null ? { temNota: false, desde: null } : null;
  const relativa = /\bdesde\s+(hoje|ontem|dia\s+\d+)\s*[.!?]?\s*$/i.exec(texto);
  if (relativa) return interpretarRespostaNota('sim, desde ' + relativa[1].toLocaleLowerCase('pt-BR').replace(/\s+/g, ' '), dataMensagem);
  if (campos.desde === null) return { temNota: true, desde: null };
  const data = new Date(campos.desde + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(campos.desde) || !Number.isFinite(data.getTime()) || data.toISOString().slice(0, 10) !== campos.desde || campos.desde > dataMensagem) return null;
  return { temNota: true, desde: campos.desde };
}
