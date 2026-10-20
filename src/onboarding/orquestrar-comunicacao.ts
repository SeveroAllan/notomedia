import { CONFIANCA_MINIMA_COMPROVANTE } from '../atendimento/comprovante.js';
import { decidirProximaAcao, montarBoasVindas, validarRespostaNotaExtraida, montarPerguntaComunicacao, respostaNotaExtraidaSchema, LIMITE_MENSAGENS_CONTEXTO_MEDICO, type ContextoRespostaMedico, type ExtratorRespostaMedico, type EstadoMedicoAposOnboarding, type ProximaAcaoNoto } from './regras/decidir-proxima-acao.js';
import type { HistoricoComunicacaoRepositorio } from './historico-comunicacao-repositorio.js';
import type { EnviarMensagemPaciente } from '../whatsapp/enviar-mensagem-paciente.js';

interface EntradaComunicacao {
  medicoId: string;
  chaveProcessamento: string;
  nomeMedico?: string;
  respostaMedico?: { texto: string; dataMensagem: string | null; mensagensSeguras?: readonly string[] };
  instanciaNome?: string;
  contatoTelefone?: string;
  estado: Omit<EstadoMedicoAposOnboarding, 'historico'> & { agora: Date };
}
interface DependenciasComunicacao {
  historico: HistoricoComunicacaoRepositorio;
  log: (nivel: 'info' | 'erro', mensagem: string) => void;
  envioRealAtivo?: boolean;
  transporte?: EnviarMensagemPaciente;
  extratorResposta?: ExtratorRespostaMedico;
  aoSemDecisao?: () => void;
}

export async function orquestrarComunicacao(
  entrada: EntradaComunicacao,
  dependencias: DependenciasComunicacao
): Promise<ProximaAcaoNoto> {
  const { historico, log, envioRealAtivo = false } = dependencias;
  const modo = envioRealAtivo ? 'real' : 'simulado';
  const { medicoId, chaveProcessamento, estado } = entrada;
  let reservado = false;
  let semDecisao = false;
  try {
    reservado = await historico.reservar(medicoId, modo, chaveProcessamento);
    if (!reservado) return { tipo: 'nenhuma' };
    let salvo = await historico.ler(medicoId, modo);
    let falhaExtracao = false;
    let acao = decidirProximaAcao({ ...estado, historico: salvo });
    const fiscalOk = estado.fiscal.certificado === 'ok' && estado.fiscal.dadosFiscais === 'ok';
    if (fiscalOk && entrada.respostaMedico && salvo.perguntaNota.feitaEm && !salvo.perguntaNota.resposta) {
      const { texto, dataMensagem } = entrada.respostaMedico;
      const ultimaPergunta = salvo.registros.filter(registro => registro.tipo === 'perguntar_nota_pendente' || registro.tipo === 'pedir_agenda' ||
        registro.tipo === 'reperguntar' && (registro.pergunta === 'nota_pendente' || registro.pergunta === 'agenda')).at(-1);
      const pedirAgenda = ultimaPergunta?.tipo === 'pedir_agenda' || ultimaPergunta?.pergunta === 'agenda';
      const contexto: ContextoRespostaMedico = {
        acaoPendente: pedirAgenda ? 'pedir_agenda' : 'perguntar_nota_pendente',
        pergunta: montarPerguntaComunicacao(pedirAgenda ? { tipo: 'pedir_agenda', agendaInformada: null } : { tipo: 'perguntar_nota_pendente' })!,
        mensagens: entrada.respostaMedico.mensagensSeguras?.slice(-LIMITE_MENSAGENS_CONTEXTO_MEDICO) ?? []
      };
      let extraido: unknown = null;
      if (dataMensagem && dependencias.extratorResposta) {
        try { extraido = await dependencias.extratorResposta.extrair(texto, dataMensagem, contexto); }
        catch { falhaExtracao = true; /* Erro do provedor fica incerto; nunca registrar seu corpo ou o texto do médico. */ }
      }
      const campos = respostaNotaExtraidaSchema.safeParse(extraido);
      if (contexto.acaoPendente !== 'perguntar_nota_pendente' || campos.success && campos.data.temNota === 'fora_do_assunto' && campos.data.confianca >= CONFIANCA_MINIMA_COMPROVANTE) {
        semDecisao = !falhaExtracao;
        return { tipo: 'nenhuma' };
      }
      const resposta = validarRespostaNotaExtraida(extraido, texto, dataMensagem);
      if (resposta) {
        await historico.gravarResposta(medicoId, modo, resposta, estado.agora.toISOString());
        salvo = await historico.ler(medicoId, modo);
        acao = decidirProximaAcao({ ...estado, historico: salvo });
      } else acao = salvo.perguntaNota.repeticoes === 0 ? { tipo: 'reperguntar', pergunta: 'nota_pendente' } : { tipo: 'nenhuma' };
    }
    if (acao.tipo === 'nenhuma') {
      semDecisao = !falhaExtracao;
      return acao;
    }
    if (envioRealAtivo) return await enviarAcao(entrada, dependencias, acao);
    await historico.gravarAcao(medicoId, 'simulado', chaveProcessamento, acao, estado.agora.toISOString());
    const texto = montarPerguntaComunicacao(acao);
    log('info', `enviaria ${acao.tipo}${texto ? ': ' + texto : ''}`);
    return acao;
  } catch {
    log('erro', 'HISTORICO_COMUNICACAO_FALHOU');
    return { tipo: 'nenhuma' };
  } finally {
    if (reservado) await historico.liberar(medicoId, modo, chaveProcessamento)
      .catch(() => { semDecisao = false; log('erro', 'HISTORICO_LIBERACAO_FALHOU'); });
    if (semDecisao) dependencias.aoSemDecisao?.();
  }
}

async function enviarAcao(
  entrada: EntradaComunicacao, dependencias: DependenciasComunicacao, acao: ProximaAcaoNoto
): Promise<ProximaAcaoNoto> {
  const { historico, log } = dependencias;
  if (acao.tipo !== 'boas_vindas') {
    log('erro', 'COMUNICACAO_SEM_TEXTO_APROVADO');
    return acao;
  }
  const { medicoId, chaveProcessamento, nomeMedico, instanciaNome, contatoTelefone, estado } = entrada;
  const transporte = dependencias.transporte;
  if (!nomeMedico || !instanciaNome || !contatoTelefone || !transporte) {
    log('erro', 'COMUNICACAO_ENVIO_NAO_CONFIGURADO');
    return { tipo: 'nenhuma' };
  }
  if (!await historico.reservarEnvio(medicoId, chaveProcessamento, acao)) return { tipo: 'nenhuma' };
  const baloes = montarBoasVindas(nomeMedico, acao.ultimaNota);
  for (const [indice, texto] of baloes.entries()) {
    let confirmado = false;
    try { confirmado = (await transporte.enviarTexto({ instanciaNome, contatoTelefone, texto })).sucesso; }
    catch { /* O resultado incerto permanece reservado para impedir reenvio. */ }
    if (!confirmado) {
      log('erro', 'COMUNICACAO_TRANSPORTE_FALHOU');
      return { tipo: 'nenhuma' };
    }
    await historico.confirmarBalao(medicoId, chaveProcessamento, indice);
  }
  await historico.gravarAcao(medicoId, 'real', chaveProcessamento, acao, estado.agora.toISOString());
  return acao;
}
