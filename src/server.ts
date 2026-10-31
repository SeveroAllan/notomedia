import { solicitarOtpEmail, autenticarComOtpEmail, type EnviarOtpEmail } from './otp/login-otp-email.js';
import { EnviarOtpEmailResend } from './io/resend/enviar-otp-email.js';
import { ComunicacaoHomologacao } from './whatsapp/comunicacao-homologacao.js';
import { criarCofreContas } from './cofre/router.js';
import { PostgresCadastro } from './cadastro/postgres-cadastro.js';
import { CadastroCertificado } from './cadastro/cadastro-certificado.js';
import { criarConsultaEmpresa, PesquisaRegistroIndisponivel } from './cadastro/consultas.js';
import { criarRouterStatusWhatsapp } from './whatsapp/status-router.js';
import { criarRouterCadastroPainel } from './cadastro/router-painel.js';
import { OpenSerpConsultaRegistro } from './cadastro/openserp-registro.js';
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
import { EvolutionApiClient } from './io/evolution/evolution-api-client.js';
import { SupabaseAuthAdminService } from './io/supabase/supabase-auth-admin-service.js';

import { solicitarOtp } from './otp/solicitar-otp.js';
import { autenticarComOtp } from './auth/autenticar-com-otp.js';
import { completarNvidia, completarOpenAi } from './io/nvidia/chat-client.js';

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
import { PostgresDadosProfissionaisService } from './io/postgres/postgres-dados-profissionais-service.js';
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
  const evolutionClient = new EvolutionApiClient(
    config.evolutionApiUrl,
    config.evolutionGlobalApiKey,
    config.evolutionOfficialInstanceName, config.evolutionOfficialInstanceName
  );
  const comunicacaoHomologacao = new ComunicacaoHomologacao(pool, config, new EvolutionApiClient(
    config.evolutionAssistantUrl, config.evolutionAssistantApiKey, config.evolutionAssistantInstanceName, config.evolutionOfficialInstanceName));
  const dadosProfissionais = new PostgresDadosProfissionaisService(pool);
  const authAdminService = new SupabaseAuthAdminService(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    pool
  );
  const cofres = criarCofreContas({
    pool, enviarCofre: (id, texto) => comunicacaoHomologacao.cofre(id, texto),
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
  // Provedor de IA: OpenAI quando OPENAI_API_KEY está configurada; NVIDIA como legado. Mesma chave/modelo por finalidade.
  const iaOpenAiAtiva=!!config.openaiApiKey;
  const iaApiKey=iaOpenAiAtiva?config.openaiApiKey:config.nvidiaApiKey;
  const completarIa=iaOpenAiAtiva?completarOpenAi:completarNvidia;
  const iaModeloTexto=(iaOpenAiAtiva?config.openaiTextoModel:config.nvidiaRegistroModel) ?? '';
  const pesquisaCrmConfigurada=!!config.openserpBaseUrl&&!!iaApiKey;
  const consultaRegistro = pesquisaCrmConfigurada
    ? new OpenSerpConsultaRegistro({baseUrl:config.openserpBaseUrl,nvidiaApiKey:iaApiKey,modelo:iaModeloTexto,incluirDiagnostico:true,
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

  const aoConectarWhatsapp = (_medicoId: string) => {};

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
