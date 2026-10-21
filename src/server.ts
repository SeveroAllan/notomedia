import { sincronizarAgenda } from './agenda/sincronizar-agenda.js';
import { registroErroNoto } from './observabilidade/erros.js';
import { interpretarConfirmacaoEmissao } from './onboarding/confirmacao-emissao-medico.js';
import { PostgresConsultasSincronizadas } from './io/postgres/postgres-consultas-sincronizadas.js';
import { solicitarOtpEmail, autenticarComOtpEmail, type EnviarOtpEmail } from './otp/login-otp-email.js';
import { EnviarOtpEmailResend } from './io/resend/enviar-otp-email.js';
import { chaveComprovante } from './atendimento/comprovante.js';
import { ComunicacaoHomologacao } from './whatsapp/comunicacao-homologacao.js';
import { criarCofreContas } from './cofre/router.js';
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
import { PostgresMemoriaConversaMedico } from './onboarding/conversa-repositorio.js';
import { ConversadorMedico } from './onboarding/conversador-medico.js';
import { MemoriaConversaMedico } from './onboarding/contexto-conversa-medico.js';
import { processarComunicacaoMedico } from './onboarding/processar-comunicacao-medico.js';
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
  const comunicacaoHomologacao = new ComunicacaoHomologacao(pool, config, evolutionAssistantClient);
  const dadosProfissionais = new PostgresDadosProfissionaisService(pool);
  const authAdminService = new SupabaseAuthAdminService(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    pool
  );
  const cofres = criarCofreContas({
    pool, enviarCofre: (id, texto) => comunicacaoHomologacao.cofre(id, texto),
    obterWhatsappAssistente: () => evolutionAssistantClient.obterTelefoneInstancia(),
    aoConcluirAgenda: async (medicoId, evento) => {
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
  app.locals.encerrarCofres = cofres.encerrar;
  app.use(
    express.json({
      limit: '10mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      }
    })
  );
  app.use(express.text({ limit: '10mb', type: ['text/*', 'application/xml'] }));

  const hubCpfClient = config.hubDesenvolvedorToken
    ? new HubDesenvolvedorCpfClient(config.hubDesenvolvedorToken)
    : undefined;
  // Mesma chave OpenAI, com modelo por finalidade.
  const iaApiKey=config.openaiApiKey;
  const completarIa=completarOpenAi;
  const iaModeloTexto=config.openaiTextoModel ?? '';
  const conversador = config.conversaLivreAtiva ? new ConversadorMedico(iaApiKey, iaModeloTexto, completarIa) : undefined;
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
        const resultado = await sincronizarAgenda({ medicoId, referenciaCofre: medicoId, janelaDias, agora }, cofres.fonteAgenda, repo,
          (id, consulta) => repo.resolverPaciente(id, consulta));
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

  const comunicarMedico = (medicoId: string, chaveProcessamento: string, texto?: string, dataMensagem?: string | null, chaveConversa?: string, chaveWhatsApp?: import('./whatsapp/marcar-mensagem-lida.js').ChaveMensagemLeitura, eventoAgenda?: import('./cofre/links.js').ConclusaoAgenda & { chavesConversa: string[] }) => {
    const agora = new Date();
    return processarComunicacaoMedico({ medicoId, chaveProcessamento, agora, chaveConversa, eventoAgenda,
      ...(texto !== undefined ? { respostaMedico: { texto, dataMensagem: dataMensagem ?? null } } : {})
    }, { ativo: config.comunicacaoMedicoAtiva === true, memoriaConversa, memoriaPersistida, conversador, conversaLivreAtiva: config.conversaLivreAtiva === true,
      aoReagir: chaveWhatsApp ? async reacao => { await comunicacaoHomologacao.reagir(medicoId, chaveWhatsApp, reacao); } : undefined,
      aoConversar: async (fala, chave, falaMemoria) => { await comunicacaoHomologacao.conversa({ medicoId, fala, chave, conversa: chaveConversa, falaMemoria }); },
      extratorResposta: new ExtratorRespostaMedicoNvidia(iaApiKey, iaModeloTexto, completarIa), historico: historicoComunicacao,
      listarConsultasSemNota: async (id, agenda, instante) => {
        const nomesAoVivo = new Map<string, string | null>();
        let sincronizacaoConcluida = false;
        if (agenda.conectada && agenda.nome?.toLowerCase() === 'tribemd') {
          const sincronizada = await sincronizarAgendaHomologacao(id, instante);
          if (sincronizada.tipo === 'erro') return { ok: false, motivo: sincronizada.codigo };
          sincronizacaoConcluida = true;
          for (const consulta of sincronizada.consultas) nomesAoVivo.set(consulta.idExterno, consulta.nomeAoVivo ?? null);
        }
        return new PostgresConsultasSincronizadas(pool).listarConsultasSemNota(id, agenda, instante,
          (fonte, consultaId) => new PostgresEmissaoComprovante(pool, '', config.appPepper).consultaJaFaturada(id, fonte, consultaId),
          consultaId => nomesAoVivo.get(consultaId) ?? null, sincronizacaoConcluida);
      },
      enviarLinkCofreAgenda: async id => cofres.links ? cofres.links.solicitarLinkCofre(id, 'tribemd') : { ok: false, motivo: 'COFRE_INDISPONIVEL' },
      lerContextoConexao: cofres.links ? (id, agora) => cofres.links!.lerContextoConexao(id, agora) : undefined,
      tratarCofre: async (id, mensagem) => cofres.links ? cofres.links.tratarMensagem(id, mensagem,
        textoSeguro => new ExtratorRespostaMedicoNvidia(iaApiKey, iaModeloTexto, completarIa).classificarAgenda(textoSeguro)) : false,
      aoDecidir: config.envioMedicoRealAtivo ? async (acao, chave, contexto) => {
        if (acao.tipo === 'boas_vindas' && contexto?.nomeMedico) {
          await comunicacaoHomologacao.boasVindas({ medicoId, nomeMedico: contexto.nomeMedico, ultimaNota: acao.ultimaNota });
          return;
        }
        if (acao.tipo === 'pedir_agenda' && acao.agendaInformada === 'tribemd') { await cofres.links?.solicitarLinkCofre(medicoId, 'tribemd'); return; }
        if (acao.tipo === 'pedir_agenda') await comunicacaoHomologacao.medico({ medicoId, acao: 'pedir_agenda', chave });
      } : undefined,
      lerEstado: async (id, instante) => lerEstadoComunicacaoMedico(pool, id, instante, await cofres.statusAgenda(id), config.preparacaoFiscalAtiva === true),
      log: (nivel, mensagem) => console[nivel === 'info' ? 'info' : 'error'](mensagem)
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
      const fiscal = await processarOnboardingXml({
        pool, supabase: authAdminService.supabaseClient,
        documentoTitularEsperado: titular.documentoTitular, chaveCriptografia: config.encryptionKey, pepperCpf: config.appPepper
      },
        medicoId, consulta.documento.xml);
      const adocaoFiscal = await adotarReferenciaConsentida({ pool, preparacaoFiscalAtiva: Boolean(config.preparacaoFiscalAtiva) },
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
        return res.status(400).json({ ok: false, detalhe: 'Ainda não conseguimos adotar a configuração completa dessa nota. Busque a referência novamente; se persistir, a equipe precisa analisar o caso antes de liberar a emissão.' });
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

      const appUrl = config.host === '0.0.0.0'
        ? 'https://notomed-web.6t32my.easypanel.host'
        : `http://${config.host}:${config.porta}`;

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
          if (config.conversaLivreAtiva) await comunicacaoHomologacao.marcarLida(contexto.medicoId, contexto.chaveWhatsApp);
          if (emissaoComprovante && config.envioMedicoRealAtivo) {
            const pendentes = await emissaoComprovante.buscarConfirmacoes(contexto.medicoId);
            if (pendentes.length) {
              const unica = pendentes.length === 1 ? pendentes[0] : null;
              const c = unica?.confirmacao;
              const pergunta = c?.paciente && c?.dataEnvioPagamento && c?.dataConsulta
                ? `Autoriza emitir a nota de ${c.paciente}, pagamento enviado em ${c.dataEnvioPagamento}, consulta de ${c.dataConsulta}?` : 'Não há uma oportunidade única vinculada a uma pergunta de emissão.';
              const interpretacao = await interpretarConfirmacaoEmissao(iaApiKey, iaModeloTexto, completarIa, { texto: contexto.texto, pergunta });
              const resultado = await emissaoComprovante.confirmar(contexto.medicoId, contexto.chaveMensagem, interpretacao, new Date(),
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
          return comunicarMedico(contexto.medicoId, `assistente:${contexto.chaveMensagem}`, contexto.texto, contexto.dataMensagem, contexto.chaveConversa, contexto.chaveWhatsApp);
        },
        aoReceberComprovante: contexto => orquestrarComprovante(contexto, {
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
            if (resultado.tipo === 'enfileirada') {
              const pendentes = await emissaoComprovante.buscarConfirmacoes(contexto.medicoId);
              const c = pendentes.find(p => p.id === resultado.solicitacaoId)?.confirmacao;
              if (c?.dataEnvioPagamento && c?.dataConsulta && c?.paciente) {
                const envio = await comunicacaoHomologacao.confirmarEmissao({ medicoId: contexto.medicoId, solicitacaoId: resultado.solicitacaoId,
                  paciente: c.paciente, dataEnvioPagamento: c.dataEnvioPagamento, dataConsulta: c.dataConsulta });
                await emissaoComprovante.registrarPergunta(contexto.medicoId, resultado.solicitacaoId, envio.resultado, envio.chaveMensagem, new Date());
              }
              console.info('Solicitação de comprovante aguardando confirmação do médico.');
            }
          } : undefined,
          lerEstado: atendimentoRepo.lerEstado.bind(atendimentoRepo),
          extrator: new ExtratorComprovanteNvidia(iaApiKey, iaModeloVisao,
            mensagem => evolutionClient.obterBase64MensagemMidia(req.body.instance, mensagem.key.id), completarIa),
          log: (nivel, mensagem) => console[nivel === 'info' ? 'info' : 'error'](mensagem)
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
  const worker = iniciarWorkerEmbutido(pool, config);
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
