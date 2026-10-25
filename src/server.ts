import { resultadoConsultaAgenda } from './onboarding/resumo-valores-agenda.js';
import {selecionarDias,horarioConsulta,selecaoConsultas,pacienteLiteralDaConsulta, confirmaSelecaoAnterior,type SelecaoConsultas} from './agenda/selecao-consultas.js';
import { origemWebhookConfigurada } from './onboarding/io/origem-webhook.js';
import {ferramentasLiberadas} from './onboarding/ferramentas-conversa.js';
import { contemCredencialAgenda } from './cofre/links.js';
import { PendenciasMedico, classificarPendencias, formatarPendencias } from './onboarding/pendencias-medico.js';
import { PostgresContextoPendencias } from './io/postgres/postgres-contexto-pendencias.js';
import { ConversaLoteRetroativo, interpretarDataRetroativo, interpretarReenvioLote, perguntaLote } from './onboarding/lote-retroativo.js';
import { PostgresLotesEmissao } from './io/postgres/postgres-lotes-emissao.js';
import { processarLoteRetroativo } from './worker/processar-lote-retroativo.js';
import { PostgresEmissaoLote, type ExecutorFiscalLote } from './io/postgres/postgres-emissao-lote.js';
import { sincronizarAgenda, CacheAgendaProcesso } from './agenda/sincronizar-agenda.js';
import { registroErroNoto } from './observabilidade/erros.js';
import { registrarLinhaSincrona } from './observabilidade/registrar-sincrono.js';
import { interpretarConfirmacaoEmissao, limitarConfirmacaoEmissao } from './onboarding/confirmacao-emissao-medico.js';
import { PostgresConsultasSincronizadas } from './io/postgres/postgres-consultas-sincronizadas.js';
import { ehIdAmplimed, prepararLoteAmplimed } from './agenda/amplimed-lote.js';
import { solicitarOtpEmail, autenticarComOtpEmail, type EnviarOtpEmail } from './otp/login-otp-email.js';
import { EnviarOtpEmailResend } from './io/resend/enviar-otp-email.js';
import { chaveComprovante } from './atendimento/comprovante.js';
import { validarCpf } from './paciente/validar-cpf.js';
import { buscarCpfConversa } from './permissoes/buscar-cpf-conversa.js';
import { registrarPerguntaCpf, processarRespostaCpfPaciente, processarRespostaMedicoCpf, type RetomadaDeps } from './fluxos/processar-resposta-cpf.js';
import { aposEnfileirarComprovante } from './fluxos/apos-enfileirar-comprovante.js';
import { extrairTelefoneJid } from './whatsapp/extrair-telefone-jid.js';
import { ComunicacaoHomologacao } from './whatsapp/comunicacao-homologacao.js';
import { criarCofreContas } from './cofre/router.js';
import { Permissoes, type Permissao } from './permissoes/permissoes.js';
import { confirmarEscolhaPermissao } from './permissoes/confirmar-escolha.js';
import { criarRouterPermissoes } from './permissoes/router.js';
import { PostgresCadastro } from './cadastro/postgres-cadastro.js';
import { CadastroCertificado } from './cadastro/cadastro-certificado.js';
import { criarConsultaEmpresa, PesquisaRegistroIndisponivel } from './cadastro/consultas.js';
import { criarRouterStatusWhatsapp } from './whatsapp/status-router.js';
import { criarRouterCadastroPainel } from './cadastro/router-painel.js';
import { OpenSerpConsultaRegistro } from './cadastro/openserp-registro.js';
import { createHash, randomUUID } from 'node:crypto';
import { gerarVariantesTelefoneBrasileiro } from './whatsapp/variantes-telefone-brasileiro.js';
import { diagnosticoEntradaWebhook, diagnosticoResultadoWebhook, diagnosticoErroWebhook } from './whatsapp/diagnostico-webhook.js';
import { criarRouterNfse } from './api/nfse/nfse-router.js';
import { PostgresEmissaoApiRepositorio } from './io/postgres/postgres-emissao-api-repositorio.js';
/**
 * Servidor HTTP principal da aplicação Notomed Whats.
 * Expõe as rotas de webhook da Evolution API, API de autenticação por OTP
 * e serve a interface web da tela única de entrada para os médicos (seção 1 e 4.6).
 */

import express, { type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config } from './config.js';
import { pool } from './io/postgres/pool.js';
import { PostgresOtpRepositorio, PostgresOtpEmailRepositorio } from './io/postgres/postgres-otp-repositorio.js';
import { PostgresAtendimentoRepositorio } from './io/postgres/postgres-atendimento-repositorio.js';
import { EvolutionApiClient } from './io/evolution/evolution-api-client.js';
import { SupabaseAuthAdminService } from './io/supabase/supabase-auth-admin-service.js';

import { solicitarOtp } from './otp/solicitar-otp.js';
import { autenticarComOtp } from './auth/autenticar-com-otp.js';
import { processarMensagemWebhook } from './fluxos/processar-mensagem-webhook.js';
import { PostgresMemoriaConversaMedico } from './onboarding/memoria-conversa.js';
import { ConversadorMedico, normalizarAgenda, periodoDecisao, fimPeriodoDecisao, calendarioConversa, diaDecisao, confirmacaoDaDecisao, type DecisaoConversa } from './onboarding/conversador-medico.js';
import { InterpretadorSemantico } from './onboarding/interpretador-semantico.js';
import { MemoriaConversaMedico } from './onboarding/contexto-conversa-medico.js';
import { processarComunicacaoMedico, type FerramentasConversa, type ContextoAcaoConversa } from './onboarding/processar-comunicacao-medico.js';
import { lerEstadoComunicacaoMedico } from './onboarding/io/ler-estado-comunicacao-medico.js';
import { orquestrarComprovante } from './fluxos/processar-comprovante.js';
import { PostgresEmissaoComprovante } from './io/postgres/postgres-emissao-comprovante.js';
import { PostgresHistoricoComunicacao } from './io/postgres/postgres-historico-comunicacao.js';
import { ExtratorRespostaMedicoNvidia } from './io/nvidia/extrator-resposta-medico.js';
import { ExtratorComprovanteNvidia } from './io/nvidia/extrator-comprovante.js';
import { completarOpenAi } from './io/nvidia/chat-client.js';

import { processarOnboardingXml } from './onboarding/fluxos/processar-onboarding-xml.js';
import { ErroAdocaoReferencia } from './onboarding/io/confirmar-politica-emissao.js';
import { confirmarParametrosFiscais } from './onboarding/fluxos/confirmar-parametros-fiscais.js';
import { registrarConsentimentoFiscal, adotarReferenciaConsentida, versaoConsentimentoFiscal } from './onboarding/fluxos/consentimento-fiscal.js';
import { salvarCertificadoMedico } from './onboarding/fluxos/salvar-certificado-medico.js';
import { conectarInstanciaWhatsappMedico } from './onboarding/io/conectar-instancia-whatsapp-medico.js';
import { consultarStatusInstanciaWhatsapp } from './onboarding/io/consultar-status-instancia-whatsapp.js';
import { consultarStatusOnboarding } from './onboarding/io/consultar-status-onboarding.js';
import { resolverMedicoId } from './onboarding/io/resolver-medico-id.js';
import { salvarPerfilProfissional, ErroPerfilProfissional } from './io/postgres/salvar-perfil-profissional.js';
import { salvarPreferenciasMedico } from './conta/salvar-preferencias-medico.js';
import { ZodError } from 'zod';
import { HubDesenvolvedorCpfClient } from './io/hubdodesenvolvedor/hub-desenvolvedor-cpf-client.js';
import { AdnNfseClient } from './io/fiscal/adn-nfse-client.js';
import { extrairChavesCertificado } from './io/fiscal/extrair-chaves-certificado.js';
import { carregarCertificadoMedico } from './io/fiscal/carregar-certificado-medico.js';
import { sincronizarHistoricoEvolutionUmaVez } from './onboarding/io/sincronizar-historico-evolution.js';
import { PostgresDadosProfissionaisService } from './io/postgres/postgres-dados-profissionais-service.js';
import { registrarConexaoWhatsapp } from './onboarding/io/registrar-conexao-whatsapp.js';
import { configurarDesempenhoHttp, OPCOES_ARQUIVOS_ESTATICOS } from './http/configurar-desempenho-http.js';
import { tratarErrosHttp } from './http/tratar-erros-http.js';
import { criarEncerramentoGracioso } from './processo/encerrar-gracioso.js';
import { registrarSinaisDeProcesso } from './processo/registrar-sinais-de-processo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function criarAppExpress(opcoes: { enviadorOtpEmail?: EnviarOtpEmail } = {}) {
  const app = express();
  configurarDesempenhoHttp(app);

  // Instanciação dos adaptadores de infraestrutura
  const otpRepo = new PostgresOtpRepositorio(pool);
  const atendimentoRepo = new PostgresAtendimentoRepositorio(pool, config.encryptionKey);
  const historicoComunicacao = new PostgresHistoricoComunicacao(pool, config.appPepper);
  const memoriaConversa = new MemoriaConversaMedico();
  const memoriaPersistida = config.conversaLivreAtiva ? new PostgresMemoriaConversaMedico(pool) : undefined;
  const evolutionClient = new EvolutionApiClient(
    config.evolutionApiUrl,
    config.evolutionGlobalApiKey,
    config.evolutionOfficialInstanceName, config.evolutionOfficialInstanceName
  );
  const evolutionAssistantClient = new EvolutionApiClient(
    config.evolutionAssistantUrl, config.evolutionAssistantApiKey, config.evolutionAssistantInstanceName, config.evolutionOfficialInstanceName);
  const origemLinksSeguros = config.appPublicOrigin ?? '';
  const permissoesNoto = config.permissoesAtiva && origemLinksSeguros ? new Permissoes({ pool, origem: origemLinksSeguros }) : undefined;
  // solicitar_cpf só entra em operação quando a migração que alarga os CHECKs está aplicada.
  const permissoesCpfAtivaP: Promise<boolean> = permissoesNoto ? pool.query(
    `select 1 from pg_constraint where conname='noto_permissoes_permissao_check' and pg_get_constraintdef(oid) ilike '%solicitar_cpf%'`
  ).then(r => r.rows.length > 0).catch(() => false) : Promise.resolve(false);
  const comunicacaoHomologacao = new ComunicacaoHomologacao(pool, config, evolutionAssistantClient, console.info, permissoesNoto);
  const dadosProfissionais = new PostgresDadosProfissionaisService(pool);
  const authAdminService = new SupabaseAuthAdminService(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    pool
  );
  const cacheAgenda = new CacheAgendaProcesso();
  const cofres = criarCofreContas({
    aoAlterarAcesso: id => cacheAgenda.invalidar(id),
    pool, enviarCofre: (id, texto) => comunicacaoHomologacao.cofre(id, texto),
    registrarTextoLink: async entrada => {
      if (!memoriaPersistida) return;
      const chave = createHash('sha256').update(JSON.stringify([config.evolutionAssistantInstanceName, entrada.telefoneMedico.replace(/\D/g, '')])).digest('hex');
      await memoriaPersistida.registrarFala(entrada.medicoId, chave,
        `noto:agenda:link:${entrada.linkId}:${entrada.indice}`, entrada.texto, 'noto');
    },
    obterWhatsappAssistente: () => evolutionAssistantClient.obterTelefoneInstancia(),
    aoConcluirAgenda: async (medicoId, evento) => {
      cacheAgenda.invalidar(medicoId);
      try {
        if (!config.comunicacaoMedicoAtiva || !config.conversaLivreAtiva || !await comunicacaoHomologacao.medicoPermitido(medicoId)) return;
        const { rows } = await pool.query(`select u.telefone from medicos m join usuarios u on u.id=m.usuario_id where m.id=$1 and u.ativo=true`, [medicoId]);
        const telefone = rows[0]?.telefone;
        if (typeof telefone !== 'string') return;
        const chavesConversa = gerarVariantesTelefoneBrasileiro(telefone).map(t => createHash('sha256').update(JSON.stringify([config.evolutionAssistantInstanceName, t])).digest('hex'));
        await comunicarMedico(medicoId, `agenda:${evento.chave}`, undefined, undefined, chavesConversa[0], undefined, { ...evento, chavesConversa });
      } catch (e) { console.warn(registroErroNoto('CONCLUSAO_AGENDA_FALHOU', 'tecnico', { medicoId, etapa: 'conclusao', detalhe: e instanceof Error ? e.message : String(e) })); }
    },
    autenticar: async token => {
      const { data, error } = await authAdminService.supabaseClient.auth.getUser(token);
      return error ? null : data.user?.id ?? null;
    }
  });
  // Credenciais do cofre não passam pelo parser geral que conserva rawBody.
  app.use('/api/conta/cofre', cofres.app);
  if (cofres.appLinks) app.use('/c', cofres.appLinks);
  if (permissoesNoto) app.use('/p', criarRouterPermissoes(permissoesNoto, origemLinksSeguros, async r =>
    confirmarEscolhaPermissao(r,{pool,confirmar:entrada=>comunicacaoHomologacao.conversa(entrada)})));
  app.locals.encerrarCofres = cofres.encerrar;
  app.use(
    express.json({
      limit: '10mb',
      inflate: false,
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      }
    })
  );
  app.use(express.text({ limit: '10mb', inflate: false, type: ['text/*', 'application/xml'] }));

  const hubCpfClient = config.hubDesenvolvedorToken
    ? new HubDesenvolvedorCpfClient(config.hubDesenvolvedorToken)
    : undefined;
  // Mesma chave OpenAI, com modelo por finalidade.
  const iaApiKey=config.openaiApiKey;
  const completarIa=completarOpenAi;
  const iaModeloTexto=config.openaiTextoModel ?? '';
  const iaModeloPlanner=config.conversaAgenteAtiva ? config.openaiPlannerModel ?? iaModeloTexto : iaModeloTexto;
  const conversador = config.conversaLivreAtiva ? new ConversadorMedico(iaApiKey, iaModeloPlanner, completarIa, iaModeloTexto) : undefined;
  const interpretadorSemantico = config.conversaLivreAtiva && config.conversaAgenteAtiva ? new InterpretadorSemantico(iaApiKey, config.openaiPlannerModel ?? iaModeloPlanner, completarIa) : undefined;
  const iaModeloVisao=config.openaiVisaoModel ?? '';
  const pesquisaCrmConfigurada=!!config.openserpBaseUrl&&!!iaApiKey;
  const consultaRegistro = pesquisaCrmConfigurada
    ? new OpenSerpConsultaRegistro({baseUrl:config.openserpBaseUrl,openaiApiKey:iaApiKey,modelo:iaModeloTexto,incluirDiagnostico:true,
        completar:(mensagens)=>completarIa(iaApiKey ?? '', iaModeloTexto, mensagens, { temperature: 0.1, formatoJson: true, timeoutMs: 180_000, maxTokens: 2048, tentativasMax: 1 })})
    : new PesquisaRegistroIndisponivel();
  const cadastroCertificado = new CadastroCertificado(new PostgresCadastro(pool), criarConsultaEmpresa(config.hubDesenvolvedorToken), consultaRegistro,
    async (medicoId, certificadoId) => {
      const cert = await carregarCertificadoMedico(pool, authAdminService.supabaseClient, medicoId);
      if (!cert || cert.id !== certificadoId) return undefined;
      return extrairChavesCertificado(cert.pfxBuffer, cert.senhaCertificado).documentoTitular;
    }, hubCpfClient ? cpf => hubCpfClient.consultar(cpf) : undefined, pesquisaCrmConfigurada, 'openserp');
  if (process.env.NODE_ENV !== 'test') {
    const timer = setInterval(() => {
      // Enriquecimento automático via OpenSerp sem envio de perguntas no WhatsApp.
      void cadastroCertificado.recuperar().catch(() => console.warn('[Cadastro automático]', {codigo:'RECUPERACAO_FALHOU',acao:'verificar migrate:cadastro'}));
    }, 5000);
    timer.unref();
  }

  const adnNfseClient = new AdnNfseClient();
  const sincronizarHistoricoInstancia = (nomeInstancia: string) =>
    sincronizarHistoricoEvolutionUmaVez({
      baseUrl: config.evolutionApiUrl,
      apiKey: config.evolutionGlobalApiKey,
      nomeInstancia,
      repositorio: atendimentoRepo,
      consultaCpfProvider: hubCpfClient,
      pepper: config.appPepper
    });

  // Função interna sob demanda; nenhuma tarefa periódica ou sincronização em produção.
  const sincronizacoesAgenda = new Map<string, Promise<Awaited<ReturnType<typeof sincronizarAgenda>>>>();
  const sincronizarAgendaHomologacao = (medicoId: string, agora = new Date(), janelaDias = 90) => {
    const trabalho = (sincronizacoesAgenda.get(medicoId) ?? Promise.resolve()).then(async () => {
      try {
        const { rows } = await pool.query('select ambiente from medico_perfil_fiscal where medico_id=$1', [medicoId]);
        if (rows[0]?.ambiente !== 'homologacao') return { tipo: 'erro' as const, codigo: 'FONTE_INDISPONIVEL' as const };
        if (!Number.isInteger(janelaDias) || janelaDias < 1 || janelaDias > 365) throw Error('JANELA_AGENDA_INVALIDA');
        const repo = new PostgresConsultasSincronizadas(pool);
        const resultado = await cacheAgenda.consultar(medicoId, janelaDias, () => sincronizarAgenda({ medicoId, referenciaCofre: medicoId, janelaDias, agora }, cofres.fonteAgenda, repo,
          (id, consulta) => repo.resolverPaciente(id, consulta)));
        if (resultado.tipo === 'erro') console.warn(registroErroNoto(resultado.codigo, 'tecnico', { medicoId, etapa: 'sincronizacao' }));
        return resultado;
      } catch (e) {
        console.warn(registroErroNoto('SINCRONIZACAO_AGENDA_FALHOU', 'tecnico', { medicoId, etapa: 'sincronizacao', detalhe: e instanceof Error ? e.message : String(e) }));
        return { tipo: 'erro' as const, codigo: 'FONTE_INDISPONIVEL' as const };
      }
    });
    sincronizacoesAgenda.set(medicoId, trabalho);
    const limpar = () => { if (sincronizacoesAgenda.get(medicoId) === trabalho) sincronizacoesAgenda.delete(medicoId); };
    void trabalho.then(limpar, limpar);
    return trabalho;
  };
  app.locals.sincronizarAgendaHomologacao = sincronizarAgendaHomologacao;

  const contextoPendencias = new PostgresContextoPendencias(pool);
  const pendenciasPermitidas = async (id: string) => config.comunicacaoMedicoAtiva === true && config.conversaLivreAtiva === true && await comunicacaoHomologacao.medicoPermitido(id);
  const listarPendencias = async (id: string, agenda: { nome: string | null; conectada: boolean }, instante: Date, dataInicio?: string) => {
    if (!await pendenciasPermitidas(id)) return { ok: false, motivo: 'ENVIO_BLOQUEADO' };
    dataInicio ??= (await contextoPendencias.ler(id)).dataInicio ?? undefined;
    if (!dataInicio) return { ok: false, motivo: 'DATA_INICIO_NECESSARIA' };
    const nomesAoVivo = new Map<string, string | null>();
    const valoresAoVivo = new Map<string, number | null>();
    let sincronizacaoConcluida = false;
    if (agenda.conectada && agenda.nome?.toLowerCase() === 'tribemd') {
      const hoje = instante.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
      const janelaDias = Math.max(1, Math.ceil((Date.parse(hoje) - Date.parse(dataInicio)) / 86400000));
      const sincronizada = await sincronizarAgendaHomologacao(id, instante, janelaDias);
      if (sincronizada.tipo === 'erro') return { ok: false, motivo: sincronizada.codigo };
      sincronizacaoConcluida = true;
      for (const consulta of sincronizada.consultas) {
        nomesAoVivo.set(consulta.idExterno, consulta.nomeAoVivo ?? null);
        if (consulta.status === 'realizada') valoresAoVivo.set(consulta.idExterno, consulta.valorCobradoAoVivoCentavos ?? null);
      }
    }
    const resultado = await new PostgresConsultasSincronizadas(pool).listarConsultasSemNota(id, agenda, instante,
      (fonte, consultaId) => new PostgresEmissaoComprovante(pool, '', config.appPepper).consultaJaFaturada(id, fonte, consultaId),
      consultaId => nomesAoVivo.get(consultaId) ?? null, sincronizacaoConcluida, dataInicio);
    return { ...resultado, valoresAoVivo };
  };
  const pendencias = config.conversaLivreAtiva ? new PendenciasMedico(contextoPendencias, {
    ultimasFalas: (id, conversa) => memoriaPersistida!.lerFalasRecentes(id, conversa),
    permitido: pendenciasPermitidas,
    classificar: entrada => classificarPendencias(iaApiKey, iaModeloTexto, completarIa, entrada),
    listar: (id, inicio, agora) => listarPendencias(id, { nome: 'tribemd', conectada: true }, agora, inicio),
    enviar: async (medicoId, conversa, chave, fala, falaMemoria) => { await comunicacaoHomologacao.conversa({ medicoId, conversa, chave, fala, falaMemoria }); },
    log: mensagem => mensagem.startsWith('FERRAMENTA_AGENDA_RESULTADO ') ? console.info(mensagem) : registrarLinhaSincrona(registroErroNoto(mensagem, 'tecnico', { etapa: 'pendencias' }))
  }) : undefined;
  app.locals.aguardarPendencias = () => pendencias?.aguardar();

  const lotes = new PostgresLotesEmissao(pool, config.appPepper);
  const lotePermitido = async (id: string) => config.conversaLivreAtiva === true && config.emissaoComprovanteHomologacaoAtiva === true && await comunicacaoHomologacao.medicoPermitido(id);
  const emissaoLote = new PostgresEmissaoLote(pool, config.encryptionKey, config.appPepper, lotePermitido, config.retomadaRecusaSefinAtiva === true);
  const diagnosticarPeriodo = async (medicoId:string, desde:string, ate:string) => {
    const {rows} = await pool.query<{id_externo:string}>(`select id_externo from public.noto_consultas_sincronizadas
      where medico_id=$1 and fonte='tribemd' and status='realizada'
      and data_hora>=($2::date::timestamp at time zone 'America/Sao_Paulo') and data_hora<=$3::timestamptz`,[medicoId,desde,ate]);
    let jaEmitidas=0;
    for(const r of rows) if(await new PostgresEmissaoComprovante(pool,'',config.appPepper).consultaJaFaturada(medicoId,'tribemd',r.id_externo)) jaEmitidas++;
    return {totalNoPeriodo:rows.length,jaEmitidas};
  };
  const detalheLote = (id: string, consulta: string) => ehIdAmplimed(consulta) ? cofres.detalheAmplimedAoVivo(id, consulta) : cofres.detalheAoVivo(id, consulta);
  const criarRetroativo = (narrar?: ContextoAcaoConversa['narrar'], decisao?: DecisaoConversa, medicoId?: string, perguntaInterpretada?: string, fonteAgenda: 'tribemd' | 'amplimed' = 'tribemd', selecao?: SelecaoConsultas) => config.conversaLivreAtiva && config.emissaoComprovanteHomologacaoAtiva ? new ConversaLoteRetroativo(lotes, {
    permitido: lotePermitido,
    ultimaFala: (id, conversa) => memoriaPersistida!.lerUltimaFalaNoto(id, conversa),
    reenviar: narrar ? undefined : async (medicoId,conversa,chave,texto) => {
      const candidatos=await emissaoLote.pendentesReenvio(medicoId);
      if(!candidatos.length || !await interpretarReenvioLote(iaApiKey,iaModeloTexto,completarIa,texto)) return false;
      const r=await emissaoLote.reenviarSemContato(medicoId,chave,candidatos,(id,consulta)=>detalheLote(id,consulta),
        (id,solicitacaoId)=>comunicacaoHomologacao.paciente({medicoId:id,solicitacaoId},evolutionClient));
      await comunicacaoHomologacao.conversa({medicoId,conversa,chave:`lote:reenvio:${chave}`,
        fala:[`${r.entregues} notas entregues.${r.semContato ? ` ${r.semContato} continuam sem contato válido. Confira o contato na agenda.` : ''}${r.total-r.entregues-r.semContato>0 ? ' As demais não foram reenviadas. Vou verificar o que impediu a entrega.' : ''}`]});
      console.info(JSON.stringify({evento:'LOTE_REENVIO',medicoId,...r}));return true;
    },
    listarPeriodo: async (id, conversa, chave, inicio, agora, aoConcluir, somenteContagem = false) => {
      if (fonteAgenda === 'amplimed') {
        // Amplimed: lê finalizados particulares com o tomador, grava como consultas sincronizadas (fonte amplimed) e entrega os valores ao vivo.
        const hoje = agora.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
        const a = await cofres.lerAgendaAmplimed(id, inicio, hoje, true);
        console.info('FERRAMENTA_AGENDA_RESULTADO ' + JSON.stringify({ medicoId: id, ferramenta: 'iniciar_lote', agenda: 'amplimed', ok: a.ok, motivo: a.ok ? undefined : a.motivo }));
        if (!a.ok) { await comunicacaoHomologacao.conversa({ medicoId: id, conversa, chave: `lote:resultado:${chave}`, fala: narrar ? await narrar({ ferramenta: 'iniciar_lote', ok: false, motivo: a.motivo, limiteLeitura:{desde:calendarioConversa(agora).amplimedDesde,ate:hoje} }) : ['Não consegui ler sua agenda agora. Tento de novo quando você pedir.'] }); return; }
        let diasSelecionados:typeof a.dias;try{diasSelecionados=selecionarDias(a.dias,selecao??{});}catch{await comunicacaoHomologacao.conversa({medicoId:id,conversa,chave:`lote:selecao:${chave}`,fala:['Não consegui identificar um único atendimento nessa seleção. Não preparei nenhuma nota. Qual é a data e o horário?']});return;}
        if(selecao?.paciente&&new Set(selecionarDias(a.dias,{...selecao,ordem:undefined}).flatMap(d=>d.elegiveis).map(e=>e.detalhe?.cpf).filter(Boolean)).size>1){await comunicacaoHomologacao.conversa({medicoId:id,conversa,chave:`lote:ambiguo:${chave}`,fala:['Encontrei cadastros diferentes com esse nome. Não preparei nenhuma nota. Preciso identificar qual paciente você quer.']});return;}
        const p = prepararLoteAmplimed(diasSelecionados);
        // paciente_id é FK de pacientes: vincula/cria o cadastro mínimo pelo celular do cadastro Amplimed (mesmo caminho do TribeMD).
        const repoConsultas = new PostgresConsultasSincronizadas(pool); const prontas: typeof p.consultas = [];
        for (const consulta of p.consultas) {
          try { prontas.push({ ...consulta, pacienteId: await repoConsultas.resolverPaciente(id, consulta) }); }
          catch { p.valoresAoVivo.delete(consulta.idExterno); }
        }
        await repoConsultas.salvar(id, 'amplimed', prontas);
        await aoConcluir(p.valoresAoVivo);
        return;
      }
      if (!narrar) { await pendencias!.consultar(id, conversa, chave, inicio, agora, '', 2, resultado => aoConcluir(resultado.valoresAoVivo), !somenteContagem); return; }
      const resultado = await listarPendencias(id, {nome:'tribemd',conectada:true}, agora, inicio);
      if (resultado.ok && 'valoresAoVivo' in resultado) await aoConcluir(resultado.valoresAoVivo);
      else await comunicacaoHomologacao.conversa({medicoId:id,conversa,chave:`lote:resultado:${chave}`,
        fala:await narrar({ferramenta:'iniciar_lote',ok:false,motivo:resultado.motivo})});
    },
    narrarContagem: narrar ? async resultado => {
      const diagnostico = resultado.contagem.totalConsultas || fonteAgenda==='amplimed' ? {} : await diagnosticarPeriodo(medicoId!, resultado.desde, resultado.ate);
      const fala = await narrar({ferramenta:'iniciar_lote',ok:true,desde:resultado.desde,
        totalConsultas:resultado.contagem.totalConsultas,totalCentavos:resultado.contagem.totalCentavos,
        semValor:resultado.contagem.semValor,...diagnostico,perguntaAssinada:resultado.perguntaConfirmacao});
      // A pergunta fiscal conserva exatamente escopo/valor e a interpretação já vinculada no lote.
      return resultado.perguntaConfirmacao ? [resultado.perguntaConfirmacao] : fala.slice(0,1);
    } : undefined,
    comporContagem: lote => conversador!.responderContagemRetroativa(lote),
    contar: (id, desde, ate, valoresAoVivo) => {
      if (!valoresAoVivo) throw Error('LEITURA_AO_VIVO_NECESSARIA');
      return lotes.contarConsultasPeriodo(id, desde, ate, valoresAoVivo, fonteAgenda);
    },
    interpretarData: (texto, agora) => decisao ? Promise.resolve(periodoDecisao(decisao,agora,texto)) : interpretarDataRetroativo(iaApiKey, iaModeloTexto, completarIa, texto, agora),
    interpretarConfirmacao: (texto, pergunta) => decisao ? Promise.resolve(pergunta === perguntaInterpretada ? confirmacaoDaDecisao(decisao) : {intencao:'duvida' as const,confianca:0}) : interpretarConfirmacaoEmissao(iaApiKey, iaModeloTexto, completarIa, { texto, pergunta }),
    enviar: async (medicoId, conversa, chave, fala, aoEnviar) => { await comunicacaoHomologacao.conversa({ medicoId, conversa, chave, fala, aoEnviar: aoEnviar ? id => aoEnviar(id, new Date()) : undefined }); },
    log: mensagem => console.info(mensagem)
  }) : undefined;
  const retroativo = criarRetroativo();
  if (retroativo) {
    app.locals.processarLoteRetroativo = async (executor?: ExecutorFiscalLote) => executor ? processarLoteRetroativo(lotes, {
      permitido: lotePermitido,
      faturada: (id, fonte, consulta) => new PostgresEmissaoComprovante(pool, '', config.appPepper).consultaJaFaturada(id, fonte, consulta),
      lerDetalhe: (id, consulta) => detalheLote(id, consulta),
      assinatura: (id, fonte, consulta, valor) => lotes.assinatura(id, fonte, consulta, valor),
      emitir: entrada => emissaoLote.emitir(entrada, executor),
      enviar: async (medicoId, chave, fala, conversa) => { await comunicacaoHomologacao.conversa({ medicoId, chave, fala, conversa }); },
      log: mensagem => console.info(mensagem)
    }) : false;
  }

  const ferramentasConversa: FerramentasConversa = {
    lerFatos: async (medicoId,agora) => {
      const {rows} = await pool.query('select ambiente from medico_perfil_fiscal where medico_id=$1',[medicoId]);
      const estado = await lerEstadoComunicacaoMedico(pool,medicoId,agora,await cofres.statusAgenda(medicoId),config.preparacaoFiscalAtiva===true);
      const conexao = await cofres.links?.lerContextoConexao(medicoId,agora);
      const periodo = await contextoPendencias.ler(medicoId);
      const lote = retroativo ? await lotes.ativo(medicoId) : null;
      const ultimo = retroativo ? await pool.query(`select l.estado, count(*) filter (where i.estado='erro')::int as com_erro, count(*) filter (where i.estado='emitida')::int as emitidas
        from (select id, estado from public.noto_lotes_emissao where medico_id=$1 and estado='concluido' order by criado_em desc limit 1) l
        left join public.noto_lotes_itens i on i.lote_id=l.id group by l.estado`,[medicoId]).then(r=>r.rows[0]).catch(()=>undefined) : undefined;
      const enviados = await pool.query(`select count(*)::int as total from cofre_links l join cofre_links_auditoria a on a.link_id=l.id
        where l.medico_id=$1 and a.evento='enviado'`,[medicoId]);
      let emitirAutonomoValor:string|null=null,entregarPacienteValor:string|null=null,solicitarCpfValor:string|null=null;
      let faltantes:Permissao[]=[];
      if(permissoesNoto){
        const cpfEscolhivel=await permissoesCpfAtivaP;
        const escopoPermissoes:Permissao[]=cpfEscolhivel?['emitir_autonomo','entregar_paciente','solicitar_cpf']:['emitir_autonomo','entregar_paciente'];
        const [emitir,entregar,cpf]=await Promise.all([
          permissoesNoto.ler(medicoId,'emitir_autonomo').catch(()=>null),
          permissoesNoto.ler(medicoId,'entregar_paciente').catch(()=>null),
          cpfEscolhivel?permissoesNoto.ler(medicoId,'solicitar_cpf').catch(()=>null):Promise.resolve(null)
        ]);
        emitirAutonomoValor=emitir?.valor??null;entregarPacienteValor=entregar?.valor??null;solicitarCpfValor=cpf?.valor??null;
        faltantes=await permissoesNoto.faltantes(medicoId,escopoPermissoes).catch(()=>[]);
      }
      return {ambiente:rows[0]?.ambiente??null,agenda:estado?.estado.agenda??{nome:null,conectada:false},
        link:{ativo:!!conexao?.link&&!conexao.link.usado&&!conexao.link.expirado,enviados:Number(enviados.rows[0]?.total??0),
          agenda:conexao?.link?.agenda??null,
          usado:conexao?.link?.usado,expirado:conexao?.link?.expirado,minutosDesdeEnvio:conexao?.link?.minutosDesdeEnvio},
        periodo:{desde:periodo.dataInicio,origem:periodo.dataInicio?'contexto_salvo':null},semAgendaDigital:false,
        permissoes:permissoesNoto?{emitirAutonomo:emitirAutonomoValor,entregarPaciente:entregarPacienteValor,
          solicitarCpf:solicitarCpfValor,pendentes:faltantes.length>0,faltantes}:null,
        envioPacienteRealAtivo:config.envioPacienteRealAtivo===true,
        lote:lote?{estado:lote.estado,pergunta:lote.desde?perguntaLote(lote):undefined,perguntaId:lote.mensagemConfirmacaoId}:null,
        ultimoLote:ultimo?{comErro:Number(ultimo.com_erro),emitidas:Number(ultimo.emitidas)}:null,
        homologacaoInformada:false};
    },
    permitidas: fatos => ferramentasLiberadas(fatos,{lote:!!retroativo}),
    guardarPeriodo:(id,desde)=>contextoPendencias.definirInicio(id,desde),
    executar:async (decisao,c) => {
      if(!await comunicacaoHomologacao.medicoPermitido(c.medicoId)) return {dados:{ok:false,motivo:'ENVIO_BLOQUEADO'}};
      if(c.fatos.lote?.estado==='aguardando_confirmacao_lote' && decisao.parametros?.confirmacao) {
        const pacienteConfirmacao=pacienteLiteralDaConsulta(c.texto);
        if(pacienteConfirmacao&&confirmacaoDaDecisao(decisao).intencao!=='nao') {
          const {rows}=await pool.query("select texto from conversa_mensagens where medico_id=$1 and conversa=$2 and mensagem_id like 'contexto:selecao:%' order by id desc limit 1",[c.medicoId,c.conversa]);
          let anterior:SelecaoConsultas|undefined;try{anterior=rows[0]?JSON.parse(rows[0].texto):undefined;}catch{}
          let atual:SelecaoConsultas;try{atual=selecaoConsultas(c.texto,diaDecisao(decisao,c.agora),pacienteConfirmacao);}catch{return {falaAssinada:['Preciso confirmar a data e o horário antes de mudar a seleção. Mantive a proposta sem emitir.'],dados:{ok:false,motivo:'SELECAO_AMBIGUA'}};}
          if(!confirmaSelecaoAnterior(atual,anterior))return {falaAssinada:['Seu pedido menciona outro paciente. Vou manter a proposta anterior sem emitir. Quer descartá-la para preparar só esse paciente?'],dados:{ok:false,motivo:'NOVO_ESCOPO_PACIENTE'}};
        }
        await criarRetroativo(c.narrar,decisao,c.medicoId,c.fatos.lote.pergunta)?.responder(c.medicoId,c.conversa,c.chave,c.texto,c.agora,c.chavePergunta ?? c.fatos.lote.perguntaId ?? 'pergunta_nao_observada',c.mensagemEm ?? new Date(NaN));
        // Recusa à proposta pendente + pedido explícito de outro dia/período no mesmo turno:
        // a antiga ficou recusada acima; abre o novo escopo em seguida, ainda nesta fala.
        const negacao=confirmacaoDaDecisao(decisao);
        if(decisao.acao!=='iniciar_lote'||negacao.intencao!=='nao'||negacao.confianca<.9) return {jaRespondida:true};
        const diaTroca=diaDecisao(decisao,c.agora);
        let selecaoTroca:SelecaoConsultas;try{selecaoTroca=selecaoConsultas(c.texto,diaTroca,decisao.parametros?.paciente);}catch{return {falaAssinada:['Qual é o nome do paciente na agenda?'],dados:{ok:false,motivo:'PACIENTE_NAO_RESOLVIDO'}};}
        if(selecaoTroca.paciente&&c.fatos.agenda.nome?.toLowerCase()!=='amplimed')return {falaAssinada:['Não preparei notas de outras pessoas. Preciso confirmar o paciente nessa agenda.'],dados:{ok:false,motivo:'SELECAO_NAO_SUPORTADA'}};
        const desdeTroca=diaTroca??periodoDecisao(decisao,c.agora,c.texto);
        if(!desdeTroca) return {jaRespondida:true};
        await criarRetroativo(c.narrar,decisao,c.medicoId,undefined,c.fatos.agenda.nome?.toLowerCase()==='amplimed'?'amplimed':'tribemd',selecaoTroca)
          ?.iniciar(c.medicoId,c.conversa,c.chave,c.agora,desdeTroca,diaTroca?`${diaTroca}T23:59:59.999-03:00`:undefined);
        return {jaRespondida:true};
      }
      if(decisao.acao==='consultar_agenda') {
        const hoje=c.agora.toLocaleDateString('sv-SE',{timeZone:'America/Sao_Paulo'});
        const desde=decisao.parametros?.desde??'', ate=decisao.parametros?.ate??hoje;
        if(!/^\d{4}-\d{2}-\d{2}$/.test(desde)||!/^\d{4}-\d{2}-\d{2}$/.test(ate)||ate<desde||ate>hoje)
          return {dados:{ferramenta:'consultar_agenda',ok:false,motivo:'PERIODO_INVALIDO'}};
        const br=(d:string)=>d.split('-').reverse().join('/');
        const statusPt=(s:string)=>s==='realizada'?'realizada':s==='agendada'?'agendada':s==='cancelada'?'cancelada':s==='faltou'?'não compareceu':s;
        const hora=(iso:string)=>{const d=new Date(iso);return Number.isFinite(d.getTime())?d.toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'}):'';};
        const montar=(consultas:{paciente:string;dataHora:string;status:string}[])=>{
          const ordenadas=[...consultas].sort((a,b)=>Date.parse(a.dataHora)-Date.parse(b.dataHora));
          if(!ordenadas.length)return [`Não encontrei consultas na sua agenda de ${br(desde)} a ${br(ate)}.`];
          const itens=ordenadas.slice(0,12).map(x=>`${br(x.dataHora.slice(0,10))} ${hora(x.dataHora)} — ${x.paciente} (${statusPt(x.status)})`);
          const cab=`Na sua agenda de ${br(desde)} a ${br(ate)} encontrei ${ordenadas.length} consulta${ordenadas.length===1?'':'s'}.`;
          const baloes=[cab];let atual='';
          for(const item of itens){const prox=atual?atual+'\n'+item:item;if(prox.length>480){baloes.push(atual);atual=item;}else atual=prox;}
          if(atual)baloes.push(atual);
          if(ordenadas.length>itens.length){const aviso=`Mostrei as primeiras ${itens.length}; há mais ${ordenadas.length-itens.length} nesse período.`;if(baloes.length<3)baloes.push(aviso);}
          return baloes.slice(0,3);
        };
        if(c.fatos.agenda.nome?.toLowerCase()==='amplimed') {
          const a=await cofres.lerAgendaAmplimed(c.medicoId,desde,hoje,false);
          console.info('FERRAMENTA_AGENDA_RESULTADO '+JSON.stringify({medicoId:c.medicoId,ferramenta:'consultar_agenda',agenda:'amplimed',ok:a.ok,motivo:a.ok?undefined:a.motivo}));
          if(!a.ok)return {dados:{ferramenta:'consultar_agenda',ok:false,motivo:a.motivo,limiteLeitura:{desde:calendarioConversa(c.agora).amplimedDesde,ate:hoje}}};
          const consultas=a.dias.flatMap(d=>d.consultas).filter(x=>{const dia=x.dataHora.slice(0,10);return dia>=desde&&dia<=ate;});
          const fala=montar(consultas);
          return resultadoConsultaAgenda({consultas,desde,ate,medida:decisao.parametros?.medida,fala});
        }
        const janelaDias=Math.max(1,Math.ceil((Date.parse(hoje)-Date.parse(desde))/86400000));
        const a=await sincronizarAgendaHomologacao(c.medicoId,c.agora,janelaDias);
        console.info('FERRAMENTA_AGENDA_RESULTADO '+JSON.stringify({medicoId:c.medicoId,ferramenta:'consultar_agenda',agenda:'tribemd',ok:a.tipo==='consultas',motivo:a.tipo==='erro'?a.codigo:undefined}));
        if(a.tipo==='erro')return {dados:{ferramenta:'consultar_agenda',ok:false,motivo:a.codigo}};
        const consultas=a.consultas.filter(x=>{const dia=x.dataHora.slice(0,10);return dia>=desde&&dia<=ate;})
          .map(x=>({paciente:x.nomeAoVivo?.trim()||'Paciente',dataHora:x.dataHora,status:x.status,valorCentavos:x.valorCobradoAoVivoCentavos??null}));
        const fala=montar(consultas);
        return resultadoConsultaAgenda({consultas,desde,ate,medida:decisao.parametros?.medida,fala});
      }
      if(decisao.acao==='reenviar_nota_medico') {
        const r=await comunicacaoHomologacao.reenviarNotaMedico(c.medicoId,evolutionClient,diaDecisao(decisao,c.agora)??undefined,c.chave);
        const fala=r==='enviado'?'O envio do PDF da nota já emitida foi aceito. Confira se o documento apareceu por aqui.':r==='repetido'?'Esse PDF já teve uma tentativa de envio. A nota continua preservada. Posso conferir o registro desse envio para você.':r==='ambiguo'?'Há mais de uma nota emitida. De qual data de consulta você quer o PDF?':r==='ausente'?'Não encontrei uma única nota autorizada para esse pedido. Qual é a data da consulta?':'Não consegui entregar o PDF agora. A nota continua preservada. Se quiser, posso tentar o envio novamente.';
        await comunicacaoHomologacao.conversa({medicoId:c.medicoId,conversa:c.conversa,chave:`nota:reenvio:${c.chave}`,fala:[fala]});
        return {jaRespondida:true};
      }
      if(decisao.acao==='pedir_link_agenda') {
        await memoriaPersistida!.registrarMarca(c.medicoId,c.conversa,'link_agenda_solicitado');
        const agendaAlvo=normalizarAgenda(decisao.parametros?.agenda??c.fatos.agenda.nome??c.fatos.link.agenda??undefined);
        const r=agendaAlvo?await cofres.links?.solicitarLinkCofre(c.medicoId,agendaAlvo,{reenvio:c.fatos.link.enviados>0,fala:decisao.fala})??{ok:false,motivo:'AGENDA_INDISPONIVEL'}:{ok:false,motivo:'AGENDA_NAO_INFORMADA'};
        return {jaRespondida:r.ok&&r.motivo==='enviado',dados:{ferramenta:'pedir_link_agenda',...r}};
      }
      if(decisao.acao==='pedir_link_permissoes') {
        if(!permissoesNoto) return {dados:{ferramenta:'pedir_link_permissoes',ok:false,motivo:'PERMISSOES_INDISPONIVEIS'}};
        const faltantes=await permissoesNoto.faltantes(c.medicoId,['emitir_autonomo']).catch(()=>[] as const);
        const pedida=decisao.parametros?.permissao;
        const alvo=(pedida==='emitir_autonomo'||pedida==='entregar_paciente'||(pedida==='solicitar_cpf'&&await permissoesCpfAtivaP))?pedida:faltantes[0];
        if(!alvo) return {dados:{ferramenta:'pedir_link_permissoes',ok:true,motivo:'TODAS_ESCOLHIDAS'}};
        const r=await permissoesNoto.criarLink(c.medicoId,alvo).catch(()=>null);
        if(!r||'erro' in r) return {dados:{ferramenta:'pedir_link_permissoes',ok:false,motivo:r&&'erro' in r?r.erro:'FALHA'}};
        const fala=[...decisao.fala.filter(t=>t.trim()).slice(0,2), r.url];
        const envio=await comunicacaoHomologacao.conversa({medicoId:c.medicoId,chave:`link_permissoes:${alvo}:${r.url.slice(-12)}`,fala,conversa:c.conversa,falaMemoria:fala.map((t,i)=>i===fala.length-1?'[LINK_SEGURO]':t)});
        for(const [indice,texto] of fala.entries()) await memoriaPersistida?.registrarFala(c.medicoId,c.conversa,`noto:permissoes:link:${alvo}:${r.url.slice(-12)}:${indice}`,indice===fala.length-1?`${origemLinksSeguros}/p/[LINK_SEGURO]`:texto,'noto').catch(()=>{});
        return {jaRespondida:envio==='enviado'||envio==='simulado',dados:{ferramenta:'pedir_link_permissoes',ok:envio!=='erro',motivo:envio}};
      }
      // Dia único nomeado na mensagem vence o período salvo: nunca ampliar o pedido em silêncio.
      const dia=diaDecisao(decisao,c.agora);
      let selecao:SelecaoConsultas;
      try{selecao=selecaoConsultas(c.texto,dia,decisao.parametros?.paciente);}catch{return {falaAssinada:['Preciso confirmar qual paciente você quer, antes de preparar as notas. Qual é o nome na agenda?'],dados:{ok:false,motivo:'PACIENTE_NAO_RESOLVIDO'}};}
      if((selecao.paciente||selecao.horario)&&c.fatos.agenda.nome?.toLowerCase()!=='amplimed')return {falaAssinada:['Ainda não consigo separar um paciente nessa agenda com segurança. Não preparei notas de outras pessoas.'],dados:{ok:false,motivo:'SELECAO_NAO_SUPORTADA'}};
      // A seleção específica sobrevive ao próximo 'pode preparar'; não cai no lote de todos.
      if(!selecao.paciente&&!dia&&!periodoDecisao(decisao,c.agora,c.texto)&&!/\b(?:todos|todas|qualquer paciente)\b/i.test(c.texto)){
        const {rows}=await pool.query("select texto from conversa_mensagens where medico_id=$1 and conversa=$2 and mensagem_id like 'contexto:selecao:%' order by id desc limit 1",[c.medicoId,c.conversa]);
        if(rows[0])try{const anterior=JSON.parse(rows[0].texto);if(anterior.paciente)selecao.paciente=anterior.paciente;if(anterior.desde)selecao.desde=anterior.desde;if(anterior.ate)selecao.ate=anterior.ate;if(!selecao.horario&&anterior.horario)selecao.horario=anterior.horario;if(!selecao.ordem&&anterior.ordem)selecao.ordem=anterior.ordem;if(!dia&&!periodoDecisao(decisao,c.agora,c.texto)&&anterior.dia)selecao.dia=anterior.dia;}catch{return {dados:{ok:false,motivo:'SELECAO_NAO_RESOLVIDA'},falaAssinada:['Qual paciente você quer conferir? Não preparei notas de outras pessoas.']};}
      }
      const diaSelecionado=selecao.dia;
      const desde=diaSelecionado??periodoDecisao(decisao,c.agora,c.texto)??selecao.desde??c.fatos.periodo.desde!;
      const fimPeriodo=fimPeriodoDecisao(decisao,c.agora,c.texto)??selecao.ate;
      if(fimPeriodo){selecao.desde=desde;selecao.ate=fimPeriodo;}
      const fimDoDia=(diaSelecionado??fimPeriodo)?`${diaSelecionado??fimPeriodo}T23:59:59.999-03:00`:undefined;
      await memoriaPersistida?.registrar(c.medicoId,c.conversa,`contexto:selecao:${c.chave}`,JSON.stringify(selecao),'noto');
      if(decisao.acao==='listar_pendencias' && c.fatos.agenda.nome?.toLowerCase()==='amplimed') {
        // Amplimed v1: modo observação, dia a dia até 31 dias; nada vira nota.
        const hoje=c.agora.toLocaleDateString('sv-SE',{timeZone:'America/Sao_Paulo'});
        const a=await cofres.lerAgendaAmplimed(c.medicoId,desde,hoje,!!selecao.paciente);
        console.info('FERRAMENTA_AGENDA_RESULTADO '+JSON.stringify({medicoId:c.medicoId,ferramenta:'listar_pendencias',agenda:'amplimed',ok:a.ok,motivo:a.ok?undefined:a.motivo,dias:a.ok?a.dias.length:undefined,total:a.ok?a.dias.reduce((n,d)=>n+d.elegiveis.length,0):undefined}));
        if(!a.ok) return {dados:{ferramenta:'listar_pendencias',ok:false,motivo:a.motivo,limiteLeitura:{desde:calendarioConversa(c.agora).amplimedDesde,ate:hoje}}};
        const br=(d:string)=>d.split('-').reverse().join('/');
        let selecionados:typeof a.dias;try{selecionados=selecionarDias(a.dias,selecao);}catch{return {falaAssinada:['Não consegui identificar um único atendimento nessa seleção. Não preparei nenhuma nota. Qual é a data e o horário?'],dados:{ok:false,motivo:'SELECAO_AMBIGUA'}};}
        if(selecao.paciente&&new Set(selecionarDias(a.dias,{...selecao,ordem:undefined}).flatMap(d=>d.elegiveis).map(e=>e.detalhe?.cpf).filter(Boolean)).size>1)return {falaAssinada:['Há cadastros diferentes com esse nome. Preciso identificar o paciente antes de preparar notas.'],dados:{ok:false,motivo:'PACIENTE_AMBIGUO'}};
        let jaFaturadas=0,bloqueadas=0;
        for(const d of selecionados) {
          const pendentes:typeof d.elegiveis=[];
          for(const e of d.elegiveis) {
            const estado=await lotes.situacaoConsulta(c.medicoId,'amplimed',e.idExterno);
            if(estado==='ja_faturada')jaFaturadas++;
            else if(estado==='bloqueada')bloqueadas++;
            else pendentes.push(e);
          }
          d.elegiveis=pendentes;
        }
        const total=selecionados.reduce((n,d)=>n+d.elegiveis.length,0);
        const porDia=[...selecionados].reverse().filter(d=>d.elegiveis.length).map(d=>`${br(d.data)}: ${d.elegiveis.map(e=>`${e.paciente} às ${horarioConsulta(e.dataHora)??'horário não identificado'} - ${(e.valorCentavos/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}`).join(', ')}`);
        const escopo=diaSelecionado?`Em ${br(diaSelecionado)}`:`De ${br(desde)} a ${br(fimPeriodo??hoje)}`;
        const alvo=selecao.paciente?` do paciente ${selecao.paciente.nome}`:"";
        const fala=total
          ? [`${escopo} vi ${total} atendimento${total>1?'s':''} finalizado${total>1?'s':''} com cobrança particular. ${porDia.join('. ')}. Se quiser, preparo a emissão dessas notas e você confirma antes.`]
          : [`${escopo} não encontrei atendimento finalizado com cobrança particular${alvo} sem nota e livre para preparar na sua agenda Amplimed. Não preparei notas de outras pessoas.`];
        if(jaFaturadas)fala.push(jaFaturadas===1?'1 já tem nota autorizada e ficou fora da lista.':`${jaFaturadas} já têm nota autorizada e ficaram fora da lista.`);
        if(bloqueadas)fala.push(bloqueadas===1?'1 atendimento já tem uma tentativa de emissão registrada. A nota existente continua preservada. Se quiser, posso conferir o status dessa tentativa para você.':`${bloqueadas} atendimentos já têm tentativas de emissão registradas. As notas existentes continuam preservadas. Se quiser, posso conferir o status dessas tentativas para você.`);
        return {dados:{ferramenta:'listar_pendencias',ok:true,total,desde,jaFaturadas,bloqueadas},falaAssinada:fala,falaMemoria:fala};
      }
      if(decisao.acao==='iniciar_lote') {
        await criarRetroativo(c.narrar,decisao,c.medicoId,undefined,c.fatos.agenda.nome?.toLowerCase()==='amplimed'?'amplimed':'tribemd',selecao)?.iniciar(c.medicoId,c.conversa,c.chave,c.agora,desde,fimDoDia);
        return {jaRespondida:true};
      }
      const r=await listarPendencias(c.medicoId,c.fatos.agenda,c.agora,desde);
      console.info('FERRAMENTA_AGENDA_RESULTADO '+JSON.stringify({medicoId:c.medicoId,ferramenta:'listar_pendencias',ok:r.ok,total:'total' in r?r.total:undefined}));
      if(!r.ok) return {dados:{ferramenta:'listar_pendencias',ok:false,motivo:r.motivo}};
      const lista=formatarPendencias(r,desde,'',2);
      return {dados:{ferramenta:'listar_pendencias',ok:true,total:'total' in r?r.total:undefined,desde},falaAssinada:lista.fala,falaMemoria:lista.falaMemoria};
    }
  };

  const comunicarMedico = (medicoId: string, chaveProcessamento: string, texto?: string, dataMensagem?: string | null, chaveConversa?: string, chaveWhatsApp?: import('./whatsapp/marcar-mensagem-lida.js').ChaveMensagemLeitura, eventoAgenda?: import('./cofre/links.js').ConclusaoAgenda & { chavesConversa: string[] }, chavePergunta?: string, enviadaEm?: string | null) => {
    const agora = new Date();
    return processarComunicacaoMedico({ medicoId, chaveProcessamento, agora, chaveConversa, eventoAgenda, chavePergunta,
      ...(texto !== undefined ? { respostaMedico: { texto, dataMensagem: dataMensagem ?? null, enviadaEm } } : {})
    }, { ferramentas:ferramentasConversa, ativo: config.comunicacaoMedicoAtiva === true, memoriaConversa, memoriaPersistida, conversador, interpretadorSemantico, conversaLivreAtiva: config.conversaLivreAtiva === true, orcamentoChamadas: config.conversaAgenteAtiva ? 6 : 2,
      aoReagir: chaveWhatsApp ? async reacao => { await comunicacaoHomologacao.reagir(medicoId, chaveWhatsApp, reacao); } : undefined,
      aoConversar: async (fala, chave, falaMemoria) => { await comunicacaoHomologacao.conversa({ medicoId, fala, chave, conversa: chaveConversa, falaMemoria }); },
      extratorResposta: new ExtratorRespostaMedicoNvidia(iaApiKey, iaModeloTexto, completarIa), historico: historicoComunicacao,
      tratarCofre: async (id, mensagem) => cofres.links ? cofres.links.tratarMensagem(id, mensagem,
        textoSeguro => new ExtratorRespostaMedicoNvidia(iaApiKey, iaModeloTexto, completarIa).classificarAgenda(textoSeguro)) : false,
      aoDecidir: config.envioMedicoRealAtivo ? async (acao, chave, contexto) => {
        if (acao.tipo === 'boas_vindas' && contexto?.nomeMedico) {
          const resultado = await comunicacaoHomologacao.boasVindas({ medicoId, nomeMedico: contexto.nomeMedico, ultimaNota: acao.ultimaNota });
          if (resultado === 'enviado') await contextoPendencias.perguntarData(medicoId);
          return;
        }
        if (acao.tipo === 'pedir_agenda' && acao.agendaInformada === 'tribemd') { await cofres.links?.solicitarLinkCofre(medicoId, 'tribemd'); return; }
        if (acao.tipo === 'pedir_agenda') await comunicacaoHomologacao.medico({ medicoId, acao: 'pedir_agenda', chave });
      } : undefined,
      lerEstado: async (id, instante) => lerEstadoComunicacaoMedico(pool, id, instante, await cofres.statusAgenda(id), config.preparacaoFiscalAtiva === true),
      log: (nivel, mensagem) => nivel === 'info' ? console.info(mensagem) : registrarLinhaSincrona(mensagem)
    });
  };
  const aoConectarWhatsapp = (medicoId: string) => {
    void comunicarMedico(medicoId, 'onboarding');
    void (async () => {
    const { rows } = await pool.query("select nome_instancia from whatsapp_instancias where medico_id=$1 and oficial=false and status='conectado' limit 1", [medicoId]);
    if(rows[0]?.nome_instancia)await sincronizarHistoricoInstancia(rows[0].nome_instancia);
    })().catch(() => console.warn('[WhatsApp]', {codigo:'HISTORICO_POS_CONEXAO_FALHOU'}));
  };

  // Healthcheck para o Easypanel
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api/conta/cadastro', criarRouterCadastroPainel({
    pool,repo:cadastroCertificado.repo,
    autenticar: async token => { const { data,error } = await authAdminService.supabaseClient.auth.getUser(token);return error?null:data.user?.id??null; },
  }));
  app.use('/api/whatsapp', criarRouterStatusWhatsapp({
    pool,
    autenticar: async token => { const { data, error } = await authAdminService.supabaseClient.auth.getUser(token); return error ? null : data.user?.id ?? null; },
    consultar: medicoId => consultarStatusInstanciaWhatsapp(pool, {
      medicoId, evolutionUrl: config.evolutionApiUrl, evolutionApiKey: config.evolutionGlobalApiKey,
      aoConectar: aoConectarWhatsapp
    })
  }));

  // API de Emissão de NFS-e (compatível com Focus NFe + Zero-Config)
  const emissaoApiRepo = new PostgresEmissaoApiRepositorio(pool, config.encryptionKey, config.appPepper);
  const emissaoComprovante = config.emissaoComprovanteHomologacaoAtiva === true
    ? new PostgresEmissaoComprovante(pool, config.encryptionKey, config.appPepper) : null;

  // Pós-enfileiramento compartilhado: fluxo direto do comprovante e retomada após conferência de CPF.
  const aposEnfileirar = (medicoId: string, resultado: { solicitacaoId?: string | null }) =>
    aposEnfileirarComprovante({ permissoes: permissoesNoto, emissao: emissaoComprovante, comunicacao: comunicacaoHomologacao,
      log: mensagem => console.info(mensagem) }, medicoId, resultado.solicitacaoId);
  const routerNfse = criarRouterNfse({
    repositorio: emissaoApiRepo,
    autenticar: async token => {
      const { data, error } = await authAdminService.supabaseClient.auth.getUser(token);
      if (!error && data.user?.id) {
        return resolverMedicoId(pool, data.user.id).catch(() => null);
      }
      return resolverMedicoId(pool, token).catch(() => null);
    }
  });
  app.use('/api/v1/nfse', routerNfse);
  app.use('/v2/nfse', routerNfse);
  app.use('/v2/nfsen', routerNfse);

  // UI Web de Entrada e Assets Estáticos
  app.use('/assets', express.static(join(__dirname, 'assets'), OPCOES_ARQUIVOS_ESTATICOS));
  app.get('/', (_req: Request, res: Response) => {
    res.sendFile(join(__dirname, 'ui', 'index.html'));
  });

  // Páginas institucionais simples (Google Console)
  app.get('/sobre', (_req: Request, res: Response) => {
    res.sendFile(join(__dirname, 'ui', 'sobre.html'));
  });
  app.get('/termos', (_req: Request, res: Response) => {
    res.sendFile(join(__dirname, 'ui', 'termos.html'));
  });
  app.get('/privacidade', (_req: Request, res: Response) => {
    res.sendFile(join(__dirname, 'ui', 'privacidade.html'));
  });

  // Verificação de propriedade do domínio no Google Search Console
  app.get('/google7e12f4f1b60db1c4.html', (_req: Request, res: Response) => {
    res.sendFile(join(__dirname, 'ui', 'google7e12f4f1b60db1c4.html'));
  });

  // Rota de Solicitação de OTP (WhatsApp)
  app.post('/api/auth/otp/solicitar', async (req: Request, res: Response) => {
    try {
      const { telefone } = req.body || {};
      if (!telefone) {
        return res.status(400).json({ ok: false, detalhe: 'Telefone é obrigatório' });
      }

      const resultado = await solicitarOtp(telefone, {
        repositorio: otpRepo,
        enviador: evolutionClient,
        pepper: config.appPepper
      });

      if (!resultado.ok) {
        return res.status(400).json(resultado);
      }

      return res.json(resultado);
    } catch (err: any) {
      console.error('Erro na solicitação de OTP:', err);
      return res.status(500).json({ ok: false, detalhe: err?.message || 'Erro interno do servidor' });
    }
  });

  // Rota de Verificação de OTP e Sessão Supabase
  app.post('/api/auth/otp/verificar', async (req: Request, res: Response) => {
    try {
      const { telefone, codigo } = req.body || {};
      if (!telefone || !codigo) {
        return res.status(400).json({ ok: false, detalhe: 'Telefone e código são obrigatórios' });
      }

      const resultado = await autenticarComOtp(telefone, codigo, {
        otpRepositorio: otpRepo,
        authAdminService,
        pepper: config.appPepper
      });

      if (!resultado.ok) {
        return res.status(401).json(resultado);
      }

      return res.json(resultado);
    } catch (err: any) {
      console.error('Erro na verificação de OTP:', err);
      return res.status(500).json({ ok: false, detalhe: err?.message || 'Erro interno do servidor' });
    }
  });

  const depsOtpEmail = { config, repositorio: new PostgresOtpEmailRepositorio(pool), authAdminService,
    enviador: opcoes.enviadorOtpEmail ?? new EnviarOtpEmailResend(config.resendApiKey, config.loginOtpEmailFrom) };
  const rotasOtpEmail = [
    { caminho: '/api/auth/otp/email/solicitar', processar: (body: Record<string, unknown>) => solicitarOtpEmail(body.email, depsOtpEmail) },
    { caminho: '/api/auth/otp/email/verificar', processar: (body: Record<string, unknown>) => autenticarComOtpEmail(body.email, body.codigo, depsOtpEmail) }
  ];
  for (const { caminho, processar } of rotasOtpEmail) app.post(caminho, async (req: Request, res: Response) => {
    try {
      const resultado = await processar(req.body || {});
      if (resultado.ok) return res.json(resultado);
      const status = resultado.motivo === 'canal_desativado' ? 404 : resultado.motivo === 'email_nao_permitido' ? 403
        : caminho.endsWith('/verificar') ? 401 : 400;
      return res.status(status).json(resultado);
    } catch {
      console.error('LOGIN_OTP_EMAIL_FALHOU');
      return res.status(500).json({ ok: false, motivo: 'otp_email_indisponivel' });
    }
  });

  // --- ROTAS DO ONBOARDING MÉDICO (5 PASSOS) ---

  // Passo 0: Status Geral do Onboarding
  app.get('/api/onboarding/status', async (req: Request, res: Response) => {
    try {
      const medicoIdRaw = String(req.query['medicoId'] || '');
      if (!medicoIdRaw) {
        return res.status(400).json({ ok: false, detalhe: 'medicoId é obrigatório' });
      }
      const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
      if (!token) return res.status(401).json({ ok: false, detalhe: 'Autenticação necessária' });
      const { data: identidade, error: erroAuth } = await authAdminService.supabaseClient.auth.getUser(token);
      if (erroAuth || !identidade.user) return res.status(401).json({ ok: false, detalhe: 'Sessão inválida' });
      const medicoId = await resolverMedicoId(pool, medicoIdRaw);
      const vinculo = await pool.query(
        'select m.id from medicos m join usuarios u on u.id = m.usuario_id where m.id = $1 and u.auth_user_id = $2 and u.ativo = true',
        [medicoId, identidade.user.id]
      );
      if (!vinculo.rowCount) return res.status(403).json({ ok: false, detalhe: 'Cadastro não autorizado' });
      res.setHeader('Cache-Control', 'no-store');
      let status = await consultarStatusOnboarding(pool, medicoId, config.preparacaoFiscalAtiva);
      // Reconcile an outdated local record before asking an already linked user to pair again.
      if (status.passos.passo3CertificadoValido && !status.passos.passo4WhatsappConectado) {
        const conexao = await consultarStatusInstanciaWhatsapp(pool, {
          medicoId,
          evolutionUrl: config.evolutionApiUrl,
          evolutionApiKey: config.evolutionGlobalApiKey,
          aoConectar: aoConectarWhatsapp
        });
        if (conexao.ok && conexao.conectado) {
          status = await consultarStatusOnboarding(pool, medicoId, config.preparacaoFiscalAtiva);
        }
      }

      return res.json({ ok: true, status, medicoId });
    } catch (err: any) {
      return res.status(500).json({ ok: false, detalhe: err?.message || 'Erro ao consultar status' });
    }
  });

  // Passo 1: Nome do Médico / Usuário
  app.post('/api/onboarding/nome', async (req: Request, res: Response) => {
    try {
      const { usuarioId, medicoId: medicoIdRaw, nome } = req.body || {};
      if (!nome || typeof nome !== 'string' || nome.trim().length < 2) {
        return res.status(400).json({ ok: false, detalhe: 'Nome completo é obrigatório' });
      }
      const nomeLimpo = nome.trim();
      if (usuarioId) {
        await pool.query('update usuarios set nome = $2, atualizado_em = now() where id = $1', [usuarioId, nomeLimpo]);
      }
      let medicoIdFinal = medicoIdRaw;
      if (medicoIdRaw || usuarioId) {
        try {
          medicoIdFinal = await resolverMedicoId(pool, medicoIdRaw || usuarioId);
          await pool.query('update medicos set nome_completo = $2, atualizado_em = now() where id = $1', [medicoIdFinal, nomeLimpo]);
        } catch {
          // Mantém medicoIdRaw se não conseguir resolver
        }
      }
      return res.json({ ok: true, nome: nomeLimpo, medicoId: medicoIdFinal });
    } catch (err: any) {
      return res.status(500).json({ ok: false, detalhe: err?.message || 'Erro ao salvar nome' });
    }
  });

  // Atualizar Perfil do Médico (Nome, CRM, RQE) na aba Conta
  app.post('/api/conta/perfil', async (req: Request, res: Response) => {
    try {
      const { usuarioId, medicoId: medicoIdRaw, nome, crm, rqe, email } = req.body || {};
      const medicoIdFinal = await resolverMedicoId(pool, medicoIdRaw || usuarioId);

      const perfil = await salvarPerfilProfissional(pool, { medicoId: medicoIdFinal, usuarioId, nome, crm, rqe, email });
      await dadosProfissionais.retomar(medicoIdFinal);
      return res.json({ ok: true, ...perfil });
    } catch (err: any) {
      if (err instanceof ZodError) return res.status(400).json({ ok: false, detalhe: err.issues[0]?.message });
      if (err?.code === '23505') return res.status(409).json({ ok: false, detalhe: 'Este e-mail já está associado a outra conta.' });
      if (err instanceof ErroPerfilProfissional) return res.status(400).json({ ok: false, detalhe: err.message });
      return res.status(500).json({ ok: false, detalhe: err?.message || 'Erro ao atualizar perfil' });
    }
  });

  // Atualizar Preferências do Médico (ex: solicitar CPF direto para o paciente ou médico)
  app.post('/api/conta/preferencias', async (req: Request, res: Response) => {
    try {
      const { usuarioId, medicoId: medicoIdRaw, solicitarCpfDiretoPaciente } = req.body || {};
      const medicoIdFinal = await resolverMedicoId(pool, medicoIdRaw || usuarioId);
      const resultado = await salvarPreferenciasMedico(pool, {
        medicoId: medicoIdFinal,
        solicitarCpfDiretoPaciente: Boolean(solicitarCpfDiretoPaciente)
      });
      return res.json({ ok: true, ...resultado });
    } catch (err: any) {
      return res.status(400).json({ ok: false, detalhe: err?.message || 'Erro ao salvar preferências' });
    }
  });

  // Nova consulta usando o A1 já armazenado; nenhuma cidade é fixada no código.
  app.post('/api/onboarding/buscar-referencia', async (req: Request, res: Response) => {
    try {
      if (!req.body?.medicoId) return res.status(400).json({ ok: false, detalhe: 'Médico não informado.' });
      const medicoId = await resolverMedicoId(pool, req.body.medicoId);
      const certificado = await carregarCertificadoMedico(pool, authAdminService.supabaseClient, medicoId);
      if (!certificado) throw new Error('Cadastre seu certificado A1 para localizar a nota.');
      const titular = extrairChavesCertificado(certificado.pfxBuffer, certificado.senhaCertificado);
      if (!titular.documentoTitular || !titular.validoAte || titular.validoAte < new Date()
        || (titular.validoDe && titular.validoDe > new Date())) throw new Error('O certificado precisa estar válido e identificar seu titular.');
      const consulta = await adnNfseClient.buscarNfseMaisRecente(certificado.pfxBuffer, certificado.senhaCertificado, titular.documentoTitular);
      console.info('[ADN] Busca de referência concluída:', consulta.resumo);
      const existente = await pool.query('select confirmado_pelo_medico from medico_perfil_fiscal where medico_id = $1', [medicoId]);
      const somenteReferencia = existente.rows[0]?.confirmado_pelo_medico === true;
      const fiscal = await processarOnboardingXml({
        pool, supabase: authAdminService.supabaseClient, somenteReferencia,
        documentoTitularEsperado: titular.documentoTitular, chaveCriptografia: config.encryptionKey, pepperCpf: config.appPepper
      },
        medicoId, consulta.documento.xml);
      const adocaoFiscal = somenteReferencia ? { ok: false, codigo: 'REVISAO_EXPLICITA_NECESSARIA' } : await adotarReferenciaConsentida({ pool, preparacaoFiscalAtiva: Boolean(config.preparacaoFiscalAtiva) },
        medicoId, fiscal.parametros.dadosReformaTributaria.hash);

      return res.json({ ...fiscal, medicoId, fonte: 'adn', nsu: consulta.documento.nsu, adocaoFiscal });
    } catch (erro: any) {
      console.warn('[ADN] Busca de referência pendente:', { etapa: 'busca_referencia', codigo: erro?.codigo || 'BUSCA_FALHOU', diagnostico: erro?.diagnostico, mensagem: erro?.message });
      return res.status(400).json({ ok: false, detalhe: 'Não foi possível buscar sua nota pelo certificado. Tente novamente ou envie o XML como alternativa.' });
    }
  });

  // Passo 3 (fallback): Upload e extracao manual do XML de referencia
  app.post('/api/onboarding/xml', async (req: Request, res: Response) => {
    try {
      const { medicoId: medicoIdRaw, xmlString } = req.body || {};
      if (!medicoIdRaw || !xmlString) {
        return res.status(400).json({ ok: false, detalhe: 'medicoId e xmlString são obrigatórios' });
      }
      const medicoId = await resolverMedicoId(pool, medicoIdRaw);
      const certificado = await carregarCertificadoMedico(pool, authAdminService.supabaseClient, medicoId);
      if (!certificado) throw new Error('Cadastre o certificado A1 antes de importar a nota de referência.');
      const documentoTitularEsperado = extrairChavesCertificado(certificado.pfxBuffer, certificado.senhaCertificado).documentoTitular;
      if (!documentoTitularEsperado) throw new Error('Não foi possível identificar o titular do certificado.');
      const resultado = await processarOnboardingXml(
        {
          pool,
          documentoTitularEsperado,
          supabase: authAdminService.supabaseClient,
          chaveCriptografia: config.encryptionKey,
          pepperCpf: config.appPepper
        },
        medicoId,
        xmlString
      );
      return res.json({ ...resultado, medicoId });
    } catch (err: any) {
      console.error('Erro na extração do XML:', err);
      return res.status(400).json({ ok: false, detalhe: err?.message || 'Falha ao processar XML' });
    }
  });

  // Passo 3: Confirmacao dos parametros fiscais encontrados
  app.post('/api/onboarding/confirmar-fiscal', async (req: Request, res: Response) => {
    try {
      const {
        medicoId: medicoIdRaw,
        razaoSocial,
        especialidade,
        aliquotaIss,
        serieDps,
        proximoNumeroDps,
        opcaoSimplesNacional,
        parametrosEmissao,
        referenciaHash,
        usarReferencia
      } = req.body || {};
      if (!medicoIdRaw) {
        return res.status(400).json({ ok: false, detalhe: 'medicoId é obrigatório' });
      }
      const medicoId = await resolverMedicoId(pool, medicoIdRaw);
      await confirmarParametrosFiscais(pool, usarReferencia === true ? { medicoId, referenciaHash, usarReferencia: true } : {
        medicoId,
        razaoSocial,
        especialidade,
        aliquotaIss: aliquotaIss !== undefined ? Number(aliquotaIss) : undefined,
        serieDps,
        proximoNumeroDps: proximoNumeroDps !== undefined ? Number(proximoNumeroDps) : undefined,
        opcaoSimplesNacional,
        parametrosEmissao,
        referenciaHash,
        usarReferencia: usarReferencia === true
      });

      await comunicarMedico(medicoId, 'confirmacao_fiscal');
      return res.json({ ok: true, mensagem: 'Parâmetros fiscais confirmados com sucesso', medicoId });
    } catch (err: any) {
      if (req.body?.usarReferencia === true) {
        console.warn('[Fiscal] Adoção da referência pendente:', { codigo: err?.codigo || 'CONFIRMACAO_FALHOU', diagnostico: err?.diagnostico, mensagem: err?.message });
        if (err instanceof ErroAdocaoReferencia) return res.status(400).json({ ok: false, codigo: err.codigo, detalhe: err.message });
        return res.status(400).json({ ok: false, detalhe: 'Ainda não conseguimos adotar a configuração completa dessa nota. Busque a referência novamente. Se persistir, a equipe precisa analisar o caso antes de liberar a emissão.' });
      }
      return res.status(400).json({
        ok: false, detalhe: Array.isArray(err?.issues)
          ? err.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`).join('; ')
          : err?.message || 'Erro ao confirmar parâmetros fiscais'
      });
    }
  });

  // Passo 2: Certificado A1 + importacao automatica da ultima NFS-e pelo ADN
  app.post('/api/onboarding/certificado', async (req: Request, res: Response) => {
    try {
      const { medicoId: medicoIdRaw, arquivoBase64, nomeArquivo, senha, consentimentoFiscal } = req.body || {};
      if (consentimentoFiscal !== undefined && consentimentoFiscal !== versaoConsentimentoFiscal) {
        return res.status(400).json({ ok: false, detalhe: 'Atualize a página antes de continuar com o certificado.' });
      }
      if (!medicoIdRaw || !arquivoBase64 || !senha) {
        return res.status(400).json({ ok: false, detalhe: 'medicoId, arquivo e senha são obrigatórios' });
      }
      const medicoId = await resolverMedicoId(pool, medicoIdRaw);
      const arquivoBuffer = Buffer.from(arquivoBase64, 'base64');

      let documentoTitular: string | undefined;
      try {
        const certificado = extrairChavesCertificado(arquivoBuffer, senha);
        if (certificado.validoAte && certificado.validoAte.getTime() < Date.now()) {
          return res.status(400).json({ ok: false, detalhe: 'O certificado A1 informado esta vencido.' });
        }
        documentoTitular = certificado.documentoTitular;
      } catch (err: any) {
        return res.status(400).json({
          ok: false,
          detalhe: `Certificado A1 ou senha invalidos: ${err?.message || 'nao foi possivel abrir o arquivo'}`
        });
      }

      const resultado = await salvarCertificadoMedico(pool, authAdminService.supabaseClient, {
        medicoId,
        arquivoBuffer,
        nomeArquivoOriginal: nomeArquivo || 'certificado.pfx',
        senhaCertificado: senha
      });

      await cadastroCertificado.agendar({medicoId, certificadoId:resultado.certificadoId, documentoTitular}).catch(() =>
        console.warn('[Cadastro automático]', {codigo:'AGENDAMENTO_FALHOU'}));

      if (consentimentoFiscal === versaoConsentimentoFiscal) {
        await registrarConsentimentoFiscal(pool, medicoId, resultado.certificadoId);
      }

      try {
        if (!documentoTitular) {
          throw new Error('Nao foi possivel identificar o CPF/CNPJ do titular no certificado A1.');
        }
        const consulta = await adnNfseClient.buscarNfseMaisRecente(arquivoBuffer, senha, documentoTitular);
        console.info('[ADN] Busca de referência concluída:', consulta.resumo);
        const fiscal = await processarOnboardingXml(
          {
            pool,
            documentoTitularEsperado: documentoTitular,
            supabase: authAdminService.supabaseClient,
            chaveCriptografia: config.encryptionKey,
            pepperCpf: config.appPepper
          },
          medicoId,
          consulta.documento.xml
        );

        const adocaoFiscal = await adotarReferenciaConsentida({ pool, preparacaoFiscalAtiva: Boolean(config.preparacaoFiscalAtiva) },
          medicoId, fiscal.parametros.dadosReformaTributaria.hash);

        return res.json({
          ...resultado,
          medicoId,
          adocaoFiscal,
          importacaoFiscal: {
            ...fiscal,
            fonte: 'adn',
            nsu: consulta.documento.nsu,
            chaveAcesso: consulta.documento.chaveAcesso
          }
        });
      } catch (err: any) {
        console.warn('[ADN] Importacao automatica indisponivel:', { etapa: 'importacao_referencia', codigo: err?.codigo || 'IMPORTACAO_FALHOU', diagnostico: err?.diagnostico, mensagem: err?.message });
        return res.json({
          ...resultado,
          medicoId,
          importacaoFiscal: {
            ok: false,
            codigo: err?.codigo || 'IMPORTACAO_FALHOU',
            diagnostico: err?.diagnostico,
            detalhe: 'Não foi possível buscar sua nota pelo certificado. Tente novamente ou envie o XML como alternativa.'
          }
        });
      }
    } catch (err: any) {
      console.error('Erro ao salvar certificado:', err);
      return res.status(500).json({ ok: false, detalhe: err?.message || 'Erro ao processar certificado digital' });
    }
  });

  // Passo 4: Conectar WhatsApp do Consultório (Evolution API)
  app.post('/api/onboarding/whatsapp/iniciar', async (req: Request, res: Response) => {
    try {
      const { medicoId: medicoIdRaw, telefoneConsultorio, modoConexao } = req.body || {};
      if (modoConexao !== undefined && modoConexao !== 'codigo' && modoConexao !== 'qrcode') {
        return res.status(400).json({ ok: false, detalhe: 'Modo de conexão inválido.' });
      }
      if (!medicoIdRaw) {
        return res.status(400).json({ ok: false, detalhe: 'medicoId é obrigatório' });
      }
      const medicoId = await resolverMedicoId(pool, medicoIdRaw);
      const revisaoProfissional = await cadastroCertificado.repo.revisaoPainel(medicoId);
      if (!revisaoProfissional.aprovado) return res.status(409).json({ ok: false,
        codigo: 'DADOS_PROFISSIONAIS_PENDENTES', detalhe: 'Revise e aprove seus dados profissionais antes de conectar o WhatsApp.' });

      const appUrl = origemWebhookConfigurada(config.appPublicOrigin);
      if (!appUrl) return res.status(503).json({ ok: false,
        codigo: 'ORIGEM_WEBHOOK_NAO_CONFIGURADA', detalhe: 'Conexão indisponível: a origem pública do aplicativo precisa ser configurada.' });

      const resultado = await conectarInstanciaWhatsappMedico(pool, {
        medicoId,
        telefoneConsultorio,
        modoConexao,
        evolutionUrl: config.evolutionApiUrl,
        evolutionApiKey: config.evolutionGlobalApiKey,
        appWebhookUrl: appUrl,
        webhookSecret: config.evolutionWebhookSecret,
        aoConectar: aoConectarWhatsapp
      });

      if (resultado.diagnostico) {
        console.warn('[WhatsApp] Conexão pendente:', {
          medicoId, modoConexao: modoConexao || 'codigo', diagnostico: resultado.diagnostico
        });
      }
      return res.json({ ...resultado, medicoId });
    } catch (err: any) {
      console.error('Erro ao iniciar conexão WhatsApp:', err);
      return res.status(500).json({ ok: false, detalhe: err?.message || 'Erro ao conectar WhatsApp' });
    }
  });

  // Consulta status de conexão do WhatsApp na Evolution API em tempo real
  app.get('/api/onboarding/whatsapp/status', async (req: Request, res: Response) => {
    try {
      const medicoIdRaw = (req.query['medicoId'] as string)?.trim();
      if (!medicoIdRaw) {
        return res.status(400).json({ ok: false, detalhe: 'medicoId é obrigatório' });
      }
      const medicoId = await resolverMedicoId(pool, medicoIdRaw);
      const resultado = await consultarStatusInstanciaWhatsapp(pool, {
        medicoId,
        evolutionUrl: config.evolutionApiUrl,
        evolutionApiKey: config.evolutionGlobalApiKey,
        aoConectar: aoConectarWhatsapp
      });

      return res.json({ ...resultado, medicoId });
    } catch (err: any) {
      return res.status(500).json({ ok: false, detalhe: err?.message || 'Erro ao consultar status do WhatsApp' });
    }
  });

  // Rota Webhook da Evolution API (suporta rota direta e subrotas com eventos)
  const webhookHandler = async (req: Request, res: Response) => {
    const referencia = randomUUID(), inicio = Date.now();
    console.info('[Webhook Evolution]', { etapa: 'recebido', referencia, ...diagnosticoEntradaWebhook(req.body) });
    try {
      const tokenRecebido =
        (req.headers['apikey'] as string) ||
        (req.headers['x-webhook-secret'] as string) ||
        (req.headers['authorization'] as string) ||
        (req.query['secret'] as string) ||
        (req.query['apikey'] as string) ||
        (req.query['token'] as string);

      // Autentica com segredo do webhook ou API key global da Evolution (oficial ou assistente)
      let segredoEsperado = config.evolutionWebhookSecret;
      if (
        tokenRecebido &&
        (tokenRecebido === config.evolutionGlobalApiKey ||
          tokenRecebido === config.evolutionWebhookSecret ||
          tokenRecebido === config.evolutionAssistantApiKey ||
          tokenRecebido === config.evolutionAssistantWebhookSecret)
      ) {
        segredoEsperado = tokenRecebido;
      }

      const resultado = await processarMensagemWebhook(req.body, tokenRecebido, {
        repositorio: atendimentoRepo,
        reservarMensagemMedico: (medicoId, instancia, mensagemId) => comunicacaoHomologacao.reservarEntradaMedico(medicoId, instancia, mensagemId),
        segredoConfigurado: segredoEsperado,
        pepper: config.appPepper,
        consultaCpfProvider: hubCpfClient,
        instanciaOficialNome: config.evolutionOfficialInstanceName,
        instanciaAssistenteNome: config.evolutionAssistantInstanceName,
        comunicacaoMedicoAtiva: config.comunicacaoMedicoAtiva,
        aoReceberMensagemMedico: async contexto => {
          if (emissaoComprovante && config.envioMedicoRealAtivo && permissoesNoto && await permissoesCpfAtivaP) {
            // Conferência de CPF antes de qualquer interpretação de confirmação de emissão: só resposta vinculada à pergunta conta.
            const retomadaDeps: RetomadaDeps = {
              pool, encryptionKey: config.encryptionKey, pepper: config.appPepper, comunicacao: comunicacaoHomologacao,
              lerEstado: atendimentoRepo.lerEstado.bind(atendimentoRepo),
              extratorPara: instancia => new ExtratorComprovanteNvidia(iaApiKey, iaModeloVisao,
                mensagem => evolutionClient.obterBase64MensagemMidia(instancia, mensagem.key.id), completarIa),
              enfileirar: entrada => emissaoComprovante.enfileirar(entrada),
              fonteAgenda: { consultar: async entrada =>
                (await cofres.statusAgenda(entrada.medicoId)).nome?.toLowerCase() === 'tribemd'
                  ? sincronizarAgendaHomologacao(entrada.medicoId, entrada.agora, entrada.janelaDias)
                  : cofres.fonteAgenda.consultar(entrada) },
              consultaJaFaturada: (fonte, id) => emissaoComprovante.consultaJaFaturada(contexto.medicoId, fonte, id),
              aposEnfileirar,
            };
            if (await processarRespostaMedicoCpf(retomadaDeps,
              { medicoId: contexto.medicoId, texto: contexto.texto, chavePergunta: contexto.chavePergunta }) === 'consumida') return;
          }
          if (config.conversaLivreAtiva) await comunicacaoHomologacao.marcarLida(contexto.medicoId, contexto.chaveWhatsApp);
          if (config.conversaLivreAtiva && contemCredencialAgenda(contexto.texto)) return comunicarMedico(contexto.medicoId, `assistente:${contexto.chaveMensagem}`, contexto.texto, contexto.dataMensagem, contexto.chaveConversa, contexto.chaveWhatsApp, undefined, contexto.chavePergunta, contexto.enviadaEm);
          if (retroativo && await lotePermitido(contexto.medicoId) && await lotes.ativo(contexto.medicoId)) return comunicarMedico(contexto.medicoId, `assistente:${contexto.chaveMensagem}`, contexto.texto, contexto.dataMensagem, contexto.chaveConversa, contexto.chaveWhatsApp, undefined, contexto.chavePergunta, contexto.enviadaEm);
          if (emissaoComprovante && config.envioMedicoRealAtivo) {
            const pendentes = await emissaoComprovante.buscarConfirmacoes(contexto.medicoId);
            if (pendentes.length) {
              const unica = pendentes.length === 1 ? pendentes[0] : null;
              const c = unica?.confirmacao;
              const pergunta = c?.paciente && c?.dataEnvioPagamento && c?.dataConsulta
                ? `Autoriza emitir a nota de ${c.paciente}, pagamento enviado em ${c.dataEnvioPagamento}, consulta de ${c.dataConsulta}?` : 'Não há uma oportunidade única vinculada a uma pergunta de emissão.';
              const usarDecisor = config.conversaLivreAtiva && conversador && await comunicacaoHomologacao.medicoPermitido(contexto.medicoId);
              const memoriaConfirmacao = usarDecisor ? await memoriaPersistida!.lerContextoParaModelo(contexto.medicoId,contexto.chaveConversa) : null;
              const interpretacao = usarDecisor ? confirmacaoDaDecisao(await conversador.responder({texto:contexto.texto,mensagens:memoriaConfirmacao!.historicoRecente,
                resumo:memoriaConfirmacao!.resumo?.resumo??null,agora:new Date(),acoesPermitidas:['nenhuma'],
                fatos:{ambiente:'homologacao',agenda:{nome:null,conectada:false},link:{ativo:false,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:false,
                  lote:{estado:'aguardando_confirmacao_individual',pergunta,perguntaId:c?.perguntaChave},pendentes:pendentes.length}
              }))
                : await interpretarConfirmacaoEmissao(iaApiKey, iaModeloTexto, completarIa, { texto: contexto.texto, pergunta });
              const resultado = await emissaoComprovante.confirmar(contexto.medicoId, contexto.chaveMensagem, limitarConfirmacaoEmissao(contexto.texto, interpretacao), new Date(),
                await comunicacaoHomologacao.medicoPermitido(contexto.medicoId), c?.perguntaChave ?? '', contexto.chavePergunta);
              if (resultado.motivo === 'CONFIRMACAO_INSUFICIENTE' && unica && c?.envio === 'enviado' && c?.dataEnvioPagamento && c?.dataConsulta && c?.paciente) {
                const envio = await comunicacaoHomologacao.confirmarEmissao({ medicoId: contexto.medicoId, solicitacaoId: unica.id,
                  chaveDisparo: `${unica.id}:${contexto.chaveMensagem}`, paciente: c.paciente, dataEnvioPagamento: c.dataEnvioPagamento, dataConsulta: c.dataConsulta });
                await emissaoComprovante.registrarPergunta(contexto.medicoId, unica.id, envio.resultado, envio.chaveMensagem, new Date());
                return;
              }
              const fala = resultado.liberada ? 'Confirmação registrada. A emissão está liberada para processamento.'
                : resultado.motivo === 'RECUSADA' ? 'Não vou emitir essa nota.'
                : resultado.motivo === 'EXPIRADA' ? 'A confirmação dessa oportunidade venceu após 48 horas. Não liberei a emissão.'
                : resultado.motivo === 'MULTIPLAS_PENDENTES' ? 'Há mais de uma nota aguardando confirmação. Preciso que elas sejam conferidas antes de liberar uma emissão.'
                : 'Não consegui confirmar sua autorização com segurança. Você autoriza a emissão da nota dessa oportunidade?';
              await comunicacaoHomologacao.conversa({ medicoId: contexto.medicoId, chave: `confirmacao:${contexto.chaveMensagem}`, fala: [fala] });
              return;
            }
          }
          return comunicarMedico(contexto.medicoId, `assistente:${contexto.chaveMensagem}`, contexto.texto, contexto.dataMensagem, contexto.chaveConversa, contexto.chaveWhatsApp, undefined, contexto.chavePergunta, contexto.enviadaEm);
        },
        aoReceberRespostaCpf: async contexto => {
          if (!await permissoesCpfAtivaP) return;
          await processarRespostaCpfPaciente({ pool, encryptionKey: config.encryptionKey, comunicacao: comunicacaoHomologacao }, contexto);
        },
        aoReceberComprovante: contexto => orquestrarComprovante(contexto, {
          buscarCpfConversa: !permissoesNoto ? undefined : async (medicoId, pacienteId) =>
            await permissoesCpfAtivaP ? buscarCpfConversa(pool, medicoId, pacienteId) : { tipo: 'sem_conversa' as const },
          aoCpfAusente: !permissoesNoto ? undefined : async (medicoId, busca) => {
            if (!await permissoesCpfAtivaP) return;
            // CPF ausente em todas as fontes verificadas: pergunta ao médico a quem recorrer, uma única vez, por link.
            if (await permissoesNoto!.ler(medicoId, 'solicitar_cpf').catch(() => null)) return;
            if (await permissoesNoto!.linkJaCriado(medicoId, 'solicitar_cpf').catch(() => true)) return;
            const r = await permissoesNoto!.criarLink(medicoId, 'solicitar_cpf').catch(() => null);
            if (!r || 'erro' in r) return;
            const ausencia = busca?.tipo === 'sem_cpf' ? 'não encontrei o CPF do paciente na agenda nem nas mensagens que ele te enviou nos últimos 90 dias'
              : busca?.tipo === 'sem_conversa' ? 'não encontrei o CPF do paciente na agenda, e não há conversa dele aqui para eu procurar'
              : busca?.tipo === 'ambiguos' ? 'encontrei mais de um CPF nas mensagens que ele te enviou nos últimos 90 dias e não sei qual é o dele'
              : busca?.tipo === 'cpf' ? 'encontrei um CPF nas mensagens que ele te enviou nos últimos 90 dias, mas não tenho como confirmar sozinho que é o dele'
              : 'não encontrei o CPF do paciente na agenda';
            const fala = [`Doutor(a), ${ausencia}. Para emitir, preciso dele. Quando isso acontecer, prefere que eu pergunte sempre a você ou direto ao paciente? Escolha no link seguro a seguir.`, r.url];
            await comunicacaoHomologacao.conversa({ medicoId, chave: `link_permissoes:solicitar_cpf:${r.url.slice(-12)}`,
              fala, falaMemoria: [fala[0], '[LINK_SEGURO]'] });
          },
          historico: historicoComunicacao,
          fonteAgenda: config.emissaoComprovanteHomologacaoAtiva ? { consultar: async entrada =>
            (await cofres.statusAgenda(entrada.medicoId)).nome?.toLowerCase() === 'tribemd'
              ? sincronizarAgendaHomologacao(entrada.medicoId, entrada.agora, entrada.janelaDias)
              : cofres.fonteAgenda.consultar(entrada) } : undefined,
          consultaJaFaturada: emissaoComprovante ? (fonte, id) => emissaoComprovante.consultaJaFaturada(contexto.medicoId, fonte, id) : undefined,
          medicoEmFaseInicial: async medicoId => {
            const { rows } = await pool.query('select 1 from notas_fiscais where medico_id = $1 limit 1', [medicoId]);
            return rows.length === 0;
          },
          aoComunicar: config.envioMedicoRealAtivo ? async (decisao, lido) => {
            if (decisao.tipo === 'perguntar_medico' && decisao.motivo === 'CADASTRO_INCOMPLETO' && permissoesNoto && await permissoesCpfAtivaP) {
              const escolhaCpf = await permissoesNoto.ler(contexto.medicoId, 'solicitar_cpf').catch(() => null);
              if (escolhaCpf?.valor === 'paciente') {
                const est = await atendimentoRepo.lerEstado(contexto.medicoId, contexto.pacienteId).catch(() => null);
                const telefone = extrairTelefoneJid(contexto.mensagem.key.remoteJidAlt) || extrairTelefoneJid(contexto.mensagem.key.remoteJid) || '';
                if (est && (!est.paciente.cpf || !validarCpf(est.paciente.cpf)) && telefone) {
                  // Pendência durável primeiro: a resposta só é reconhecida se a pergunta existir.
                  await registrarPerguntaCpf(pool, { medicoId: contexto.medicoId, pacienteId: contexto.pacienteId,
                    comprovanteHash: chaveComprovante(config.appPepper, lido) ?? contexto.mensagem.key.id,
                    comprovanteMensagemId: contexto.mensagem.key.id,
                    valorCentavos: lido?.tipo === 'extraido' ? lido.campos.valorCentavos : null,
                    dataPagamento: lido?.tipo === 'extraido' ? lido.campos.dataPagamento : null }).catch(() => null);
                  await comunicacaoHomologacao.pedirCpfPaciente({ medicoId: contexto.medicoId, pacienteId: contexto.pacienteId, contatoTelefone: telefone,
                    chave: chaveComprovante(config.appPepper, lido) ?? contexto.mensagem.key.id });
                  return;
                }
              }
            }
            if (decisao.tipo === 'perguntar_medico' || decisao.tipo === 'perguntar_pacote' || decisao.tipo === 'pedir_agenda') {
              await comunicacaoHomologacao.medico({ medicoId: contexto.medicoId, acao: decisao.tipo, motivo: decisao.motivo,
                ...(decisao.tipo === 'perguntar_medico' && decisao.detalhe ? { detalhe: decisao.detalhe } : {}),
                ...(decisao.tipo === 'perguntar_medico' && decisao.detalheNota ? { detalheNota: decisao.detalheNota } : {}),
                chave: chaveComprovante(config.appPepper, lido) ?? JSON.stringify([contexto.mensagem.key.remoteJid, contexto.mensagem.key.id]) });
            }
          } : undefined,
          aoDecidir: emissaoComprovante ? async (decisao, lido, estado) => {
            const bruto = Number(contexto.mensagem.messageTimestamp);
            const instanteEnvio = new Date(bruto > 1e11 ? bruto : bruto * 1000);
            const resultado = await emissaoComprovante.enfileirar({ ...contexto, decisao, lido, consulta: estado.consulta,
              dataEnvioPagamento: bruto > 0 && Number.isFinite(instanteEnvio.getTime()) ? instanteEnvio.toISOString() : null });
            if (resultado.tipo === 'perguntar_medico') await comunicacaoHomologacao.medico({ medicoId: contexto.medicoId, acao: 'perguntar_medico', motivo: resultado.motivo,
              chave: chaveComprovante(config.appPepper, lido) ?? contexto.mensagem.key.id });
            if (resultado.tipo === 'enfileirada') await aposEnfileirar(contexto.medicoId, resultado);
          } : undefined,
          lerEstado: atendimentoRepo.lerEstado.bind(atendimentoRepo),
          extrator: new ExtratorComprovanteNvidia(iaApiKey, iaModeloVisao,
            mensagem => evolutionClient.obterBase64MensagemMidia(req.body.instance, mensagem.key.id), completarIa),
          log: (nivel, mensagem) => nivel === 'info' ? console.info(mensagem) : registrarLinhaSincrona(mensagem)
        }),
        async aoAtualizarConexao(evento) {
          if (
            evento.instancia === config.evolutionOfficialInstanceName ||
            evento.instancia === config.evolutionAssistantInstanceName
          ) return;
          const medicoId = await registrarConexaoWhatsapp(pool, evento);
          if (medicoId && evento.state === 'open') {
            await comunicarMedico(medicoId, 'onboarding');
            void sincronizarHistoricoInstancia(evento.instancia).catch(() => console.warn('[WhatsApp]', {codigo:'HISTORICO_POS_CONEXAO_FALHOU'}));
          }
        }
      });

      console.info('[Webhook Evolution]', { etapa: 'concluido', referencia, duracaoMs: Date.now() - inicio, ...diagnosticoResultadoWebhook(resultado) });
      if (!resultado.ok) {
        const status = resultado.motivo === 'autenticacao_invalida' ? 401 : 400;
        return res.status(status).json(resultado);
      }

      return res.json(resultado);
    } catch (erro) {
      console.error('[Webhook Evolution]', { etapa: 'falha', referencia, duracaoMs: Date.now() - inicio, ...diagnosticoErroWebhook(erro) });
      return res.status(500).json({ ok: false, motivo: 'falha_processamento', referencia });
    }
  };

  app.post('/webhook/evolution', webhookHandler);
  app.post('/webhook/evolution/:evento', webhookHandler);

  if (process.env['NODE_ENV'] !== 'test') {
    setTimeout(() => {
      void pool.query(
        `select nome_instancia, medico_id
         from whatsapp_instancias
         where status = 'conectado' and oficial = false`
      ).then(async ({ rows }) => {
        for (const row of rows) {
          try {
            const resultado = await sincronizarHistoricoInstancia(row.nome_instancia);
            console.info('[Evolution] Histórico recuperado ao iniciar:', resultado);
          } catch (erro: any) {
            console.warn('[Evolution] Histórico não recuperado ao iniciar:', erro?.message || erro);
          }
        }
      }).catch((erro: any) => {
        console.warn('[Evolution] Falha ao listar instâncias para histórico:', erro?.message || erro);
      });
    }, 5_000);
  }

  app.use(tratarErrosHttp);

  return app;
}

import { iniciarWorkerEmbutido } from './worker/iniciar-worker-embutido.js';

// Inicia servidor quando executado diretamente
if (process.env['NODE_ENV'] !== 'test') {
  const app = criarAppExpress();
  const servidor = app.listen(config.porta, config.host, () => {
    console.log(`[Notomed Whats] Servidor rodando em http://${config.host}:${config.porta}`);
  });
  servidor.on('error', (erro) => {
    console.error(`[Notomed Whats] Falha ao abrir ${config.host}:${config.porta}:`, erro.message);
    process.exit(1);
  });

  // Inicia worker da fila em segundo plano no mesmo container
  const worker = iniciarWorkerEmbutido(pool, config, app.locals.processarLoteRetroativo);
  console.log('[Notomed Whats] Worker de fila NFS-e iniciado com sucesso.');

  registrarSinaisDeProcesso(process, criarEncerramentoGracioso({
    fecharServidor: async () => {
      // Limpeza do navegador não interrompe a drenagem das requisições do Noto.
      await Promise.allSettled([
        new Promise<void>((resolver) => {
          servidor.close(() => resolver());
          servidor.closeIdleConnections();
        }),
        app.locals.encerrarCofres()
      ]);
    },
    pararWorker: () => worker.parar(),
    fecharPool: () => pool.end()
  }, { tempoLimiteMs: 8_000, sair: (codigo) => process.exit(codigo) }));
}
