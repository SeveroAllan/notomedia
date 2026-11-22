/**
 * Entrypoint de teste local ponta a ponta: conecta diretamente à Evolution API
 * Docker local (usando a instância conectada configurada em `.env` como canal
 * oficial de OTP + WhatsApp da IA), sobe o front-end de 2 telas, os links do
 * cofre (`/c/...`), a busca online de agendas e o subagente navegador real.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import pg from 'pg';
import { EvolutionApiClient } from '../io/evolution/evolution-api-client.js';
import { AdnNfseClient } from '../io/fiscal/adn-nfse-client.js';
import { PostgresOtpRepositorio } from '../io/postgres/postgres-otp-repositorio.js';
import { formatarMensagemOtp } from '../otp/enviar-otp-whatsapp.js';
import { solicitarOtp } from '../otp/solicitar-otp.js';
import { autenticarComOtp } from '../auth/autenticar-com-otp.js';
import { conectarInstanciaWhatsappMedico } from '../onboarding/io/conectar-instancia-whatsapp-medico.js';
import { consultarStatusInstanciaWhatsapp } from '../onboarding/io/consultar-status-instancia-whatsapp.js';
import { consultarStatusOnboarding } from '../onboarding/io/consultar-status-onboarding.js';
import { criarGuardaMedicoDaConta, medicoAutorizado } from '../http/autorizar-medico-sessao.js';
import { criarRouterStatusWhatsapp } from '../whatsapp/status-router.js';
import { criarRouterWebhookPareamento } from '../whatsapp/webhook-pareamento.js';
import { enviarBoasVindasAposPareamento, mensagemBoasVindasPareamento } from '../agente/boas-vindas-pareamento.js';
import { separarBaloes } from '../agente/baloes.js';
import { criarFiltroSaidaHumano } from '../agente/filtro-saida-humano.js';
import { humanizarSaidaWhatsApp } from '../agente/humanizar-saida-whatsapp.js';
import { envolverMensagemProativaComCortesia } from '../agente/regras/cortesia-retomada-conversa.js';
import { criarRouterWebhookAgente } from '../agente/webhook.js';
import { consultarEstadoProntidaoConta } from '../agente/estado-prontidao-conta.js';
import {
  notificarAgendaConectadaEIniciarProfissionais,
  notificarCertificadoSalvoEProximoPasso,
  notificarProfissionaisEEnviarLinksCertificados,
  notificarXmlSalvoEProximoPasso,
  type PortaEnvioOrquestracao
} from '../agente/orquestrar-pos-cofre.js';
import { salvarPreferenciasEmissaoConta } from '../conta/preferencias-emissao-repositorio.js';
import { criarCompactadorMemoriaOpenAi } from '../agente/memoria/compactador-openai.js';
import { criarServicoMemoriaConversa } from '../agente/memoria/gerenciar-memoria-conversa.js';
import { PostgresMemoriaRepositorio } from '../agente/memoria/postgres-memoria-repositorio.js';
import { montarBlocoEstadoVivo } from '../agente/memoria/blocos-memoria-config.js';
import { PostgresBlocosMemoriaRepositorio } from '../agente/memoria/blocos-memoria-repositorio.js';
import { criarServicoBlocosMemoria } from '../agente/memoria/gerenciar-blocos-memoria.js';
import { criarConsolidadorBlocosOpenAi, criarConsolidadorSleepTime } from '../agente/memoria/sleep-time-consolidacao.js';
import { criarMotorRotinaProativa } from '../agente/rotina-proativa-worker.js';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';
import { criarCofreContas } from '../cofre/router.js';
import { cofreIdDaConta } from '../cofre/identidade-conta.js';
import {
  processarCertificadoViaCofre,
  processarXmlViaCofre,
  reconsultarFiscalPeloCertificadoSalvo
} from '../onboarding/fluxos/processar-certificado-cofre.js';
import { descobrirUrlAgendaOnline } from '../agenda/descobrir-url-agenda-online.js';
import { criarFonteBuscaOpenAiWebSearch } from '../agenda/busca-web-openai.js';
import { criarConsultorAgendaConta } from '../agenda/consultar-agenda-conta.js';
import { calcularJanelaDiasConsulta } from '../agenda/filtrar-atendimentos-agenda.js';
import { criarTranscritorAudioOpenAi } from '../midia/transcrever-audio-openai.js';
import { criarLeitorComprovanteOpenAi } from '../midia/ler-comprovante-openai.js';
import { montarInfraEmissaoConta } from '../emissao/montar-emissao-conta-infra.js';
import { iniciarWorkerCasosEmissao } from '../emissao/worker-casos-emissao.js';
import { PostgresEmissorDpsService } from '../io/fiscal/postgres-emissor-dps-service.js';
import { SefinNacionalClient } from '../io/fiscal/sefin-nacional-client.js';
import { criarStorageLocalSupabaseCompat, garantirSchemaLocalDev, LocalAuthAdminService } from './local-auth-e-storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ_PROJETO = resolve(__dirname, '..', '..');

function carregarVarEnvLocal(chave: string): string {
  if (process.env[chave]?.trim()) return process.env[chave]!.trim();
  const arq = join(RAIZ_PROJETO, '.env');
  if (!existsSync(arq)) return '';
  const regex = new RegExp(`^${chave}=(.+)$`);
  for (const linha of readFileSync(arq, 'utf8').split(/\r?\n/)) {
    const m = regex.exec(linha.trim());
    if (m?.[1]?.trim()) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

function detectarChromiumWindows(): string {
  const caminhos = [
    process.env['CHROMIUM_EXECUTABLE_PATH'],
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean) as string[];
  return caminhos.find(p => existsSync(p)) ?? '';
}

async function garantirBancoLocal(pgAdminUrl: string, nomeBanco: string): Promise<void> {
  const adminPool = new pg.Pool({ connectionString: pgAdminUrl });
  try {
    const existe = await adminPool.query('select 1 from pg_database where datname = $1', [nomeBanco]);
    if (!existe.rows.length) {
      await adminPool.query(`CREATE DATABASE ${nomeBanco}`);
    }
  } finally {
    await adminPool.end();
  }
}

async function detectarInstanciaEvolutionAberta(urlBase: string, apiKey: string, preferida: string): Promise<{ nome: string; numero: string }> {
  const resp = await fetch(`${urlBase}/instance/fetchInstances`, { headers: { apikey: apiKey }, signal: AbortSignal.timeout(5000) });
  if (!resp.ok) throw new Error(`Evolution API HTTP ${resp.status}`);
  const lista = (await resp.json()) as Array<{ name: string; connectionStatus: string; ownerJid?: string; number?: string }>;
  const aberta = lista.find(i => i.name === preferida && i.connectionStatus === 'open')
    ?? lista.find(i => i.connectionStatus === 'open');
  if (!aberta) throw new Error('Nenhuma instância WhatsApp conectada (open) encontrada na Evolution API Docker.');
  const numero = (aberta.number || String(aberta.ownerJid || '').replace(/@.*/, '')).replace(/\D/g, '');
  return { nome: aberta.name, numero };
}

async function configurarWebhookInstanciaAgente(urlBase: string, apiKey: string, instancia: string, webhookUrl: string, segredo: string): Promise<void> {
  const resp = await fetch(`${urlBase}/webhook/set/${encodeURIComponent(instancia)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: apiKey },
    body: JSON.stringify({
      webhook: {
        enabled: true,
        url: webhookUrl,
        headers: { apikey: apiKey, 'x-webhook-secret': segredo },
        webhookByEvents: false,
        events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE']
      }
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!resp.ok) {
    console.warn('[Dev Local] Aviso ao configurar webhook da instância agente:', resp.status);
  }
}

async function iniciar(): Promise<void> {
  const PORTA = Number(process.env['PORT'] || 3000);
  const EVOLUTION_URL = (carregarVarEnvLocal('EVOLUTION_API_URL') || 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const EVOLUTION_KEY = carregarVarEnvLocal('EVOLUTION_GLOBAL_API_KEY');
  if (!EVOLUTION_KEY) {
    throw new Error('Defina EVOLUTION_GLOBAL_API_KEY no ambiente ou no arquivo .env local.');
  }
  const WEBHOOK_SECRET = carregarVarEnvLocal('EVOLUTION_WEBHOOK_SECRET') || 'noto_local_dev_webhook_secret';
  const ORIGEM_PUBLICA = (carregarVarEnvLocal('DEV_PUBLIC_ORIGIN') || `http://localhost:${PORTA}`).replace(/\/+$/, '');
  const WEBHOOK_DOCKER_ORIGIN = `http://host.docker.internal:${PORTA}`;
  const OPENAI_KEY = carregarVarEnvLocal('OPENAI_API_KEY');
  const CHROMIUM_PATH = detectarChromiumWindows();
  const DIR_DADOS = join(RAIZ_PROJETO, '.dev-local-dados');
  await mkdir(DIR_DADOS, { recursive: true });

  const instanciaPreferida = carregarVarEnvLocal('EVOLUTION_OFFICIAL_INSTANCE_NAME');
  const instanciaAtiva = await detectarInstanciaEvolutionAberta(EVOLUTION_URL, EVOLUTION_KEY, instanciaPreferida);
  await configurarWebhookInstanciaAgente(EVOLUTION_URL, EVOLUTION_KEY, instanciaAtiva.nome, `${WEBHOOK_DOCKER_ORIGIN}/webhook/evolution`, WEBHOOK_SECRET);

  const PG_BASE = carregarVarEnvLocal('DEV_PG_ADMIN_URL') || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
  const DB_NOME = 'noto_local_dev';
  await garantirBancoLocal(PG_BASE, DB_NOME);
  const pool = new pg.Pool({ connectionString: PG_BASE.replace(/\/postgres$/, `/${DB_NOME}`) });
  const CHAVE_COFRE = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
  await garantirSchemaLocalDev(pool, 'noto_local_vault_dev_key');

  const authService = new LocalAuthAdminService(pool, 'noto_local_hmac_secret_v1');
  const storageLocal = criarStorageLocalSupabaseCompat(join(DIR_DADOS, 'storage'));
  const otpRepo = new PostgresOtpRepositorio(pool);
  const adnNfseClient = new AdnNfseClient();
  const evolutionAgente = new EvolutionApiClient(EVOLUTION_URL, EVOLUTION_KEY, '__canal_otp_separado__', '__canal_otp_separado__');

  // Mantém o telefone do usuário logado na allowlist de 1 elemento exigida pelo webhook.
  const allowlistAtiva: string[] = [];
  const autorizarTelefoneAtivo = (tel: string) => {
    const limpo = tel.replace(/\D/g, '');
    const com55 = limpo.length === 10 || limpo.length === 11 ? `55${limpo}` : limpo;
    if (com55.length >= 12) allowlistAtiva.splice(0, allowlistAtiva.length, com55);
  };
  const ultimoUsuario = await pool.query('select telefone from public.usuarios where ativo = true order by atualizado_em desc limit 1');
  if (ultimoUsuario.rows[0]?.telefone) autorizarTelefoneAtivo(String(ultimoUsuario.rows[0].telefone));

  const memoriaConversa = criarServicoMemoriaConversa({
    repositorio: new PostgresMemoriaRepositorio(pool),
    compactador: OPENAI_KEY ? criarCompactadorMemoriaOpenAi(OPENAI_KEY, 'gpt-4.1-mini') : null
  });

  const registrarProativo = async (telefone: string, texto: string) => {
    if (!texto || /\/c\//.test(texto)) return;
    const variantes = gerarVariantesTelefoneBrasileiro(telefone);
    if (!variantes.length) return;
    const conta = await pool.query(
      "select conta_id from public.usuarios where ativo = true and regexp_replace(telefone, '[^0-9]', '', 'g') = any($1::text[]) limit 1",
      [variantes]
    ).catch(() => ({ rows: [] as any[] }));
    const contaId = conta.rows[0]?.conta_id ? String(conta.rows[0].conta_id) : null;
    if (contaId) await memoriaConversa.registrarMensagem(contaId, 'noto', texto).catch(() => false);
  };

  const filtroSaida = criarFiltroSaidaHumano({ janelaDedupMs: 120_000 });
  const enviarWhatsappDireto = async (telefone: string, texto: string, opcoes?: { linkPreview?: boolean }): Promise<boolean> => {
    const r = await evolutionAgente.enviarTexto({
      instanciaNome: instanciaAtiva.nome,
      contatoTelefone: telefone,
      texto,
      ...(opcoes ? { linkPreview: opcoes.linkPreview } : {})
    });
    console.log(`[Dev Local -> WhatsApp ${telefone}] ${r.sucesso ? 'OK' : `ERRO (${r.erro})`}: ${texto.slice(0, 90)}`);
    return r.sucesso;
  };
  const enviarWhatsapp = (telefone: string, texto: string, opcoes?: { linkPreview?: boolean; categoriaAlerta?: string }): Promise<boolean> => {
    if (opcoes?.categoriaAlerta && filtroSaida.deveSuprimirRepeticao(telefone, texto, opcoes.categoriaAlerta)) {
      console.log(`[Dev Local -> Filtro] Alerta repetido suprimido (${opcoes.categoriaAlerta})`);
      return Promise.resolve(true);
    }
    return filtroSaida.enfileirarEnvio(telefone, async () => {
      if (!/https?:\/\//i.test(texto)) {
        void evolutionAgente.enviarPresenca(instanciaAtiva.nome, telefone, 'available').catch(() => false);
        void evolutionAgente.enviarPresenca(instanciaAtiva.nome, telefone, 'composing').catch(() => false);
        await new Promise(r => setTimeout(r, 450));
      }
      const ok = await enviarWhatsappDireto(telefone, texto, opcoes);
      void evolutionAgente.enviarPresenca(instanciaAtiva.nome, telefone, 'paused').catch(() => false);
      return ok;
    });
  };

  const enviarProativoComCortesia = async (
    contaId: string,
    telefone: string,
    texto: string,
    opcoes?: { categoriaAlerta?: string; ehPedidoDeAjudaOuDado?: boolean }
  ): Promise<boolean> => {
    const [ctxMem, medRow] = await Promise.all([
      memoriaConversa.carregarContexto(contaId).catch(() => null),
      pool.query('SELECT nome_completo FROM public.medicos WHERE conta_id = $1 ORDER BY criado_em ASC LIMIT 1', [contaId]).catch(() => ({ rows: [] as any[] }))
    ]);
    const textoComCortesia = envolverMensagemProativaComCortesia({
      texto,
      ultimaInteracaoIso: ctxMem?.ultimaInteracaoEm ?? null,
      nomeProfissional: medRow.rows[0]?.nome_completo ? String(medRow.rows[0].nome_completo) : null,
      ehPedidoDeAjudaOuDado: opcoes?.ehPedidoDeAjudaOuDado
    });
    const textoFinal = humanizarSaidaWhatsApp(textoComCortesia);
    if (filtroSaida.deveSuprimirRepeticao(telefone, textoFinal, opcoes?.categoriaAlerta)) {
      console.log(`[Dev Local -> Filtro] Proativo repetido suprimido (${opcoes?.categoriaAlerta ?? 'texto'})`);
      return true;
    }
    const baloes = separarBaloes(textoFinal);
    let ok = true;
    for (const balao of baloes) {
      const enviado = await enviarWhatsapp(telefone, balao);
      if (!enviado) { ok = false; break; }
    }
    if (ok) await memoriaConversa.registrarMensagem(contaId, 'noto', textoFinal).catch(() => false);
    return ok;
  };

  let portaOrquestracao!: PortaEnvioOrquestracao;
  const depsCert = {
    pool,
    supabase: storageLocal,
    adnNfseClient,
    encryptionKey: 'noto_local_dev_encryption_key_32',
    appPepper: 'noto_local_dev_pepper_secret',
    preparacaoFiscalAtiva: true,
    // Mantém ambiente fiscal travado em homologação no servidor de testes locais.
    escopoFiscalPiloto: (_medicoId: string, contaId: string) => ({ contaPilotoHomologacao: contaId })
  };

  const cofres = criarCofreContas({
    pool,
    autenticar: async token => authService.autenticarToken(token),
    env: {
      ...process.env,
      COFRE_ORIGEM: ORIGEM_PUBLICA,
      COFRE_DIRETORIO: join(DIR_DADOS, 'cofre'),
      COFRE_CHAVE: CHAVE_COFRE,
      CHROMIUM_EXECUTABLE_PATH: CHROMIUM_PATH
    },
    obterWhatsappAssistente: async () => instanciaAtiva.numero,
    enviarCofre: async (_id, texto, tel) => (tel && await enviarWhatsapp(tel, texto) ? 'enviado' : 'erro'),
    enviarWhatsappOnboarding: (tel, texto) => enviarWhatsapp(tel, texto, { linkPreview: false }),
    processarCertificadoLink: entrada => processarCertificadoViaCofre(depsCert, entrada),
    processarXmlLink: entrada => processarXmlViaCofre(depsCert, entrada),
    aoConcluirConta: async (contaId, evento) => {
      console.log(`[Dev Local <- Cofre ${evento.agenda}] conectado=${evento.conectado} motivo=${evento.motivoAcesso ?? '-'}`);
      if (!evento.contatoTelefone) return;
      await notificarAgendaConectadaEIniciarProfissionais(portaOrquestracao, {
        contaId,
        nomeAgenda: evento.agenda === 'tribemd' ? 'TribeMD' : 'Amplimed',
        conectado: evento.conectado,
        telefone: evento.contatoTelefone,
        motivoErro: evento.motivoAcesso
      });
    },
    aoConcluirAgendaGenerica: async (contaId, evento) => {
      console.log(`[Dev Local <- Cofre Genérico ${evento.nomeAgenda}] conectado=${evento.conectado} motivo=${evento.motivoErro ?? '-'}`);
      await notificarAgendaConectadaEIniciarProfissionais(portaOrquestracao, {
        contaId,
        nomeAgenda: evento.nomeAgenda,
        conectado: evento.conectado,
        telefone: evento.telefone,
        motivoErro: evento.motivoErro
      });
    },
    aoCadastrarProfissionaisLink: ev => notificarProfissionaisEEnviarLinksCertificados(portaOrquestracao, ev),
    aoSalvarCertificadoLink: ev => notificarCertificadoSalvoEProximoPasso(portaOrquestracao, ev),
    aoSalvarXmlLink: ev => notificarXmlSalvoEProximoPasso(portaOrquestracao, ev)
  });

  const consultarAgendaGenerica = async (contaId: string) => {
    if (!cofres.cofreGenerico) return { conectada: false, provedor: null, nomeAgenda: null };
    const st = await cofres.cofreGenerico.status(cofreIdDaConta(contaId));
    return { conectada: st.salvo && st.ativo && st.estado === 'conectado', provedor: st.provedor, nomeAgenda: st.nomeAgenda };
  };

  const consultarEstadoContaLocal = (contaId: string) => consultarEstadoProntidaoConta({
    pool, contaId,
    consultarAgendasPadrao: () => cofres.statusAgendas(cofreIdDaConta(contaId)),
    consultarAgendaGenerica: () => consultarAgendaGenerica(contaId)
  });

  portaOrquestracao = {
    enviarTexto: async (tel, texto, opcoes) => {
      const ok = await enviarWhatsapp(tel, texto, opcoes);
      if (ok) void registrarProativo(tel, texto);
      return ok;
    },
    criarLinkProfissionais: (contaId, tel) => cofres.linksOnboarding!.criarLinkCadastroProfissionais({ contaId, telefone: tel, enviarMensagem: false }),
    criarLinkCertificado: (contaId, medId, tel) => cofres.linksOnboarding!.criarLinkCertificadoProfissional({ contaId, medicoId: medId, telefone: tel, enviarMensagem: false }),
    criarLinkXml: (contaId, medId, tel) => cofres.linksOnboarding!.criarLinkXmlProfissional({ contaId, medicoId: medId, telefone: tel, enviarMensagem: false }),
    listarProfissionaisCadastrados: async contaId =>
      (await consultarEstadoContaLocal(contaId)).profissionais.map(p => ({
        id: p.id,
        nome: p.nomeCompleto,
        certificadoValido: p.certificadoValido,
        dadosFiscaisProntos: p.dadosFiscaisProntos
      })),
    listarProfissionaisSemCertificado: async contaId => (await consultarEstadoContaLocal(contaId)).profissionaisSemCertificado,
    obterNomeAgendaConectada: async contaId => (await consultarEstadoContaLocal(contaId)).agenda.nomeAgenda,
    preferenciasJaConfiguradas: async contaId => Boolean((await consultarEstadoContaLocal(contaId)).preferenciasEmissao?.completas),
    retomarCasosPendentes: contaId => infraEmissao.orquestrador.retomarCasosAguardandoProntidaoFiscal(contaId)
  };

  const fonteBuscaOnline = OPENAI_KEY ? criarFonteBuscaOpenAiWebSearch(OPENAI_KEY) : null;
  const transcritorAudio = OPENAI_KEY ? criarTranscritorAudioOpenAi(OPENAI_KEY) : null;
  const leitorComprovante = OPENAI_KEY ? criarLeitorComprovanteOpenAi(OPENAI_KEY, 'gpt-4.1-mini') : null;
  const consultarAgendaConta = criarConsultorAgendaConta({
    obterAgendaConectada: async contaId => {
      const padrao = await cofres.statusAgendas(cofreIdDaConta(contaId));
      if (padrao.tribemd.conectada) return { conectada: true, provedor: 'tribemd', nomeAgenda: 'TribeMD' };
      if (padrao.amplimed.conectada) return { conectada: true, provedor: 'amplimed', nomeAgenda: 'Amplimed' };
      return consultarAgendaGenerica(contaId);
    },
    lerTribemdRapido: async (contaId, janelaDias, agora) => {
      const r = await cofres.lerAgendaTribemdRapida(cofreIdDaConta(contaId), janelaDias, agora);
      console.log(`[Dev Local <- Agenda TribeMD] ${r.ok ? `OK (${r.consultas.length} atendimentos, janela=${janelaDias}d)` : `ERRO (${r.motivo})`}`);
      return r;
    },
    lerAmplimed: async (contaId, inicio, fim) => {
      const r = await cofres.lerAgendaAmplimed(cofreIdDaConta(contaId), inicio, fim, false);
      if (!r.ok) return { ok: false, motivo: r.motivo };
      return {
        ok: true,
        consultas: r.dias.flatMap(d => d.consultas
          .filter(c => c.status === 'realizada')
          .map(c => ({ data: c.dataHora || d.data, paciente: c.paciente, situacao: c.status, valorCentavos: c.valorCentavos })))
      };
    }
  });

  const infraEmissao = montarInfraEmissaoConta({
    pool,
    chaveCriptografia: depsCert.encryptionKey,
    pepper: depsCert.appPepper,
    permitirProducao: false,
    obterAtendimentosAgenda: async (contaId, inicioIso, fimIso) => {
      const r = await consultarAgendaConta({ contaId, filtro: { dataInicio: inicioIso, dataFim: fimIso } });
      return r.ok && !r.emAndamento ? r.resumo.atendimentos : [];
    },
    obterAtendimentosDetalhados: async (contaId, inicioIso, fimIso) => {
      const agora = new Date();
      const hojeIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora);
      const padrao = await cofres.statusAgendas(cofreIdDaConta(contaId));
      if (padrao.tribemd.conectada) {
        const janela = calcularJanelaDiasConsulta(inicioIso, hojeIso);
        const r = await cofres.lerAgendaTribemdComDetalhes(cofreIdDaConta(contaId), janela, agora);
        console.log(`[Dev Local <- Agenda Detalhada TribeMD] ${r.ok ? `OK (${r.consultas.length} atendimentos, janela=${janela}d)` : `ERRO (${r.motivo})`}`);
        if (!r.ok) throw new Error(r.motivo || 'LEITURA_INDISPONIVEL');
        return r.consultas;
      }
      if (padrao.amplimed.conectada) {
        const r = await cofres.lerAgendaAmplimed(cofreIdDaConta(contaId), inicioIso, fimIso, true);
        if (!r.ok) throw new Error(r.motivo || 'LEITURA_INDISPONIVEL');
        return r.dias.flatMap(d => d.elegiveis.map(e => ({
          data: e.dataHora || d.data,
          paciente: e.paciente,
          valorCentavos: e.valorCentavos,
          atendimentoId: e.idExterno,
          cpf: e.detalhe?.cpf ?? null,
          telefone: e.detalhe?.celular ?? null
        })));
      }
      return [];
    },
    obterDetalheTribemd: async (contaId, atendimentoId) => {
      const d = await cofres.detalheAoVivo(cofreIdDaConta(contaId), atendimentoId).catch(() => null);
      if (!d) return null;
      return {
        nome: d.nome,
        cpf: d.cpf,
        telefone: d.contato.celular ?? d.contato.telefone ?? null,
        valorCentavos: d.valorCobradoCentavos
      };
    },
    enviarTextoMedico: async (contaId, tel, texto) =>
      enviarProativoComCortesia(contaId, tel, texto),
    enviarPdfMedico: async (contaId, tel, pdfBase64, nomeArquivo, legenda) => {
      const r = await filtroSaida.enfileirarEnvio(tel, () => evolutionAgente.enviarPdf({
        instanciaNome: instanciaAtiva.nome,
        contatoTelefone: tel,
        pdfPathOuUrl: `data:application/pdf;base64,${pdfBase64}`,
        nomeArquivo,
        legenda
      }));
      console.log(`[Dev Local -> PDF ${tel}] ${r.sucesso ? 'OK' : `ERRO (${r.erro})`}: ${nomeArquivo}`);
      if (r.sucesso) await memoriaConversa.registrarMensagem(contaId, 'noto', legenda).catch(() => false);
      return r.sucesso;
    },
    enviarTextoConsultorio: async (instancia, telPaciente, texto) => {
      const r = await evolutionAgente.enviarTexto({ instanciaNome: instancia, contatoTelefone: telPaciente, texto });
      return r.sucesso;
    },
    enviarPdfConsultorio: async (instancia, telPaciente, pdfBase64, nomeArquivo, legenda) => {
      const r = await evolutionAgente.enviarPdf({
        instanciaNome: instancia,
        contatoTelefone: telPaciente,
        pdfPathOuUrl: `data:application/pdf;base64,${pdfBase64}`,
        nomeArquivo,
        legenda
      });
      return r.sucesso;
    },
    reagirMensagemMedico: (chave, emoji) => evolutionAgente.reagirMensagem(instanciaAtiva.nome, chave, emoji),
    baixarMidia: (inst, msgId) => evolutionAgente.obterBase64MensagemMidia(inst, msgId),
    lerComprovante: leitorComprovante ? midia => leitorComprovante.ler(midia) : undefined
  });

  const blocosMemoriaRepo = new PostgresBlocosMemoriaRepositorio(pool);
  const obterEstadoVivoLocal = async (contaId: string) => {
    const [estado, casos] = await Promise.all([
      consultarEstadoContaLocal(contaId).catch(() => null),
      infraEmissao.orquestrador.consultarEmissoesConta(contaId).catch(() => [])
    ]);
    return montarBlocoEstadoVivo(estado, casos);
  };
  const blocosMemoria = criarServicoBlocosMemoria({
    repositorio: blocosMemoriaRepo,
    obterEstadoVivo: obterEstadoVivoLocal
  });
  const sleepTimeMemoria = criarConsolidadorSleepTime({
    blocosRepo: blocosMemoriaRepo,
    memoriaConversa,
    obterEstadoVivo: obterEstadoVivoLocal,
    consolidadorIa: OPENAI_KEY ? criarConsolidadorBlocosOpenAi(OPENAI_KEY, 'gpt-4.1-mini') : null
  });

  const emissorDpsLocal = new PostgresEmissorDpsService(
    pool,
    depsCert.encryptionKey,
    undefined,
    undefined,
    storageLocal,
    new SefinNacionalClient(),
    false,
    true,
    false,
    false,
    'homologacao',
    process.env['NOTO_CONTINGENCIA_HOMOLOGACAO'] !== 'false'
  );
  iniciarWorkerCasosEmissao({
    pool,
    emissorDps: emissorDpsLocal,
    storage: storageLocal,
    permitirProducao: false,
    aoAutorizarNota: entrada => infraEmissao.orquestrador.entregarNotaAutorizada(entrada),
    aoFalharEmissao: async falha => {
      const ctx = await infraEmissao.obterContextoConta(falha.contaId);
      if (!ctx.telefoneMedico) return;
      const erroConta = [
        'PARAMETROS_FISCAIS_PENDENTES', 'PERFIL_FISCAL_INCOMPLETO',
        'CERTIFICADO_AUSENTE', 'AMBIENTE_FISCAL_BLOQUEADO',
        'SEFIN_TIMEOUT', 'SEFIN_INDISPONIVEL', 'SEFIN_HTTP_403_IIS'
      ].includes(falha.codigoErro ?? '');
      await enviarProativoComCortesia(ctx.telefoneMedico ? falha.contaId : falha.contaId, ctx.telefoneMedico, falha.mensagemHumana, {
        categoriaAlerta: erroConta ? `erro_fiscal_conta:${falha.codigoErro}` : `erro_nota:${falha.casoId}`
      });
    }
  });

  const motorProativo = criarMotorRotinaProativa({
    pool,
    repositorioCasos: infraEmissao.repositorio,
    lerHorariosDoDia: async (contaId, diaIso, agora) => {
      const padrao = await cofres.statusAgendas(cofreIdDaConta(contaId));
      if (padrao.tribemd.conectada) {
        const r = await cofres.lerAgendaTribemdRapida(cofreIdDaConta(contaId), 1, agora);
        return r.ok ? (r.horariosHoje ?? []) : [];
      }
      if (padrao.amplimed.conectada) {
        const r = await cofres.lerAgendaAmplimed(cofreIdDaConta(contaId), diaIso, diaIso, false);
        if (!r.ok) return [];
        return r.dias.flatMap(d => d.consultas
          .filter(c => c.status !== 'cancelada' && c.status !== 'faltou')
          .map(c => ({
            paciente: c.paciente,
            inicioIso: c.dataHora || `${d.data}T09:00:00-03:00`,
            finalizado: c.status === 'realizada'
          })));
      }
      return [];
    },
    lerFinalizadosDoDiaDetalhado: async (contaId, diaIso, agora) => {
      const padrao = await cofres.statusAgendas(cofreIdDaConta(contaId));
      if (padrao.tribemd.conectada) {
        const r = await cofres.lerAgendaTribemdComDetalhes(cofreIdDaConta(contaId), 1, agora);
        return r.ok ? r.consultas.filter(c => c.data.slice(0, 10) === diaIso) : [];
      }
      if (padrao.amplimed.conectada) {
        const r = await cofres.lerAgendaAmplimed(cofreIdDaConta(contaId), diaIso, diaIso, true);
        if (!r.ok) return [];
        return r.dias.flatMap(d => d.elegiveis.map(e => ({
          data: e.dataHora || d.data,
          paciente: e.paciente,
          valorCentavos: e.valorCentavos,
          atendimentoId: e.idExterno,
          cpf: e.detalhe?.cpf ?? null,
          telefone: e.detalhe?.celular ?? null
        })));
      }
      return [];
    },
    prepararEmissaoProativa: entrada => infraEmissao.orquestrador.prepararEmissaoPeloMedico(entrada),
    enviarTextoMedico: (contaId, tel, texto) =>
      enviarProativoComCortesia(contaId, tel, texto)
  });
  motorProativo.iniciar();
  const boasVindas = async (nomeInstancia: string) => {
    await enviarBoasVindasAposPareamento({
      pool, ativo: true, nomeInstancia, allowlist: allowlistAtiva,
      enviar: async (tel, texto) => {
        for (const balao of separarBaloes(texto)) {
          if (!(await enviarWhatsapp(tel, balao))) return false;
        }
        return true;
      }
    });
  };

  const app = express();
  app.set('trust proxy', 1);
  app.use('/api/conta/cofre', cofres.app);
  if (cofres.appLinks) app.use('/c', cofres.appLinks);
  app.use(express.json({ limit: '10mb' }));
  app.use('/assets', express.static(join(RAIZ_PROJETO, 'src', 'assets')));
  app.get('/', (_req, res) => {
    const html = readFileSync(join(RAIZ_PROJETO, 'src', 'ui', 'index.html'), 'utf8')
      .replace('href="whatsapp://"', `href="https://wa.me/${instanciaAtiva.numero}"`);
    res.type('html').send(html);
  });
  app.get('/health', (_req, res) => res.json({ ok: true, modo: 'dev-local', origemPublica: ORIGEM_PUBLICA, instanciaAgente: instanciaAtiva.nome, numeroAgente: instanciaAtiva.numero }));

  app.post('/api/dev/resetar-conta-zero', async (req: Request, res: Response) => {
    const ip = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip) || req.headers['cf-connecting-ip']) {
      return res.status(403).json({ ok: false, motivo: 'APENAS_LOCALHOST' });
    }
    const { rows: tabelas } = await pool.query(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
         AND table_name NOT IN ('contas', 'usuarios')
       ORDER BY table_name
    `);
    for (const { table_name } of tabelas) {
      await pool.query(`TRUNCATE TABLE public."${table_name}" RESTART IDENTITY CASCADE`);
    }
    await pool.query("UPDATE public.usuarios SET nome = 'Médico' WHERE ativo = true");
    await rm(join(DIR_DADOS, 'cofre'), { recursive: true, force: true }).catch(() => undefined);
    await rm(join(DIR_DADOS, 'storage'), { recursive: true, force: true }).catch(() => undefined);

    const { rows: usuarios } = await pool.query(
      'SELECT conta_id, telefone FROM public.usuarios WHERE ativo = true ORDER BY atualizado_em DESC LIMIT 1'
    );
    const usuario = usuarios[0] as { conta_id?: string; telefone?: string } | undefined;
    if (!usuario?.conta_id || !usuario.telefone) {
      return res.status(404).json({ ok: false, motivo: 'USUARIO_NAO_ENCONTRADO' });
    }
    autorizarTelefoneAtivo(usuario.telefone);
    const textoBoasVindas = mensagemBoasVindasPareamento(null);
    const baloes = separarBaloes(textoBoasVindas);
    for (const balao of baloes) {
      await enviarWhatsappDireto(usuario.telefone, balao);
      await new Promise(r => setTimeout(r, 280));
    }
    await memoriaConversa.registrarMensagem(usuario.conta_id, 'noto', baloes.join(' ')).catch(() => false);
    return res.json({ ok: true, contaId: usuario.conta_id, telefone: usuario.telefone, baloes });
  });

  const enviadorOtpTexto = {
    async enviar(params: { telefone: string; codigo: string }) {
      const r = await evolutionAgente.enviarTexto({
        instanciaNome: instanciaAtiva.nome,
        contatoTelefone: params.telefone,
        texto: formatarMensagemOtp(params.codigo)
      });
      console.log(`[Dev Local -> OTP ${params.telefone}] ${r.sucesso ? `OK (id=${r.mensagemId ?? '-'})` : `ERRO (${r.erro})`}`);
      return r.sucesso ? { sucesso: true } : { sucesso: false, erro: r.erro };
    }
  };

  app.post('/api/auth/otp/solicitar', async (req: Request, res: Response) => {
    const telefone = String(req.body?.telefone ?? '').trim();
    if (!telefone) return res.status(400).json({ ok: false, detalhe: 'Telefone é obrigatório.' });
    autorizarTelefoneAtivo(telefone);
    const r = await solicitarOtp(telefone, { repositorio: otpRepo, enviador: enviadorOtpTexto, pepper: 'noto_local_dev_pepper_secret' });
    if (!r.ok) console.warn(`[Dev Local -> OTP ${telefone}] recusado: ${r.motivo} (${r.detalhe ?? ''})`);
    return res.status(r.ok ? 200 : 400).json(r);
  });

  app.post('/api/auth/otp/verificar', async (req: Request, res: Response) => {
    const telefone = String(req.body?.telefone ?? '').trim();
    const codigo = String(req.body?.codigo ?? '').trim();
    const r = await autenticarComOtp(telefone, codigo, { otpRepositorio: otpRepo, authAdminService: authService, pepper: 'noto_local_dev_pepper_secret' });
    if (r.ok) autorizarTelefoneAtivo(telefone);
    console.log(`[Dev Local <- OTP verificar ${telefone}] ${r.ok ? 'AUTENTICADO' : `FALHOU (${r.motivo})`}`);
    return res.status(r.ok ? 200 : 401).json(r);
  });

  const rotasProtegidas = ['/api/onboarding/status', '/api/onboarding/whatsapp/iniciar', '/api/onboarding/whatsapp/status'];
  app.use(rotasProtegidas, criarGuardaMedicoDaConta({ pool, autenticar: async token => authService.autenticarToken(token) }));

  app.get('/api/onboarding/status', async (_req, res) => {
    const { medicoId } = medicoAutorizado(res);
    const status = await consultarStatusOnboarding(pool, medicoId, false);
    return res.json({ ok: true, status, medicoId });
  });

  app.post('/api/onboarding/whatsapp/iniciar', async (req, res) => {
    const { medicoId } = medicoAutorizado(res);
    const resultado = await conectarInstanciaWhatsappMedico(pool, {
      medicoId,
      modoConexao: req.body?.modoConexao === 'qrcode' ? 'qrcode' : 'codigo',
      telefoneConsultorio: req.body?.telefoneConsultorio,
      evolutionUrl: EVOLUTION_URL,
      evolutionApiKey: EVOLUTION_KEY,
      appWebhookUrl: WEBHOOK_DOCKER_ORIGIN,
      webhookSecret: WEBHOOK_SECRET,
      aoConectar: async id => boasVindas(`medico_${id.replace(/-/g, '').slice(0, 12)}`)
    });
    return res.json({ ...resultado, medicoId, revisaoCodigo: resultado.pairingCode ? randomBytes(8).toString('hex') : undefined });
  });

  app.get('/api/onboarding/whatsapp/status', async (req, res) => {
    const { medicoId } = medicoAutorizado(res);
    const resultado = await consultarStatusInstanciaWhatsapp(pool, {
      medicoId,
      consultarCodigo: req.query['consultarCodigo'] === '1',
      evolutionUrl: EVOLUTION_URL,
      evolutionApiKey: EVOLUTION_KEY,
      aoConectar: async id => boasVindas(`medico_${id.replace(/-/g, '').slice(0, 12)}`)
    });
    return res.json({ ...resultado, medicoId });
  });

  app.use('/api/whatsapp', criarRouterStatusWhatsapp({
    pool,
    autenticar: async token => authService.autenticarToken(token),
    consultar: medicoId => consultarStatusInstanciaWhatsapp(pool, {
      medicoId, evolutionUrl: EVOLUTION_URL, evolutionApiKey: EVOLUTION_KEY,
      aoConectar: async id => boasVindas(`medico_${id.replace(/-/g, '').slice(0, 12)}`)
    })
  }));

  app.use('/webhook/evolution/pareamento', criarRouterWebhookPareamento({
    pool,
    segredo: WEBHOOK_SECRET,
    confirmarConexao: async inst => {
      const r = await fetch(`${EVOLUTION_URL}/instance/connectionState/${encodeURIComponent(inst)}`, { headers: { apikey: EVOLUTION_KEY } }).catch(() => null);
      if (!r?.ok) return false;
      const d = (await r.json().catch(() => null)) as any;
      return d?.instance?.state === 'open';
    },
    aoConectar: boasVindas,
    aoReceberMensagemPaciente: msg => infraEmissao.tratarMensagemPacienteConsultorio(msg)
  }));

  app.use('/webhook/evolution', (req, _res, next) => {
    const ev = String(req.body?.event ?? '');
    const inst = String(req.body?.instance ?? '');
    const fromMe = Boolean(req.body?.data?.key?.fromMe);
    if (!fromMe && ev) {
      console.log(`[Dev Local <- Webhook] instance=${inst} event=${ev}`);
      const jid = String(req.body?.data?.key?.remoteJidAlt || req.body?.data?.key?.remoteJid || '');
      const tel = jid.split('@')[0]?.replace(/\D/g, '') ?? '';
      if (tel && ev.toLowerCase().replace(/_/g, '.') === 'messages.upsert') {
        filtroSaida.limparHistoricoTelefone(tel);
      }
    }
    next();
  }, criarRouterWebhookAgente({
    pool,
    ativo: true,
    envioAtivo: true,
    segredo: WEBHOOK_SECRET,
    instancia: instanciaAtiva.nome,
    allowlist: allowlistAtiva,
    apiKey: OPENAI_KEY,
    modeloNome: 'gpt-4.1-mini',
    painelUrl: ORIGEM_PUBLICA,
    persistirConversa: true,
    diagnosticoAtivo: true,
    memoriaConversa,
    carregarMemoriaNucleo: contaId => blocosMemoria.carregarParaPrompt(contaId),
    dispararSleepTime: contaId => sleepTimeMemoria.notificarTurno(contaId),
    registrarDiagnostico: reg => {
      const resumoTools = reg.agente.ferramentas.map(f => `${f.nome}:${f.codigo}`).join(', ') || 'nenhuma';
      console.log(`[Dev Local <- IA] resultado=${reg.agente.codigo} tools=[${resumoTools}]`);
    },
    consultarStatus: id => cofres.statusAgendas(id),
    enviar: (tel, texto, opcoes) => enviarWhatsappDireto(tel, texto, opcoes),
    serializarEnvio: (tel, fn) => filtroSaida.enfileirarEnvio(tel, fn),
    janelaCoalescenciaMs: 1400,
    mostrarOnline: true,
    pausaEntreBaloesMs: 350,
    marcarLida: async chave => {
      const r = await evolutionAgente.marcarLida({
        instanciaNome: instanciaAtiva.nome,
        contatoTelefone: chave.remoteJid.split('@')[0] ?? '',
        mensagemId: chave.id,
        chaveMensagem: chave
      });
      console.log(`[Dev Local -> Visualizado] ${r.sucesso ? 'OK' : `ERRO (${r.erro})`}`);
      return r.sucesso;
    },
    reagir: async (chave, emoji) => {
      const ok = await evolutionAgente.reagirMensagem(instanciaAtiva.nome, chave, emoji);
      console.log(`[Dev Local -> Reação ${emoji}] ${ok ? 'OK' : 'FALHOU'} (jid=${chave.remoteJid})`);
      return ok;
    },
    reacoesSeletivas: true,
    presenca: (tel, estado) => evolutionAgente.enviarPresenca(instanciaAtiva.nome, tel, estado),
    baixarMidia: (inst, msgId) => evolutionAgente.obterBase64MensagemMidia(inst, msgId),
    ...(transcritorAudio ? { transcreverAudio: midia => transcritorAudio.transcrever(midia) } : {}),
    ...(leitorComprovante ? { lerComprovante: midia => leitorComprovante.ler(midia) } : {}),
    processarComprovanteMedico: async entrada => {
      const r = await infraEmissao.orquestrador.processarComprovanteRecebido({
        contaId: entrada.contaId,
        origem: 'comprovante_medico',
        comprovante: entrada.comprovante,
        mensagemId: entrada.mensagemId,
        chaveMensagemMedico: entrada.chaveMensagem
      });
      console.log(`[Dev Local <- Comprovante] acao=${r.acao} motivo=${r.motivo ?? '-'}`);
      return r as unknown as Record<string, unknown>;
    },
    onboardingAutonomo: (contaId, telefone, chaveMensagem) => ({
      consultarEstadoConta: () => consultarEstadoProntidaoConta({
        pool, contaId,
        consultarAgendasPadrao: () => cofres.statusAgendas(cofreIdDaConta(contaId)),
        consultarAgendaGenerica: () => consultarAgendaGenerica(contaId)
      }),
      descobrirUrlAgendaOnline: nomeAgenda => descobrirUrlAgendaOnline(nomeAgenda, { fonteBusca: fonteBuscaOnline }),
      enviarLinkAgendaQualquer: async entrada => {
        if (entrada.provedor === 'tribemd' || entrada.provedor === 'amplimed') {
          const r = await cofres.solicitarLinkConta(contaId, entrada.provedor, telefone, { apenasUrl: true });
          return { ok: Boolean(r.ok && r.motivo === 'enviado'), motivo: String(r.motivo ?? '') };
        }
        return cofres.linksOnboarding!.criarLinkAgendaAdaptativa({
          contaId, provedor: entrada.provedor, nomeAgenda: entrada.nomeAgenda, urlPortal: entrada.urlPortal, telefone
        });
      },
      enviarLinkCadastroProfissionais: () => cofres.linksOnboarding!.criarLinkCadastroProfissionais({ contaId, telefone }),
      enviarLinkCertificadoIndividual: medicoId => cofres.linksOnboarding!.criarLinkCertificadoProfissional({ contaId, medicoId, telefone }),
      enviarLinkXmlIndividual: medicoId => cofres.linksOnboarding!.criarLinkXmlProfissional({ contaId, medicoId, telefone }),
      reconsultarDadosFiscaisCertificado: async medicoId => {
        const promessa = reconsultarFiscalPeloCertificadoSalvo(depsCert, { contaId, medicoId });
        const limite = Symbol('timeout');
        const corrida = await Promise.race([
          promessa,
          new Promise<typeof limite>(resolve => { const t = setTimeout(() => resolve(limite), 12_000); t.unref(); })
        ]);
        if (corrida !== limite) {
          if (corrida.fiscalImportado) {
            void infraEmissao.orquestrador.retomarCasosAguardandoProntidaoFiscal(contaId).catch(() => undefined);
          }
          return corrida;
        }
        void promessa.then(async res => {
          let extraRetomada = '';
          if (res.fiscalImportado) {
            const ret = await infraEmissao.orquestrador.retomarCasosAguardandoProntidaoFiscal(contaId).catch(() => null);
            if (ret && ret.enfileirados > 0) {
              extraRetomada = ` Também já coloquei na fila ${ret.enfileirados === 1 ? 'a nota' : 'as notas'} de ${ret.pacientesEnfileirados.join(', ')} que ${ret.enfileirados === 1 ? 'estava esperando' : 'estavam esperando'}.`;
            }
          }
          const texto = res.fiscalImportado
            ? `Pronto! Puxei seus dados fiscais pelo certificado (${res.resumoFiscal ?? 'cadastro atualizado'}, ${res.notasEncontradas ?? 1} notas encontradas). Já está tudo pronto para emissão em homologação.${extraRetomada}`
            : `Tentei puxar seus dados fiscais pelo certificado agora, mas não consegui concluir (${res.motivo ?? 'instabilidade no ADN'}). Quer tentar de novo ou enviar o XML manualmente?`;
          await enviarWhatsapp(telefone, texto);
          await memoriaConversa.registrarMensagem(contaId, 'noto', texto).catch(() => false);
          if (res.fiscalImportado && chaveMensagem) {
            await evolutionAgente.reagirMensagem(instanciaAtiva.nome, chaveMensagem, '✅').catch(() => false);
          }
        }).catch(() => undefined);
        return { ok: true, fiscalImportado: false, emAndamento: true, motivo: 'CONSULTANDO_ADN_EM_SEGUNDO_PLANO' };
      },
      salvarPreferenciasEmissao: async (atualizacao, falaMedico) => {
        const salvas = await salvarPreferenciasEmissaoConta(pool, contaId, atualizacao, falaMedico);
        console.log(`[Dev Local <- Preferências ${contaId.slice(0, 8)}]`, JSON.stringify(salvas));
        return salvas;
      },
      buscarMemoriaConversa: entrada => memoriaConversa.buscar({ contaId, ...entrada }),
      atualizarMemoriaNucleo: entrada => blocosMemoria.atualizarPeloAgente(contaId, entrada),
      consultarAgendaAtendimentos: filtro => consultarAgendaConta({
        contaId,
        filtro,
        aoConcluirAssincrono: async (texto, sucesso) => {
          for (const balao of separarBaloes(texto)) {
            await enviarWhatsapp(telefone, balao);
          }
          await memoriaConversa.registrarMensagem(contaId, 'noto', texto).catch(() => false);
          if (sucesso && chaveMensagem) {
            await evolutionAgente.reagirMensagem(instanciaAtiva.nome, chaveMensagem, '✅').catch(() => false);
          }
        }
      }),
      prepararEmissaoNota: entrada => infraEmissao.orquestrador.prepararEmissaoPeloMedico({
        contaId,
        ...entrada,
        chaveMensagemMedico: chaveMensagem ?? null
      }),
      prepararEmissaoPeriodoAgenda: entrada => infraEmissao.prepararEmissaoPeriodoComEspera({
        contaId,
        telefoneMedico: telefone,
        ...entrada,
        chaveMensagemMedico: chaveMensagem ?? null
      }),
      confirmarOuCancelarEmissao: entrada => infraEmissao.orquestrador.confirmarOuCancelarEmissao({ contaId, ...entrada }),
      vincularPagadorSecundario: entrada => infraEmissao.orquestrador.vincularPagadorSecundario({ contaId, ...entrada }),
      consultarEmissoesConta: () => infraEmissao.orquestrador.consultarEmissoesConta(contaId)
    })
  }));

  app.listen(PORTA, '0.0.0.0', () => {
    console.log(`[Noto Dev Local] Front-end ativo em ${ORIGEM_PUBLICA}`);
    console.log(`[Noto Dev Local] Instância WhatsApp oficial/agente conectada: ${instanciaAtiva.nome} (${instanciaAtiva.numero})`);
    console.log(`[Noto Dev Local] Webhook agente configurado em: ${WEBHOOK_DOCKER_ORIGIN}/webhook/evolution`);
    console.log(`[Noto Dev Local] OpenAI ativa: ${Boolean(OPENAI_KEY)} | Navegador: ${CHROMIUM_PATH || 'não detectado'}`);
  });
}

void iniciar().catch(err => {
  console.error('[Noto Dev Local] Falha ao iniciar:', err);
  process.exit(1);
});
