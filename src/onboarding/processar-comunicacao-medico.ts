import { RASCUNHO_FALLBACK_CONVERSA, FALA_PROTECAO_CREDENCIAL_AGENDA } from './falas.js';
import { formatarPendencias } from './pendencias-medico.js';
import { contemCredencialAgenda, podeSolicitarLinkAgenda, type ContextoConexaoAgenda } from '../cofre/links.js';
import { mensagemInstabilidade, registroErroNoto } from '../observabilidade/erros.js';
import { sanitizarTextoMedico } from './contexto-conversa-medico.js';
import { montarPerguntaComunicacao } from './regras/decidir-proxima-acao.js';
import { orquestrarComunicacao } from './orquestrar-comunicacao.js';
import type { HistoricoComunicacaoRepositorio } from './historico-comunicacao-repositorio.js';
import type { ProximaAcaoNoto, ExtratorRespostaMedico } from './regras/decidir-proxima-acao.js';

import type { ConversadorMedico } from './conversador-medico.js';
import type { PostgresMemoriaConversaMedico, MemoriaConversa } from './memoria-conversa.js';

type Entrada = Parameters<typeof orquestrarComunicacao>[0];
export type EstadoComunicacaoMedico = Pick<Entrada, 'nomeMedico' | 'estado'>;

// Serializa os gatilhos locais para que uma resposta não seja descartada por reserva ocupada.
const processamentos = new Map<string, Promise<ProximaAcaoNoto>>();

/** Ações fiscais seguem determinísticas; a IA só solicita as duas ferramentas restritas de agenda. */
export async function processarComunicacaoMedico(
  entrada: Pick<Entrada, 'medicoId' | 'chaveProcessamento' | 'respostaMedico'> & { agora: Date; chaveConversa?: string; chavePergunta?: string; eventoAgenda?: { agenda: 'tribemd'; conectado: boolean; falhaAcesso?: boolean } },
  deps: { ativo: boolean; conversaLivreAtiva?: boolean; memoriaPersistida?: PostgresMemoriaConversaMedico;
    conversador?: Pick<ConversadorMedico, 'responder' | 'resumir' | 'prepararIntroducaoLink'>;
    pendencias?: Pick<import('./pendencias-medico.js').PendenciasMedico, 'responder' | 'iniciar' | 'aposSyncIncompleta'>;
    lerInicioPendencias?: (medicoId: string) => Promise<string | null>;
    aguardaInicioRetroativo?: (medicoId: string) => Promise<boolean>;
    prepararPendencias?: (medicoId: string, agora: Date) => Promise<{ ok: boolean; motivo?: string }>;
    retroativo?: Pick<import('./lote-retroativo.js').ConversaLoteRetroativo, 'iniciar' | 'responder'>;
    aoReagir?: (reacao: import('../whatsapp/reagir-mensagem.js').ReacaoMedico) => Promise<void>;
    aoConversar?: (fala: string[], chave: string, falaMemoria?: string[]) => Promise<void>;
    memoriaConversa?: MemoriaConversa; extratorResposta?: ExtratorRespostaMedico; historico: HistoricoComunicacaoRepositorio;
    lerEstado: (medicoId: string, agora: Date) => Promise<EstadoComunicacaoMedico | null>;
    listarConsultasSemNota?: (medicoId: string, agenda: EstadoComunicacaoMedico['estado']['agenda'], agora: Date) => Promise<{
      ok: boolean; motivo?: string; total?: number; consultas?: unknown[]; dataInicio?: string; janelaDias?: number }>;
    enviarLinkCofreAgenda?: (medicoId: string, opcoes?: { reenvio?: boolean; introducao?: readonly string[] }) => Promise<{ ok: boolean; motivo: string }>;
    lerContextoConexao?: (medicoId: string, agora: Date) => Promise<ContextoConexaoAgenda>;
    tratarCofre?: (medicoId: string, texto: string) => Promise<boolean>;
    aoDecidir?: (acao: ProximaAcaoNoto, chave: string, contexto?: { nomeMedico?: string }) => Promise<void>;
    log: (nivel: 'info' | 'erro', mensagem: string) => void }
): Promise<ProximaAcaoNoto> {
  if (!deps.ativo) return { tipo: 'nenhuma' };
  const nomesAoVivo = new Set<string>();
  const auditarFerramenta = (ferramenta: string, resultado: { ok: boolean; motivo?: string; total?: number; consultas?: unknown[]; dataInicio?: string; janelaDias?: number }) => {
    if (ferramenta === 'listar_consultas_sem_notas') for (const consulta of resultado.consultas ?? []) {
      const nome = (consulta as { paciente?: unknown })?.paciente;
      if (typeof nome === 'string' && !nome.startsWith('Contato ')) nomesAoVivo.add(nome);
    }
    deps.log('info', 'FERRAMENTA_AGENDA_RESULTADO ' + JSON.stringify({ medicoId: entrada.medicoId, ferramenta,
      ok: resultado.ok, motivo: /^[A-Z0-9_]{1,80}$/.test(resultado.motivo ?? '') ? resultado.motivo : undefined,
      total: resultado.total, retornadas: resultado.consultas?.length, janelaDias: resultado.janelaDias }));
  };
  const lerInstabilidades = async () => {
    try { return entrada.chaveConversa ? await deps.memoriaPersistida?.lerFalasRecentes?.(entrada.medicoId, entrada.chaveConversa) ?? [] : []; }
    catch { return []; }
  };
  const enviarFala = async (fala: string[], chave: string) => {
    // O transporte real reserva a linha antes de enviar; o registro posterior é um no-op nesse caminho.
    const falaMemoria = fala.map(texto => [...nomesAoVivo].reduce((seguro, nome) => seguro.split(nome).join('[PACIENTE]'), texto));
    if (falaMemoria.some((texto, i) => texto !== fala[i])) await deps.aoConversar?.(fala, chave, falaMemoria);
    else await deps.aoConversar?.(fala, chave);
    if (entrada.chaveConversa && deps.memoriaPersistida) await deps.memoriaPersistida.registrarFala(
      entrada.medicoId, entrada.chaveConversa, `noto:${chave}`, falaMemoria.join('\n'), 'noto');
  };
  const fallback = async (motivo: string, erro?: unknown, verificarDuplicata = true) => {
    if (!deps.conversaLivreAtiva || !entrada.respostaMedico && !entrada.eventoAgenda) return;
    const detalhe = erro instanceof Error ? erro.message : erro === undefined ? '' : String(erro);
    deps.log('erro', registroErroNoto(motivo, 'tecnico', { etapa: 'comunicacao', detalhe }));
    if (entrada.chaveConversa && deps.memoriaPersistida) {
      try { if (verificarDuplicata && await deps.memoriaPersistida.temResposta(entrada.medicoId, entrada.chaveConversa, entrada.chaveProcessamento)) return; }
      catch { /* A indisponibilidade da memória não impede a tentativa de resposta. */ }
      for (const [id, texto, papel] of [[`medico:${entrada.chaveProcessamento}`, sanitizarTextoMedico(entrada.respostaMedico?.texto ?? ''), 'medico']] as const) {
        if (!entrada.respostaMedico) continue;
        try { await deps.memoriaPersistida.registrarFala(entrada.medicoId, entrada.chaveConversa, id, texto, papel); }
        catch (e) { deps.log('erro', `COMUNICACAO_MEMORIA_FALHOU: ${sanitizarTextoMedico(e instanceof Error ? e.message : String(e)).slice(0, 500)}`); }
      }
    }
    try { await enviarFala([RASCUNHO_FALLBACK_CONVERSA], entrada.chaveProcessamento); }
    catch (e) { deps.log('erro', `COMUNICACAO_FALLBACK_FALHOU: ${sanitizarTextoMedico(e instanceof Error ? e.message : String(e)).slice(0, 500)}`); }
  };
  const anterior = processamentos.get(entrada.medicoId);
  const processamento = (anterior ? anterior.catch(() => {}) : Promise.resolve()).then(async (): Promise<ProximaAcaoNoto> => {
    try {
      if (entrada.eventoAgenda) {
        if (!deps.conversaLivreAtiva) return { tipo: 'nenhuma' };
        if (entrada.eventoAgenda.agenda !== 'tribemd') { await fallback('PROVEDOR_AGENDA_INVALIDO'); return { tipo: 'nenhuma' }; }
        const chave = `agenda:conclusao:${entrada.chaveProcessamento}`;
        if (!await deps.historico.reservar(entrada.medicoId, 'simulado', chave)) return { tipo: 'nenhuma' };
        await deps.historico.liberar(entrada.medicoId, 'simulado', chave);
        const memoria = deps.memoriaPersistida, conversa = entrada.chaveConversa;
        let estado: EstadoComunicacaoMedico | null = null;
        if (entrada.eventoAgenda.conectado) {
          const aviso = 'Já recebi o seu acesso ao TribeMD.';
          await enviarFala([aviso], `${entrada.chaveProcessamento}:acesso`);
          estado = await deps.lerEstado(entrada.medicoId, entrada.agora);
          if (!estado) { await fallback('COMUNICACAO_ESTADO_AUSENTE'); return { tipo: 'nenhuma' }; }
        }
        if (entrada.eventoAgenda.conectado && estado?.estado.agenda.conectada && estado.estado.agenda.nome?.toLowerCase() === 'tribemd' && conversa && deps.pendencias) {
          if (await deps.retroativo?.iniciar(entrada.medicoId, conversa, entrada.chaveProcessamento, entrada.agora, await deps.lerInicioPendencias?.(entrada.medicoId))) return { tipo: 'nenhuma' };
          await deps.pendencias.iniciar(entrada.medicoId, conversa, entrada.chaveProcessamento, entrada.agora);
          return { tipo: 'nenhuma' };
        }
        let resultado: { ok: boolean; motivo?: string; total?: number; consultas?: unknown[]; dataInicio?: string; janelaDias?: number } = { ok: false, motivo: 'ACESSO_NAO_CONFIRMADO' };
        if (entrada.eventoAgenda.conectado) {
          if (!estado?.estado.agenda.conectada || estado.estado.agenda.nome?.toLowerCase() !== 'tribemd' || !deps.listarConsultasSemNota) resultado = { ok: false, motivo: 'AGENDA_INDISPONIVEL' };
          else resultado = deps.prepararPendencias ? await deps.prepararPendencias(entrada.medicoId, entrada.agora) : await deps.listarConsultasSemNota(entrada.medicoId, estado.estado.agenda, entrada.agora);
        }
        if (!deps.prepararPendencias) auditarFerramenta('listar_consultas_sem_notas', resultado);
        else deps.log('info', 'SINCRONIZACAO_AGENDA_RESULTADO ' + JSON.stringify({ medicoId: entrada.medicoId, ok: resultado.ok, motivo: resultado.motivo }));
        if (entrada.eventoAgenda.conectado && resultado.ok && conversa && await deps.retroativo?.iniciar(entrada.medicoId, conversa, entrada.chaveProcessamento, entrada.agora)) return { tipo: 'nenhuma' };
        if (entrada.eventoAgenda.conectado && resultado.ok && conversa && await deps.pendencias?.iniciar(entrada.medicoId, conversa, entrada.chaveProcessamento, entrada.agora)) return { tipo: 'nenhuma' };
        if (entrada.eventoAgenda.conectado && !resultado.ok && ['SINCRONIZACAO_INCOMPLETA', 'SEM_CONSULTAS_SINCRONIZADAS'].includes(resultado.motivo ?? '') && conversa && deps.pendencias) {
          await deps.pendencias.aposSyncIncompleta(entrada.medicoId, conversa, entrada.chaveProcessamento, entrada.agora);
          return { tipo: 'nenhuma' };
        }
        if (resultado.ok && resultado.dataInicio) {
          const formatada = formatarPendencias(resultado, resultado.dataInicio, '', 2);
          await enviarFala(formatada.fala, entrada.chaveProcessamento);
          return { tipo: 'nenhuma' };
        }
        const resposta = await deps.conversador?.responder({ instabilidadesRecentes: await lerInstabilidades(), texto: '', mensagens: memoria && conversa ? await memoria.ler(entrada.medicoId, conversa) : [],
          resumo: memoria && conversa ? (await memoria.lerResumo(entrada.medicoId, conversa))?.resumo ?? null : null,
          estado: estado?.estado ?? {}, agora: entrada.agora, eventoAgenda: entrada.eventoAgenda, acoesPermitidas: [],
          resultadoFerramenta: { ferramenta: 'listar_consultas_sem_notas', dadosNaoConfiaveis: resultado } });
        if (!resposta) { await fallback('COMUNICACAO_SEM_FALA'); return { tipo: 'nenhuma' }; }
        const restante = resposta.fala.slice(1).join('\n');
        const fala = resposta.fala.length > 2 ? [resposta.fala[0], restante.length <= 500 ? restante : `${restante.slice(0, 400)}\nResumo de ${resultado.total ?? 'várias'} consultas; lista abreviada.`] : resposta.fala;
        await enviarFala(fala, entrada.chaveProcessamento);
        return { tipo: 'nenhuma' };
      }
      if (deps.conversaLivreAtiva && deps.enviarLinkCofreAgenda && entrada.respostaMedico) {
        // Consome o evento antes de qualquer efeito do cofre, inclusive entre réplicas.
        const chave = `conversa:agenda:${entrada.chaveProcessamento}`;
        if (!await deps.historico.reservar(entrada.medicoId, 'simulado', chave)) return { tipo: 'nenhuma' };
        await deps.historico.liberar(entrada.medicoId, 'simulado', chave);
      }
      if (entrada.respostaMedico && contemCredencialAgenda(entrada.respostaMedico.texto) && deps.conversaLivreAtiva) {
        deps.log('erro', registroErroNoto('COMUNICACAO_ENTRADA_PROTEGIDA', 'acionavel', { etapa: 'entrada' }));
        try { await enviarFala([FALA_PROTECAO_CREDENCIAL_AGENDA], entrada.chaveProcessamento); }
        catch { deps.log('erro', registroErroNoto('COMUNICACAO_RESPOSTA_PROTEGIDA_FALHOU', 'tecnico', { etapa: 'entrada' })); }
        return { tipo: 'nenhuma' };
      }
      // Na conversa livre a interpretação usa o histórico completo; o classificador legado não o recebe.
      if (!deps.conversaLivreAtiva && entrada.respostaMedico && await deps.tratarCofre?.(entrada.medicoId, entrada.respostaMedico.texto)) return { tipo: 'nenhuma' };
      if (!deps.conversaLivreAtiva && entrada.respostaMedico && /\b(senha|password|token|secret|segredo|api[_ -]?key)\b/i.test(entrada.respostaMedico.texto)) return { tipo: 'nenhuma' };
      let estado = await deps.lerEstado(entrada.medicoId, entrada.agora);
      if (!estado) { await fallback('COMUNICACAO_ESTADO_AUSENTE'); return { tipo: 'nenhuma' }; }
      if (deps.conversaLivreAtiva && entrada.respostaMedico && entrada.chaveConversa) {
        const conversa = entrada.chaveConversa;
        const aguardandoInicio = await deps.aguardaInicioRetroativo?.(entrada.medicoId);
        const responderRetroativo = () => deps.retroativo?.responder(entrada.medicoId, conversa, entrada.chaveProcessamento,
          entrada.respostaMedico!.texto, entrada.agora, entrada.chavePergunta);
        // Uma confirmação pendente tem prioridade sobre qualquer nova verificação de agenda.
        let atendida = !aguardandoInicio && !!await responderRetroativo();
        if (!atendida && deps.pendencias) {
          const mensagens = await deps.memoriaPersistida?.ler(entrada.medicoId, conversa) ?? [];
          atendida = await deps.pendencias.responder({ medicoId: entrada.medicoId, conversa, chave: entrada.chaveProcessamento,
            texto: entrada.respostaMedico.texto, mensagens, agora: entrada.agora, agendaConectada: estado.estado.agenda.conectada,
            ...(deps.retroativo ? { aoEmitir: async (desde: string | null) => {
              await deps.retroativo!.iniciar(entrada.medicoId, conversa, entrada.chaveProcessamento, entrada.agora, desde);
            } } : {}),
            ...(aguardandoInicio ? { aoInicio: async (desde: string) => {
              await deps.retroativo?.responder(entrada.medicoId, conversa, entrada.chaveProcessamento, desde, entrada.agora);
            } } : {}) });
        }
        if (!atendida && aguardandoInicio) atendida = !!await responderRetroativo();
        if (atendida) {
          await deps.memoriaPersistida?.registrar(entrada.medicoId, conversa, `medico:${entrada.chaveProcessamento}`, sanitizarTextoMedico(entrada.respostaMedico.texto));
          return { tipo: 'nenhuma' };
        }
      }
      const memoriaConversa = deps.conversaLivreAtiva === true ? deps.memoriaPersistida : deps.memoriaConversa;
      const conversa = entrada.chaveConversa;
      const respostaMedico = entrada.respostaMedico ? { ...entrada.respostaMedico,
        texto: sanitizarTextoMedico(entrada.respostaMedico.texto),
        ultimaFalaNoto: deps.conversaLivreAtiva && conversa ? await deps.memoriaPersistida?.lerUltimaFalaNoto(entrada.medicoId, conversa) : undefined,
        mensagensSeguras: memoriaConversa && conversa ? await memoriaConversa.ler(entrada.medicoId, conversa) : entrada.respostaMedico.mensagensSeguras
      } : undefined;
      let semDecisao = false;
      const acao = await orquestrarComunicacao({ ...entrada, ...estado, respostaMedico }, {
        historico: deps.historico, log: deps.log, extratorResposta: deps.extratorResposta,
        aoSemDecisao: deps.conversaLivreAtiva === true ? () => { semDecisao = true; } : undefined
      });
      const agendaViaConversa = deps.conversaLivreAtiva === true && respostaMedico && deps.listarConsultasSemNota && deps.enviarLinkCofreAgenda &&
        (acao.tipo === 'aguardar_comprovante' || acao.tipo === 'listar_consultas_sem_nota' || acao.tipo === 'pedir_agenda' || acao.tipo === 'reperguntar' && acao.pergunta !== 'problema_fiscal');
      if (!agendaViaConversa) await deps.aoDecidir?.(acao, entrada.chaveProcessamento, { nomeMedico: estado.nomeMedico });
      if (deps.conversaLivreAtiva === true && acao.tipo === 'nenhuma' && !semDecisao) { await fallback('COMUNICACAO_SEM_DECISAO_SEGURA'); return acao; }
      let fala: string[] | undefined;
      let consultaAnunciada = false;
      const responderBoasVindas = deps.conversaLivreAtiva === true && respostaMedico && conversa &&
        acao.tipo === 'perguntar_nota_pendente' && await deps.memoriaPersistida?.temBoasVindas(entrada.medicoId, conversa);
      if (deps.conversaLivreAtiva === true && respostaMedico && (acao.tipo === 'nenhuma' || responderBoasVindas || agendaViaConversa) && deps.conversador) {
        const resumo = conversa ? await deps.memoriaPersistida?.lerResumo(entrada.medicoId, conversa) : null;
        const linkCofreJaSolicitado = !!(conversa && await deps.memoriaPersistida?.temPedidoCofre(entrada.medicoId, conversa));
        let contextoConexao = await deps.lerContextoConexao?.(entrada.medicoId, entrada.agora);
        const semAgendaDigital = !estado.estado.agenda.conectada && !!(conversa && await deps.memoriaPersistida?.semAgendaDigital(entrada.medicoId, conversa));
        const falasRecentesNoto = conversa ? await deps.memoriaPersistida?.lerUltimasFalasNoto(entrada.medicoId, conversa) ?? [] : [];
        const contexto = { falasRecentesNoto, semAgendaDigital, instabilidadesRecentes: await lerInstabilidades(), contextoConexao, ultimaFalaNoto: respostaMedico.ultimaFalaNoto, linkCofreJaSolicitado, texto: respostaMedico.texto, mensagens: respostaMedico.mensagensSeguras ?? [],
          resumo: resumo?.resumo ?? null, estado: estado.estado, agora: entrada.agora };
        let resposta = await deps.conversador.responder({ ...contexto, acoesPermitidas: deps.listarConsultasSemNota && deps.enviarLinkCofreAgenda
          ? estado.estado.agenda.conectada || contextoConexao?.link && !contextoConexao.link.expirado && !contextoConexao.link.usado ? ['listar_consultas_sem_notas'] : ['listar_consultas_sem_notas', 'enviar_link_cofre_agenda'] : [] });
        if (resposta.semAgendaDigital && conversa && deps.memoriaPersistida) await deps.memoriaPersistida.registrarMarca(entrada.medicoId, conversa, 'sem_agenda_digital');
        if (resposta.intencaoConexao === 'informar_conexao') {
          // A IA interpreta; conexão e possibilidade de reenvio são sempre relidas no backend.
          const atualizado = await deps.lerEstado(entrada.medicoId, entrada.agora);
          if (!atualizado) { await fallback('COMUNICACAO_ESTADO_AUSENTE'); return acao; }
          estado = atualizado;
          contextoConexao = await deps.lerContextoConexao?.(entrada.medicoId, entrada.agora);
          contexto.estado = estado.estado;
          contexto.contextoConexao = contextoConexao;
          if (resposta.acao !== 'enviar_link_cofre_agenda') {
            const aviso = resposta.fala.slice(0, 1);
            if (aviso.length) {
              await enviarFala(aviso, `${entrada.chaveProcessamento}:verificacao`);
              consultaAnunciada = true;
            }
            resposta = await deps.conversador.responder({ ...contexto, verificacaoConexao: true,
              acoesPermitidas: estado.estado.agenda.conectada || contextoConexao?.link && !contextoConexao.link.expirado && !contextoConexao.link.usado ? ['listar_consultas_sem_notas'] : ['listar_consultas_sem_notas', 'enviar_link_cofre_agenda'] });
          }
        }
        if (resposta.reacao) {
          try { await deps.aoReagir?.(resposta.reacao); }
          catch { deps.log('erro', registroErroNoto('REACAO_FALHOU', 'tecnico', { etapa: 'reacao' })); }
        }
        if (resposta.acao === 'listar_consultas_sem_notas' && estado.estado.agenda.conectada && conversa && deps.pendencias) {
          await deps.memoriaPersistida?.registrar(entrada.medicoId, conversa, `medico:${entrada.chaveProcessamento}`, respostaMedico.texto);
          await deps.pendencias.iniciar(entrada.medicoId, conversa, entrada.chaveProcessamento, entrada.agora);
          return acao;
        }
        if (resposta.acao === 'listar_consultas_sem_notas' && deps.listarConsultasSemNota) {
          let resultado;
          try { resultado = await deps.listarConsultasSemNota(entrada.medicoId, estado.estado.agenda, entrada.agora); }
          catch (e) { deps.log('erro', registroErroNoto('AGENDA_INDISPONIVEL', 'tecnico', { etapa: 'listar', detalhe: e instanceof Error ? e.message : String(e) })); resultado = { ok: false, motivo: 'AGENDA_INDISPONIVEL' }; }
          auditarFerramenta('listar_consultas_sem_notas', resultado);
          const conectar = !resultado.ok && ['SEM_AGENDA_CONECTADA', 'AGENDA_NAO_SUPORTADA', 'SEM_CONSULTAS_SINCRONIZADAS'].includes(resultado.motivo ?? '') &&
            (resultado.motivo !== 'SEM_CONSULTAS_SINCRONIZADAS' || !estado.estado.agenda.conectada);
          resposta = await deps.conversador.responder({ ...contexto,
            resultadoFerramenta: { ferramenta: 'listar_consultas_sem_notas', dadosNaoConfiaveis: resultado },
            acoesPermitidas: conectar && !linkCofreJaSolicitado && deps.enviarLinkCofreAgenda ? ['enviar_link_cofre_agenda'] : [] });
        }
        if (resposta.acao === 'enviar_link_cofre_agenda' && podeSolicitarLinkAgenda(estado.estado.agenda.conectada, linkCofreJaSolicitado, resposta.intencaoConexao, contextoConexao) && deps.enviarLinkCofreAgenda) {
          const renovacao = linkCofreJaSolicitado || !!contextoConexao?.link;
          const introducao = renovacao ? null : await deps.conversador.prepararIntroducaoLink({ ...contexto, fala: resposta.fala });
          if (!renovacao && !introducao) {
            deps.log('erro', registroErroNoto('INTRODUCAO_LINK_INDISPONIVEL', 'validacao', { etapa: 'conversa' }));
            if (conversa) await deps.memoriaPersistida?.registrarFala(entrada.medicoId, conversa, `medico:${entrada.chaveProcessamento}`, respostaMedico.texto);
            await enviarFala([mensagemInstabilidade(await lerInstabilidades())], entrada.chaveProcessamento);
            return acao;
          }
          if (conversa && deps.memoriaPersistida) await deps.memoriaPersistida.registrarMarca(entrada.medicoId, conversa, 'link_agenda_solicitado');
          let resultado;
          try { resultado = renovacao
            ? await deps.enviarLinkCofreAgenda(entrada.medicoId, { reenvio: true }) : await deps.enviarLinkCofreAgenda(entrada.medicoId, { introducao: introducao! }); }
          catch { resultado = { ok: false, motivo: 'COFRE_INDISPONIVEL' }; }
          auditarFerramenta('enviar_link_cofre_agenda', resultado);
          resposta = await deps.conversador.responder({ ...contexto,
            resultadoFerramenta: { ferramenta: 'enviar_link_cofre_agenda', dadosNaoConfiaveis: resultado }, acoesPermitidas: [] });
        }
        if (resposta.reacao && resposta.acao === null && consultaAnunciada) {
          try { await deps.aoReagir?.(resposta.reacao); }
          catch { deps.log('erro', registroErroNoto('REACAO_FALHOU', 'tecnico', { etapa: 'reacao' })); }
        }
        fala = resposta.fala;
        // O aviso ocupa um dos três balões da interação; compacta só a fala final.
        if (consultaAnunciada && fala.length > 2) fala = [fala[0], `${fala[1]}\n${fala[2]}`.slice(0, 500)];
      }
      if (!fala && deps.conversaLivreAtiva && respostaMedico && !(acao.tipo === 'boas_vindas' && estado.nomeMedico)) {
        deps.log('erro', 'COMUNICACAO_SEM_FALA'); fala = [RASCUNHO_FALLBACK_CONVERSA];
      }
      if (memoriaConversa && conversa) {
        if (respostaMedico) await memoriaConversa.registrar(entrada.medicoId, conversa, `medico:${entrada.chaveProcessamento}`, respostaMedico.texto);
        const pergunta = fala ? null : montarPerguntaComunicacao(acao);
        if (pergunta) await memoriaConversa.registrar(entrada.medicoId, conversa, `noto:${entrada.chaveProcessamento}`, pergunta, 'noto');
      }
      if (fala?.length) await enviarFala(fala, entrada.chaveProcessamento);
      if (deps.conversaLivreAtiva === true && respostaMedico && conversa && deps.memoriaPersistida && deps.conversador) {
        await atualizarResumo(deps.memoriaPersistida, deps.conversador, entrada.medicoId, conversa);
      }
      return acao;
    } catch (erro) {
      if (deps.conversaLivreAtiva && (entrada.respostaMedico || entrada.eventoAgenda)) await fallback('COMUNICACAO_ESTADO_FALHOU', erro, false);
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
    if (resumo !== null) await memoria.registrarResumo(medicoId, conversa, resumo, antigas.at(-1)!.id);
  } catch { /* Resumo é auxiliar: sua indisponibilidade não interrompe a conversa. */ }
}
