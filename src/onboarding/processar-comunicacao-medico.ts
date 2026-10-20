import { RASCUNHO_FALLBACK_CONVERSA } from './conversador-medico.js';
import { sanitizarTextoMedico } from './contexto-conversa-medico.js';
import { montarPerguntaComunicacao } from './regras/decidir-proxima-acao.js';
import { orquestrarComunicacao } from './orquestrar-comunicacao.js';
import type { HistoricoComunicacaoRepositorio } from './historico-comunicacao-repositorio.js';
import type { ProximaAcaoNoto, ExtratorRespostaMedico } from './regras/decidir-proxima-acao.js';

import type { ConversadorMedico } from './conversador-medico.js';
import type { PostgresMemoriaConversaMedico, MemoriaConversa } from './conversa-repositorio.js';

type Entrada = Parameters<typeof orquestrarComunicacao>[0];
export type EstadoComunicacaoMedico = Pick<Entrada, 'nomeMedico' | 'estado'>;

// Serializa os gatilhos locais para que uma resposta não seja descartada por reserva ocupada.
const processamentos = new Map<string, Promise<ProximaAcaoNoto>>();

/** Ações fiscais seguem determinísticas; a IA só solicita as duas ferramentas restritas de agenda. */
export async function processarComunicacaoMedico(
  entrada: Pick<Entrada, 'medicoId' | 'chaveProcessamento' | 'respostaMedico'> & { agora: Date; chaveConversa?: string },
  deps: { ativo: boolean; conversaLivreAtiva?: boolean; memoriaPersistida?: PostgresMemoriaConversaMedico;
    conversador?: Pick<ConversadorMedico, 'responder' | 'resumir'>;
    aoConversar?: (fala: string[], chave: string) => Promise<void>;
    memoriaConversa?: MemoriaConversa; extratorResposta?: ExtratorRespostaMedico; historico: HistoricoComunicacaoRepositorio;
    lerEstado: (medicoId: string, agora: Date) => Promise<EstadoComunicacaoMedico | null>;
    listarConsultasSemNota?: (medicoId: string, agenda: EstadoComunicacaoMedico['estado']['agenda'], agora: Date) => Promise<{
      ok: boolean; motivo?: string; total?: number; consultas?: unknown[]; janelaDias?: number }>;
    enviarLinkCofreAgenda?: (medicoId: string) => Promise<{ ok: boolean; motivo: string }>;
    tratarCofre?: (medicoId: string, texto: string) => Promise<boolean>;
    aoDecidir?: (acao: ProximaAcaoNoto, chave: string, contexto?: { nomeMedico?: string }) => Promise<void>;
    log: (nivel: 'info' | 'erro', mensagem: string) => void }
): Promise<ProximaAcaoNoto> {
  if (!deps.ativo) return { tipo: 'nenhuma' };
  const fallback = async (motivo: string, erro?: unknown, verificarDuplicata = true) => {
    if (!deps.conversaLivreAtiva || !entrada.respostaMedico) return;
    const detalhe = erro instanceof Error ? erro.message : erro === undefined ? '' : String(erro);
    deps.log('erro', `${motivo}${detalhe ? ': ' + sanitizarTextoMedico(detalhe).slice(0, 500) : ''}`);
    if (entrada.chaveConversa && deps.memoriaPersistida) {
      try { if (verificarDuplicata && await deps.memoriaPersistida.temResposta(entrada.medicoId, entrada.chaveConversa, entrada.chaveProcessamento)) return; }
      catch { /* A indisponibilidade da memória não impede a tentativa de resposta. */ }
      for (const [id, texto, papel] of [[`medico:${entrada.chaveProcessamento}`, sanitizarTextoMedico(entrada.respostaMedico.texto), 'medico'],
        [`noto:${entrada.chaveProcessamento}`, RASCUNHO_FALLBACK_CONVERSA, 'noto']] as const) {
        try { await deps.memoriaPersistida.registrar(entrada.medicoId, entrada.chaveConversa, id, texto, papel); }
        catch (e) { deps.log('erro', `COMUNICACAO_MEMORIA_FALHOU: ${sanitizarTextoMedico(e instanceof Error ? e.message : String(e)).slice(0, 500)}`); }
      }
    }
    try { await deps.aoConversar?.([RASCUNHO_FALLBACK_CONVERSA], entrada.chaveProcessamento); }
    catch (e) { deps.log('erro', `COMUNICACAO_FALLBACK_FALHOU: ${sanitizarTextoMedico(e instanceof Error ? e.message : String(e)).slice(0, 500)}`); }
  };
  const anterior = processamentos.get(entrada.medicoId);
  const processamento = (anterior ? anterior.catch(() => {}) : Promise.resolve()).then(async (): Promise<ProximaAcaoNoto> => {
    try {
      if (deps.conversaLivreAtiva && deps.enviarLinkCofreAgenda && entrada.respostaMedico) {
        // Consome o evento antes de qualquer efeito do cofre, inclusive entre réplicas.
        const chave = `conversa:agenda:${entrada.chaveProcessamento}`;
        if (!await deps.historico.reservar(entrada.medicoId, 'simulado', chave)) return { tipo: 'nenhuma' };
        await deps.historico.liberar(entrada.medicoId, 'simulado', chave);
      }
      const pedidoCofreRegistrado = !!(deps.conversaLivreAtiva && entrada.chaveConversa &&
        await deps.memoriaPersistida?.temPedidoCofre(entrada.medicoId, entrada.chaveConversa));
      if (pedidoCofreRegistrado && entrada.respostaMedico) {
        const estadoCofre = await deps.lerEstado(entrada.medicoId, entrada.agora);
        if (!estadoCofre) { await fallback('COMUNICACAO_ESTADO_AUSENTE'); return { tipo: 'nenhuma' }; }
        if (!estadoCofre.estado.agenda.conectada) {
          // Nem credenciais sem rótulo seguem para memória/IA enquanto aguarda conexão.
          await deps.aoConversar?.(['O link já foi solicitado. Aguardo a conexão da agenda.'], entrada.chaveProcessamento);
          return { tipo: 'nenhuma' };
        }
      }
      if (!pedidoCofreRegistrado && entrada.respostaMedico && await deps.tratarCofre?.(entrada.medicoId, entrada.respostaMedico.texto)) {
        if (deps.conversaLivreAtiva && entrada.chaveConversa && deps.memoriaPersistida) await deps.memoriaPersistida.registrar(
          entrada.medicoId, entrada.chaveConversa, 'noto:cofre_agenda:solicitado', 'Link do cofre solicitado; aguardo a conexão. Isso não confirma envio.', 'noto');
        return { tipo: 'nenhuma' };
      }
      if (entrada.respostaMedico && /\b(senha|password|token|secret|segredo|api[_ -]?key)\b/i.test(entrada.respostaMedico.texto)) { await fallback('COMUNICACAO_ENTRADA_PROTEGIDA'); return { tipo: 'nenhuma' }; }
      const estado = await deps.lerEstado(entrada.medicoId, entrada.agora);
      if (!estado) { await fallback('COMUNICACAO_ESTADO_AUSENTE'); return { tipo: 'nenhuma' }; }
      const memoriaConversa = deps.conversaLivreAtiva === true ? deps.memoriaPersistida : deps.memoriaConversa;
      const conversa = entrada.chaveConversa;
      const respostaMedico = entrada.respostaMedico ? { ...entrada.respostaMedico,
        texto: sanitizarTextoMedico(entrada.respostaMedico.texto),
        mensagensSeguras: memoriaConversa && conversa ? await memoriaConversa.ler(entrada.medicoId, conversa) : entrada.respostaMedico.mensagensSeguras
      } : undefined;
      let semDecisao = false;
      const acao = await orquestrarComunicacao({ ...entrada, ...estado, respostaMedico }, {
        historico: deps.historico, log: deps.log, extratorResposta: deps.extratorResposta,
        aoSemDecisao: deps.conversaLivreAtiva === true ? () => { semDecisao = true; } : undefined
      });
      const agendaViaConversa = deps.conversaLivreAtiva === true && respostaMedico && deps.listarConsultasSemNota && deps.enviarLinkCofreAgenda &&
        (acao.tipo === 'listar_consultas_sem_nota' || acao.tipo === 'pedir_agenda' || acao.tipo === 'reperguntar' && acao.pergunta !== 'problema_fiscal');
      if (!agendaViaConversa) await deps.aoDecidir?.(acao, entrada.chaveProcessamento, { nomeMedico: estado.nomeMedico });
      if (deps.conversaLivreAtiva === true && acao.tipo === 'nenhuma' && !semDecisao) { await fallback('COMUNICACAO_SEM_DECISAO_SEGURA'); return acao; }
      let fala: string[] | undefined;
      const responderBoasVindas = deps.conversaLivreAtiva === true && respostaMedico && conversa &&
        acao.tipo === 'perguntar_nota_pendente' && await deps.memoriaPersistida?.temBoasVindas(entrada.medicoId, conversa);
      if (deps.conversaLivreAtiva === true && respostaMedico && (acao.tipo === 'nenhuma' || responderBoasVindas || agendaViaConversa) && deps.conversador) {
        const resumo = conversa ? await deps.memoriaPersistida?.lerResumo(entrada.medicoId, conversa) : null;
        let linkCofreJaSolicitado = !!(conversa && await deps.memoriaPersistida?.temPedidoCofre(entrada.medicoId, conversa));
        const contexto = { linkCofreJaSolicitado, texto: respostaMedico.texto, mensagens: respostaMedico.mensagensSeguras ?? [],
          resumo: resumo?.resumo ?? null, estado: estado.estado, agora: entrada.agora };
        let resposta = await deps.conversador.responder({ ...contexto, acoesPermitidas: deps.listarConsultasSemNota && deps.enviarLinkCofreAgenda
          ? linkCofreJaSolicitado ? ['listar_consultas_sem_notas'] : ['listar_consultas_sem_notas', 'enviar_link_cofre_agenda'] : [] });
        if (resposta.acao === 'listar_consultas_sem_notas' && deps.listarConsultasSemNota) {
          let resultado;
          try { resultado = await deps.listarConsultasSemNota(entrada.medicoId, estado.estado.agenda, entrada.agora); }
          catch { resultado = { ok: false, motivo: 'AGENDA_INDISPONIVEL' }; }
          const conectar = !resultado.ok && ['SEM_AGENDA_CONECTADA', 'AGENDA_NAO_SUPORTADA', 'SEM_CONSULTAS_SINCRONIZADAS'].includes(resultado.motivo ?? '');
          resposta = await deps.conversador.responder({ ...contexto,
            resultadoFerramenta: { ferramenta: 'listar_consultas_sem_notas', dadosNaoConfiaveis: resultado },
            acoesPermitidas: conectar && !linkCofreJaSolicitado && deps.enviarLinkCofreAgenda ? ['enviar_link_cofre_agenda'] : [] });
        }
        if (resposta.acao === 'enviar_link_cofre_agenda' && !linkCofreJaSolicitado && deps.enviarLinkCofreAgenda) {
          if (conversa && deps.memoriaPersistida) await deps.memoriaPersistida.registrar(entrada.medicoId, conversa,
            'noto:cofre_agenda:solicitado', 'O link do cofre já foi solicitado nesta conversa; aguardo a conexão. Isso não confirma envio.', 'noto');
          let resultado;
          try { resultado = await deps.enviarLinkCofreAgenda(entrada.medicoId); }
          catch { resultado = { ok: false, motivo: 'COFRE_INDISPONIVEL' }; }
          resposta = await deps.conversador.responder({ ...contexto,
            resultadoFerramenta: { ferramenta: 'enviar_link_cofre_agenda', dadosNaoConfiaveis: resultado }, acoesPermitidas: [] });
        }
        fala = resposta.fala;
      }
      if (!fala && deps.conversaLivreAtiva && respostaMedico && !(acao.tipo === 'boas_vindas' && estado.nomeMedico)) {
        deps.log('erro', 'COMUNICACAO_SEM_FALA'); fala = [RASCUNHO_FALLBACK_CONVERSA];
      }
      if (memoriaConversa && conversa) {
        if (respostaMedico) await memoriaConversa.registrar(entrada.medicoId, conversa, `medico:${entrada.chaveProcessamento}`, respostaMedico.texto);
        const pergunta = fala ? fala.join('\n') : montarPerguntaComunicacao(acao);
        if (pergunta) await memoriaConversa.registrar(entrada.medicoId, conversa, `noto:${entrada.chaveProcessamento}`, pergunta, 'noto');
      }
      if (fala) await deps.aoConversar?.(fala, entrada.chaveProcessamento);
      if (deps.conversaLivreAtiva === true && respostaMedico && conversa && deps.memoriaPersistida && deps.conversador) {
        await atualizarResumo(deps.memoriaPersistida, deps.conversador, entrada.medicoId, conversa);
      }
      return acao;
    } catch (erro) {
      if (deps.conversaLivreAtiva && entrada.respostaMedico) await fallback('COMUNICACAO_ESTADO_FALHOU', erro, false);
      else deps.log('erro', 'COMUNICACAO_ESTADO_FALHOU');
      return { tipo: 'nenhuma' };
    }
  });
  processamentos.set(entrada.medicoId, processamento);
  try { return await processamento; }
  finally { if (processamentos.get(entrada.medicoId) === processamento) processamentos.delete(entrada.medicoId); }
}

async function atualizarResumo(memoria: PostgresMemoriaConversaMedico, conversador: Pick<ConversadorMedico, 'resumir'>, medicoId: string, conversa: string): Promise<void> {
  try {
    const anterior = await memoria.lerResumo(medicoId, conversa);
    const antigas = await memoria.lerAntigas(medicoId, conversa, anterior?.ateId ?? '0');
    if (antigas.length <= 20) return;
    const resumo = await conversador.resumir({ resumo: anterior?.resumo ?? null, mensagens: antigas.map(mensagem => mensagem.texto) });
    if (resumo !== null) await memoria.gravarResumo(medicoId, conversa, resumo, antigas.at(-1)!.id);
  } catch { /* Resumo é auxiliar: sua indisponibilidade não interrompe a conversa. */ }
}
