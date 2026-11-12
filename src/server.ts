import { registrarDiagnosticoAuditoria } from './agente/diagnostico.js';
import { tratarComandoEmissaoWhatsApp, tratarPropostaEmissaoWhatsApp } from './io/postgres/postgres-emissao-whatsapp-repositorio.js';
import { createHmac, randomBytes } from 'node:crypto';
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
import { criarRouterWebhookAgente } from './agente/webhook.js';
import { criarRouterWebhookPareamento } from './whatsapp/webhook-pareamento.js';
import { localizarContaExistentePorTelefone } from './agente/conta-existente.js';
import { enviarBoasVindasAposPareamento } from './agente/boas-vindas-pareamento.js';
import { gerarVariantesTelefoneBrasileiro } from './whatsapp/variantes-telefone-brasileiro.js';
import { separarBaloes } from './agente/baloes.js';
import {persistirDescobertaComprovada,persistirDescobertaAindaPendente} from './agente/descoberta-autenticada.js';
import { profissionaisIdentificados, descobrirProfissionaisDoFiltroAmplimed } from './agenda/profissionais-agenda.js';
import { confirmarMedicosDaConta } from './conta/medicos-conta.js';
import { nomeProfissionalValido } from './conta/validar-dados-emissao.js';
import { consultarPanoramaFiscalDaConta } from './agente/panorama-operacional.js';
import { conferirAgendaComFiscal, type LeituraParaConferencia } from './agente/conferencia-atendimentos.js';
import { janelaConferencia, leituraTribemdParaConferencia, leituraAmplimedParaConferencia } from './agente/leitura-atendimentos.js';
import { normalizarNomeMedico } from './conta/medicos-conta.js';
import { explicarLeituraPendente } from './agenda/diagnostico-descoberta.js';
import { contaDoCofreId, cofreIdDaConta } from './cofre/identidade-conta.js';
import type { AgendaEscolhida } from './agente/estado-conversa.js';
import { enfileirarTrabalhoNoto, listarTrabalhosNoto } from './agente/trabalhos-duraveis.js';
import { iniciarTrabalhosNoto } from './agente/worker-trabalhos.js';
import { continuarEventoComNoto, type EventoTrabalhoVerificado } from './agente/continuar-evento.js';
import { processarMidiaRecebida } from './whatsapp/ingestao-comprovante.js';
import { criarClassificadorOpenAi } from './whatsapp/classificar-documento.js';
import { lerEstadoConversa } from './agente/estado-conversa.js';
import { selecionarConsultaComprovante } from './agenda/fonte-agenda.js';
import { adiarConfirmacaoRegistro,agendarPesquisaRegistro,proporCorrecaoPesquisa,concluirRevisaoPesquisa,aprovarRegistroProfissional } from './agente/pesquisa-profissional-conversa.js';
import { registrarAceiteLink, diagnosticarRegistroEstadoEvolution, consultarEntregaLink } from './whatsapp/repositorio-entrega-link.js';
import {diagnosticarAceiteSaida,diagnosticarReciboSaida} from './whatsapp/diagnostico-envio-conversa.js';
import { reservarCustoPiloto,liquidarCustoPiloto } from './agente/limite-gasto-rodada.js';
import { classificarEnvioLinkEvolution } from './whatsapp/status-entrega-link.js';
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
import { adotarReferenciaConsentida, versaoConsentimentoFiscal } from './onboarding/fluxos/consentimento-fiscal.js';
import { salvarCertificadoMedico } from './onboarding/fluxos/salvar-certificado-medico.js';
import { conectarInstanciaWhatsappMedico } from './onboarding/io/conectar-instancia-whatsapp-medico.js';
import { consultarStatusInstanciaWhatsapp } from './onboarding/io/consultar-status-instancia-whatsapp.js';
import { consultarStatusOnboarding } from './onboarding/io/consultar-status-onboarding.js';
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
import { criarGuardaMedicoDaConta, medicoAutorizado } from './http/autorizar-medico-sessao.js';
import { codigoSeguroFalhaReady } from './http/diagnostico-ready.js';
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
    pool, enviarCofre: async (id, texto, contatoTelefone) => {
      if (!config.notoPilotoRestrito) return contaDoCofreId(id) ? 'erro' : comunicacaoHomologacao.cofre(id, texto);
      const permitidos = config.envioRealAllowlist ?? [];
      const variantes = gerarVariantesTelefoneBrasileiro(contatoTelefone ?? '');
      if (!contatoTelefone || permitidos.length !== 1 ||
          !gerarVariantesTelefoneBrasileiro(permitidos[0]!).some(v => variantes.includes(v))) return 'erro';
      const resultado = await new EvolutionApiClient(
        config.evolutionAssistantUrl, config.evolutionAssistantApiKey,
        config.evolutionOfficialInstanceName, config.evolutionOfficialInstanceName
      ).enviarTexto({
        instanciaNome: config.evolutionAssistantInstanceName, contatoTelefone, texto
      });
      return resultado.sucesso ? 'enviado' : 'erro';
    },
    // Somente o balão contendo a URL; nenhuma mudança de formato, domínio,
    // linkPreview ou canal nesta PR. HTTP 2xx = aceite, NUNCA entrega.
    enviarUrlComRecibo: async ({url,linkId,telefone}) => {
      if (!config.notoPilotoRestrito || config.envioRealAllowlist?.length!==1 ||
          !gerarVariantesTelefoneBrasileiro(config.envioRealAllowlist[0]!).some(v=>
            gerarVariantesTelefoneBrasileiro(telefone).includes(v))) return 'erro';
      const resultado=await new EvolutionApiClient(config.evolutionAssistantUrl,
        config.evolutionAssistantApiKey,config.evolutionOfficialInstanceName,
        config.evolutionOfficialInstanceName).enviarTexto({
          instanciaNome:config.evolutionAssistantInstanceName,
          contatoTelefone:telefone,texto:url,linkPreview:false
        });
      const classificacao=classificarEnvioLinkEvolution(resultado);
      if(classificacao!=='enviado')return classificacao;
      try {
        await registrarAceiteLink(pool,{
          linkId,instancia:config.evolutionAssistantInstanceName,
          mensagemId:resultado.mensagemId,telefone,
          segredo:config.evolutionAssistantWebhookSecret
        });
      } catch {
        // O aceite pode ter acontecido mesmo se persistência falhou:
        // não repetir o segredo e não afirmar que foi entregue.
        console.warn('COFRE_RECIBO_NAO_REGISTRADO');
      }
      return 'enviado';
    },
    aoConcluirConta: async (contaId, evento) => {
      // Resultado de uma sessão REAL do navegador. Não atribui identidade
      // clínica; apenas permite ao operador confirmar os nomes observados.
      if (!config.notoPilotoRestrito) return;
      const telefone=evento.contatoTelefone ?? '';
      const variantes=gerarVariantesTelefoneBrasileiro(telefone);
      const allowlist=config.envioRealAllowlist ?? [];
      if (!telefone || allowlist.length!==1 ||
        !gerarVariantesTelefoneBrasileiro(allowlist[0]!).some(v=>variantes.includes(v))) return;
      const autor=await pool.query(`
        select 1 from usuarios where conta_id=$1 and ativo=true and auth_user_id is not null
          and regexp_replace(telefone,'[^0-9]','','g')=any($2::text[])
        limit 1`,[contaId,variantes]);
      if (autor.rows.length!==1) return;
      // Evidência estruturada de leitura produzida antes de expirar o cache:
      // o registro não contém nomes, pacientes, consultas ou credenciais.
      if (evento.diagnosticoLeitura) console.info('NOTO_AGENDA_LEITURA',JSON.stringify(evento.diagnosticoLeitura));
      const plataforma=evento.agenda==='tribemd'?'TribeMD':'Amplimed';
      const nomes=evento.conectado
        ? evento.nomesDescobertos.filter(nomeProfissionalValido).slice(0,20) : [];
      // Navegador autenticado da CONTA: uma única operação atômica grava
      // nomes comprovados + CONFIRMACAO_PENDENTE, antes de qualquer balão.
      // Não copiar estado antigo nem usar merge genérico para autorizar vínculo.
      if (evento.conectado) {
        const persistido=nomes.length
          ? await persistirDescobertaComprovada(pool,contaId,evento.agenda,nomes,'cofre_sessao')
          : await persistirDescobertaAindaPendente(pool,contaId,evento.agenda);
        if(!persistido){
          console.warn('NOTO_COFRE_DESCOBERTA','CONFLITO_ESTADO');
          // Falha fechada: se mudou a agenda, houve vínculo ou concorrência,
          // não anunciar nomes como prontos sem prova persistida.
          return;
        }
        console.info('NOTO_COFRE_DESCOBERTA',
          nomes.length?'CONFIRMACAO_PERSISTIDA':'DESCOBERTA_PENDENTE');
        // Uma sessão conectada mas sem nomes não pode encerrar a missão.
        // Só uma leitura complementar por conta/agenda; a chave durável
        // impede repetir a navegação em loops de callback/reconexão.
        if(!nomes.length && process.env['NOTO_AGENT_TRABALHOS_ATIVO']==='true' &&
          config.notoAgentAtivo && config.notoAgentEnvioAtivo){
          const telefoneDestino=variantes.find(t=>/^55\d{10,11}$/.test(t));
          if(telefoneDestino){
            const chave='agenda-conectada-'+createHmac('sha256',config.evolutionAssistantWebhookSecret)
              .update(JSON.stringify([contaId,evento.agenda])).digest('hex').slice(0,32);
            const trabalho=await enfileirarTrabalhoNoto(pool,{
              contaId,instancia:config.evolutionAssistantInstanceName,mensagemId:chave,
              telefone:telefoneDestino,tipo:'descoberta_agenda',
              agenda:evento.agenda,medicoId:null
            });
            if(trabalho.ok)console.info('NOTO_COFRE_DESCOBERTA','LEITURA_COMPLEMENTAR_REGISTRADA');
          }
        }
      }
      if (!config.notoAgentEnvioAtivo) return;
      const diagnostico=evento.diagnosticoLeitura;
      const recuperacao=diagnostico?.recuperacaoPontual;
      const andamento=recuperacao==='MELHOROU' ? 'Concluí uma verificação adicional na mesma sessão.' :
        recuperacao==='SEM_MELHORIA' ? 'Fiz uma segunda leitura, mas ela ainda não ficou completa.' :
        recuperacao==='FALHOU' ? 'A tentativa adicional de leitura não terminou; o acesso continua conectado.' : null;
      const falhaAmplimed = evento.motivoAcesso === 'ASSINATURA_INATIVA'
        ? 'Consegui entrar na Amplimed. A conta está sem assinatura ativa, e a Amplimed bloqueia a agenda. Para eu conseguir ler os atendimentos, a assinatura precisa estar ativa.'
        : evento.motivoAcesso === 'ACESSO_CAPTCHA'
        ? 'A Amplimed pediu uma confirmação de que você é humano. Abra a Amplimed no seu navegador, conclua essa etapa e depois peça um novo link seguro para tentar a conexão novamente.'
        : evento.motivoAcesso === 'ACESSO_CODIGO_EMAIL_PENDENTE'
          ? 'A verificação por e-mail da Amplimed ficou pendente. Peça um novo link seguro para iniciar outra tentativa e espere eu pedir o código antes de responder.'
          : evento.motivoAcesso === 'ACESSO_RECUSADO'
            ? 'A Amplimed recusou o acesso. Confira se você consegue entrar na Amplimed e peça um novo link seguro para corrigir os dados.'
            : 'Ainda não consegui confirmar o login na Amplimed. Abra a Amplimed, confira se há alguma etapa pendente no acesso e peça um novo link seguro para tentar novamente.';
      const mensagens=!evento.conectado
        ? evento.agenda==='amplimed' ? [falhaAmplimed]
          : ['Ainda não consegui confirmar o acesso à agenda pela página segura.','A senha continua somente na página protegida.']
        : nomes.length
          ? [`Conexão com a ${plataforma} confirmada.`,
            ...(andamento?[andamento]:[]),
            `Identifiquei na agenda: ${nomes.join(', ')}.`,
            nomes.length===1
              ? `Você confirma vincular ${nomes[0]} à sua conta?`
              : 'Quais desses médicos você confirma vincular à sua conta?']
          : [`Conexão com a ${plataforma} confirmada.`,
            ...(andamento?[andamento]:[]),
            evento.agenda==='tribemd'
              ? explicarLeituraPendente(diagnostico)
              : 'A conexão não trouxe uma lista autenticada de médicos na Amplimed.',
            'Mantive a conexão e a descoberta pendente, sem vincular profissionais por suposição.'];
      for(const frase of mensagens) for(const balao of separarBaloes(frase)){
        const enviado=await new EvolutionApiClient(config.evolutionAssistantUrl,config.evolutionAssistantApiKey,
          config.evolutionOfficialInstanceName,config.evolutionOfficialInstanceName).enviarTexto({
          instanciaNome:config.evolutionAssistantInstanceName,contatoTelefone:telefone,texto:balao
        });
        if(!enviado.sucesso) return;
      }
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
  // Provedor de IA: OpenAI quando OPENAI_API_KEY está configurada; NVIDIA como legado. Mesma chave/modelo por finalidade.
  const iaOpenAiAtiva=!!config.openaiApiKey;
  const iaApiKey=iaOpenAiAtiva?config.openaiApiKey:config.nvidiaApiKey;
  const completarIa=iaOpenAiAtiva?completarOpenAi:completarNvidia;
  const iaModeloTexto=(iaOpenAiAtiva?config.openaiTextoModel:config.nvidiaRegistroModel) ?? '';
  const pesquisaCrmConfigurada=!!config.openserpBaseUrl&&!!iaApiKey;
  // Uma rodada não nasce implicitamente; a migração e abertura administrativa
  // precisam existir antes da PRIMEIRA chamada paga em homologação.
  const orcamentoPiloto=config.notoPilotoRestrito?pool:undefined;
  const completarRegistroComOrcamento=async(mensagens:import('./io/nvidia/chat-client.js').MensagemNvidia[])=>{
    const opcoes={temperature:0.1,formatoJson:true,timeoutMs:180_000,
      maxTokens:2048,tentativasMax:1 as const};
    if(!orcamentoPiloto)return completarIa(iaApiKey??'',iaModeloTexto,mensagens,opcoes);
    const reserva=await reservarCustoPiloto(orcamentoPiloto,'crm_rqe',iaModeloTexto);
    let uso:{entrada:number;saida:number}|null=null;
    try{
      const texto=await completarIa(iaApiKey??'',iaModeloTexto,mensagens,{
        ...opcoes,aoUso:(registro:{entrada:number;saida:number}|null)=>{uso=registro;}
      });
      await liquidarCustoPiloto(orcamentoPiloto,reserva,uso);
      return texto;
    }catch(erro){
      await liquidarCustoPiloto(orcamentoPiloto,reserva,null);
      throw erro;
    }
  };
  const consultaRegistro = pesquisaCrmConfigurada
    ? new OpenSerpConsultaRegistro({baseUrl:config.openserpBaseUrl,nvidiaApiKey:iaApiKey,modelo:iaModeloTexto,incluirDiagnostico:true,
        completar:completarRegistroComOrcamento})
    : new PesquisaRegistroIndisponivel();
  // Primeiro corte do Noto Agent: apenas leitura de conexões, com liberação explícita.
  // A instância de emissão/pacientes não é encaminhada para o agente.
  const transporteAgente = new EvolutionApiClient(
    config.evolutionAssistantUrl, config.evolutionAssistantApiKey,
    config.evolutionOfficialInstanceName, config.evolutionOfficialInstanceName
  );
  const boasVindasInstancia = async (nomeInstancia: string) => {
    // O piloto não pode reutilizar o canal de pacientes nem alcançar outros números.
    if (config.notoPilotoRestrito !== true || !config.notoAgentAtivo || !config.notoAgentEnvioAtivo ||
        config.envioRealAllowlist?.length !== 1 ||
        config.evolutionAssistantInstanceName === config.evolutionOfficialInstanceName) return;
    await enviarBoasVindasAposPareamento({
      pool, ativo: true, nomeInstancia, allowlist: config.envioRealAllowlist,
      enviar: async (telefone, texto) => {
        for (const balao of separarBaloes(texto)) {
          if (!await transporteAgente.enviarTexto({ instanciaNome: config.evolutionAssistantInstanceName, contatoTelefone: telefone, texto: balao }).then(r => r.sucesso)) return false;
        }
        return true;
      }
    });
  };
  // O polling expõe só a revisão opaca do último evento da própria instância.
  const chaveRevisaoPareamento = randomBytes(32);
  const revisoesPareamento = new Map<string, string>();
  const revisaoPareamento = (instancia: string, codigo: string) =>
    createHmac('sha256', chaveRevisaoPareamento).update(instancia + ':' + codigo.replace(/-/g, '').toUpperCase()).digest('hex');

  // Canal independente: mensagens do WhatsApp pareado jamais acionam o agente.
  app.use('/webhook/evolution/pareamento', criarRouterWebhookPareamento({
    pool, segredo: config.evolutionWebhookSecret,
    confirmarConexao: async instancia => {
      try {
        const resultado = await fetch(
          `${config.evolutionApiUrl.replace(/\/+$/, '')}/instance/connectionState/${encodeURIComponent(instancia)}`,
          { headers: { apikey: config.evolutionGlobalApiKey }, signal: AbortSignal.timeout(5000), redirect: 'error' }
        );
        if (!resultado.ok) return false;
        const corpo = await resultado.json();
        return corpo?.instance?.state === 'open';
      } catch { return false; }
    },
    aoAtualizarCodigo: (instancia, codigo) => {
      revisoesPareamento.delete(instancia);
      revisoesPareamento.set(instancia, revisaoPareamento(instancia, codigo));
      if (revisoesPareamento.size > 256) {
        const maisAntiga = revisoesPareamento.keys().next().value;
        if (maisAntiga) revisoesPareamento.delete(maisAntiga);
      }
    },
    aoConectar: boasVindasInstancia,
    ...(config.comprovantesRecepcaoAtiva && config.notoPilotoRestrito && orcamentoPiloto ? {
      aoReceberMidia: async (evento:import('./whatsapp/ingestao-comprovante.js').MidiaRecebida)=>{
        await processarMidiaRecebida(evento,{
          pool,
          remetentesAutorizados:config.comprovantesRemetentesTeste??[],
          operadorAutorizado:gerarVariantesTelefoneBrasileiro(config.envioRealAllowlist?.[0]??'').find(t=>/^55\d{10,11}$/.test(t))??'',
          carregarMidia:(instancia,mensagemId)=>evolutionClient.obterBase64MensagemMidia(instancia,mensagemId),
          classificador:{
            classificar:async midia=>{
              // O limite é reservado ANTES de enviar dados ao modelo.
              // Mesmo timeout retem a reserva se o uso não estiver comprovado.
              const reserva=await reservarCustoPiloto(orcamentoPiloto,'conversa',config.openaiVisaoModel??'gpt-4o-mini');
              let uso:{entrada:number;saida:number}|null=null;
              const classificador=criarClassificadorOpenAi(config.openaiApiKey!,config.openaiVisaoModel??'gpt-4o-mini',
                registro=>{uso=registro;});
              try{
                return await classificador.classificar(midia);
              }finally{
                await liquidarCustoPiloto(orcamentoPiloto,reserva,uso);
              }
            }
          },
          informarOperador:async (telefone,texto)=>{
            const resultado=await transporteAgente.enviarTexto({
              instanciaNome:config.evolutionAssistantInstanceName,
              contatoTelefone:telefone,texto
            });
            return resultado.sucesso;
          },
          consultarPossivelConsulta:async(contaId,_medicoReferenciaId,remetente,classe)=>{
            const estado=await lerEstadoConversa(pool,contaId);
            if(estado.agendaEscolhida!=='tribemd'||!estado.profissionalConfirmadoId)
              return {estado:'indisponivel' as const};
            const medico=await pool.query(
              'select nome_completo from public.medicos where id=$1 and conta_id=$2 limit 1',
              [estado.profissionalConfirmadoId,contaId]
            );
            const nome=medico.rows[0]?.nome_completo;
            if(typeof nome!=='string'||!nomeProfissionalValido(nome))
              return {estado:'indisponivel' as const};
            // Somente agenda autenticada da conta; não presume médico da
            // instância nem utiliza cadastro antigo como vínculo de paciente.
            const referencia=cofreIdDaConta(contaId);
            const status=await cofres.statusAgendas(referencia);
            if(!status.tribemd.conectada)return {estado:'indisponivel' as const};
            const leitura=await cofres.fonteAgenda.consultar({
              medicoId:estado.profissionalConfirmadoId,
              referenciaCofre:referencia,janelaDias:30
            });
            if(leitura.tipo!=='consultas')return {estado:'indisponivel' as const};
            const consultas=leitura.consultas.filter(p=>
              typeof p.profissional==='string' &&
              normalizarNomeMedico(p.profissional)===normalizarNomeMedico(nome));
            const r=selecionarConsultaComprovante(consultas,remetente,new Set(),
              classe.dataPagamento);
            if(r.tipo==='consulta'){
              const data=new Date(r.consulta.dataHora);
              if(!Number.isFinite(data.getTime()))return {estado:'indisponivel' as const};
              return {estado:'identificada' as const,
                dataConsulta:data.toLocaleDateString('sv-SE',{timeZone:'America/Sao_Paulo'}),
                profissional:nome};
            }
            return {estado: r.motivo==='MULTIPLAS_CONSULTAS_SEM_NOTA'?
              'ambiguo' as const:'indisponivel' as const};
          }
        });
      }
    }:{})
  }));
  const consultarConferenciaConta = async (contaId: string, medicoId: string, agenda: AgendaEscolhida, desde?:string) => {
      const janela=janelaConferencia(new Date(),desde);
      const dias=1+(Date.parse(janela.fim)-Date.parse(janela.inicio))/86_400_000;
      if(!Number.isInteger(dias)||dias<1||dias>365)return {ok:false,motivo:'RECORTE_MUITO_GRANDE'} as const;
      return conferirAgendaComFiscal(pool, contaId, medicoId, agenda, async (id,nome,fonte): Promise<LeituraParaConferencia> => {
        if (fonte==='tribemd') {
          const r=await cofres.fonteAgenda.consultar({medicoId:id,referenciaCofre:id,janelaDias:desde?Math.max(1,dias-1):30});
          return leituraTribemdParaConferencia(r,nome,janela);
        }
        // Amplimed já valida a escolha do código no filtro e o resourceId
        // de cada evento. Sem correspondência exata de nome: não ler.
        const lista=await cofres.listarProfissionaisAmplimed(id);
        if (!lista.ok) return {ok:false,motivo:'INTEGRACAO_INDISPONIVEL'};
        const encontrados=lista.profissionais.filter(p =>
          normalizarNomeMedico(p.nome)===normalizarNomeMedico(nome) && !!p.codigo?.trim());
        if (encontrados.length!==1) return {ok:false,motivo:'IDENTIDADE_INCOMPLETA'};
        const codigo=encontrados[0]!.codigo;
        if (lista.profissionais.filter(p=>p.codigo===codigo).length!==1) {
          return {ok:false,motivo:'IDENTIDADE_INCOMPLETA'};
        }
        const r=await cofres.lerAgendaAmplimed(id,janela.inicio,janela.fim,false,codigo);
        if (!r.ok) return {ok:false,motivo:'LEITURA_INCOMPLETA'};
        return leituraAmplimedParaConferencia(r.dias,janela);
      },desde?{inicio:desde,dias}:undefined);
  };
  const descobrirProfissionaisConta = async (medicoId: string, agenda: AgendaEscolhida) => {
      // Autoridade já verificada no webhook e estado confirmado na ferramenta;
      // devolver somente nomes, nunca o conteúdo de uma consulta.
      if (agenda === 'amplimed') {
        const r = await cofres.listarProfissionaisAmplimed(medicoId);
        return r.ok
          ? { ok: true, nomes: descobrirProfissionaisDoFiltroAmplimed(r.profissionais).tipo === 'profissionais'
              ? r.profissionais.map(p => p.nome).filter(nomeProfissionalValido).slice(0, 20) : [] }
          : { ok: false, motivo: r.motivo };
      }
      const r = await cofres.fonteAgenda.consultar({ medicoId, referenciaCofre: medicoId, janelaDias: 90 });
      return r.tipo === 'consultas'
        ? { ok: true, nomes: profissionaisIdentificados(r.consultas).filter(nomeProfissionalValido).slice(0, 20) }
        : { ok: false, motivo: r.codigo };
    
  };
  // A fila só é ativada explicitamente após a migração autorizada.
  const trabalhosHabilitados = process.env['NOTO_AGENT_TRABALHOS_ATIVO'] === 'true' &&
    config.notoPilotoRestrito === true && config.notoAgentAtivo === true &&
    config.notoAgentEnvioAtivo === true && (config.envioRealAllowlist?.length??0)===1;
  // Opt-in sem migração: a fila durável já existente é a origem dos eventos.
  // Nunca habilitar sem orçamento controlado e allowlist do piloto.
  const continuarEvento = trabalhosHabilitados &&
    process.env['NOTO_AGENT_CONTINUIDADE_EVENTOS_ATIVA'] === 'true'
    ? (evento:EventoTrabalhoVerificado) => continuarEventoComNoto(evento,{
        pool,consultarStatus:(referencia)=>cofres.statusAgendas(referencia),
        ...(config.openaiApiKey ? {apiKey:config.openaiApiKey}:{}),
        ...(config.openaiTextoModel ? {modeloNome:config.openaiTextoModel}:{}),
        ...(orcamentoPiloto ? {controleCusto:orcamentoPiloto}:{}),
        exigirControleCusto:true,
        tracesAtivos:config.notoAgentTracesAtivos
      })
    : undefined;
  app.locals.iniciarTrabalhos = () => trabalhosHabilitados ?
    iniciarTrabalhosNoto({
      pool,instancia:config.evolutionAssistantInstanceName,
      ...(orcamentoPiloto?{controleCusto:orcamentoPiloto}:{}),
      ...(continuarEvento ? {continuarEvento}:{}),
      descobrir:(contaId,medicoId,agenda) =>
        descobrirProfissionaisConta(medicoId??cofreIdDaConta(contaId),agenda),
      conferir:consultarConferenciaConta,
      ...(pesquisaCrmConfigurada&&config.envioRealAllowlist?.[0] ? {
        pesquisarRegistro:consultaRegistro,
        destinatarioPesquisa:gerarVariantesTelefoneBrasileiro(config.envioRealAllowlist[0])[0]!
      } : {}),
      enviar:async(telefone,texto) => {
        const permitido=config.envioRealAllowlist?.some(numero=>
          gerarVariantesTelefoneBrasileiro(numero).some(v=>
            gerarVariantesTelefoneBrasileiro(telefone).includes(v)));
        if(!permitido)return false;
        return (await transporteAgente.enviarTexto({
          instanciaNome:config.evolutionAssistantInstanceName,contatoTelefone:telefone,texto
        })).sucesso;
      },
      relatar:(codigo,duracaoMs,tipo)=>
        console.info('NOTO_AGENT_TRABALHO',JSON.stringify({codigo,duracaoMs,tipo}))
    }) : {parar:async()=>{}};
  let proximoLogSemNumeroPn = 0;
  app.use('/webhook/evolution', criarRouterWebhookAgente({
    pool,
    ativo: Boolean(config.notoAgentAtivo),
    envioAtivo: Boolean(config.notoAgentEnvioAtivo),
    segredo: config.notoAgentWebhookSecret ?? '',
    instancia: config.evolutionAssistantInstanceName,
    allowlist: config.envioRealAllowlist ?? [],
    painelUrl: config.appPublicOrigin,
    apiKey: config.openaiApiKey,
    modeloNome: config.openaiTextoModel,
    ...(orcamentoPiloto?{controleCusto:orcamentoPiloto}:{}),
    exigirControleCusto:Boolean(config.notoPilotoRestrito),
    tracesAtivos: config.notoAgentTracesAtivos,
    diagnosticoAtivo: config.notoPilotoRestrito && config.notoAgentDiagnosticoAtivo,
    registrarDiagnostico: (registro, contaId) =>
      registrarDiagnosticoAuditoria(pool, contaId, registro, config.notoAgentBuildRevisao ?? ''),
    ...(config.emissaoWhatsAppPropostaAtiva && config.emissaoWhatsAppProdutor ? {
      propostaEmissaoWhatsApp: (
        entrada:Parameters<typeof tratarPropostaEmissaoWhatsApp>[2],
        publicar:Parameters<typeof tratarPropostaEmissaoWhatsApp>[3]
      )=>tratarPropostaEmissaoWhatsApp(pool,config.emissaoWhatsAppProdutor!,entrada,publicar),
      enviarPropostaEmissao: async (telefone:string,texto:string)=>{
        const resultado = await transporteAgente.enviarTexto({
          instanciaNome:config.evolutionAssistantInstanceName,contatoTelefone:telefone,texto,linkPreview:false
        });
        return resultado.sucesso ? resultado.mensagemId ?? null : null;
      }
    } : {}),
    ...(config.emissaoWhatsAppProdutor ? {
      autorizarEmissaoWhatsApp: (contaId:string,texto:string,mensagemRef:string) =>
        tratarComandoEmissaoWhatsApp(pool,config.emissaoWhatsAppProdutor!,contaId,texto,mensagemRef)
    } : {}),
    consultarStatus: medicoId => cofres.statusAgendas(medicoId),
    consultarPanorama: (contaId, medicoIds) => consultarPanoramaFiscalDaConta(pool, contaId, medicoIds),
    ...(trabalhosHabilitados && pesquisaCrmConfigurada ? {
      agendarPesquisa: (contaId:string,medicoId:string,nome:string) =>
        agendarPesquisaRegistro(pool,contaId,medicoId,nome),
      solicitarLinkRegistro:async(contaId:string,medicoId:string,telefone:string,
        acao:'solicitar'|'consultar'|'substituir'='solicitar',mensagemId?:string)=>{
        const permitido=config.envioRealAllowlist?.length===1&&
          gerarVariantesTelefoneBrasileiro(config.envioRealAllowlist[0]!).some(v=>
            gerarVariantesTelefoneBrasileiro(telefone).includes(v));
        if(!permitido||!cofres.links)return {ok:false,motivo:'ENVIO_INDISPONIVEL'};
        return cofres.links.solicitarLinkRegistro(contaId,medicoId,telefone,acao,mensagemId);
      },
      adiarConfirmacaoRegistro:(contaId:string,medicoId:string)=>
        adiarConfirmacaoRegistro(pool,contaId,medicoId),
      aprovarRegistroProfissional:(contaId:string,medicoId:string,opcoes?:{confirmarRqe:boolean})=>
        aprovarRegistroProfissional(pool,contaId,medicoId,opcoes),
      proporCorrecaoPesquisa:(contaId:string,medicoId:string,dados:{crm:string;rqe?:string}) =>
        proporCorrecaoPesquisa(pool,contaId,medicoId,dados),
      concluirRevisaoPesquisa:(contaId:string,medicoId:string) =>
        concluirRevisaoPesquisa(pool,contaId,medicoId)
    } : {}),
    ...(trabalhosHabilitados ? {
      solicitarTrabalho: (pedido: import('./agente/trabalhos-duraveis.js').PedidoTrabalhoNoto) =>
        enfileirarTrabalhoNoto(pool,pedido),
      listarTrabalhos: (contaId:string,telefone:string,instancia:string) =>
        listarTrabalhosNoto(pool,contaId,telefone,instancia)
    } : {}),
    consultarConferencia: consultarConferenciaConta,
    consultarEntregaLink: async (referencia, agenda) => {
      const contaId=contaDoCofreId(referencia);
      if (!contaId) {
        const r=await pool.query('select conta_id from medicos where id=$1',[referencia]);
        if (!r.rows[0]?.conta_id) return null;
        return consultarEntregaLink(pool,r.rows[0].conta_id,agenda);
      }
      return consultarEntregaLink(pool,contaId,agenda);
    },
    ...(config.notoPilotoRestrito ? { receberCodigoAmplimed: (contaId: string | null, telefone: string, texto: string) => {
      const candidato = texto.trim();
      if (/^\d{6}$/.test(candidato)) return true;
      if (!/^amplimed\s+[a-f0-9]{8}(?:\s|$)/i.test(candidato)) return false;
      if (contaId) cofres.links?.receberCodigoAmplimed(contaId, telefone, candidato);
      return true;
    } } : {}),
    atualizarEstadoLink: async entrada => {
      const codigo=await diagnosticarRegistroEstadoEvolution(pool,entrada,
        config.evolutionAssistantInstanceName,config.evolutionAssistantWebhookSecret);
      // Recibos comuns não têm linha em cofre_links_entregas, mas devem ser
      // observáveis para distinguir API aceita de entrega ao WhatsApp.
      if(config.notoPilotoRestrito&&config.notoAgentDiagnosticoAtivo){
        const recibo=diagnosticarReciboSaida(config.evolutionAssistantWebhookSecret,
          config.evolutionAssistantInstanceName,config.envioRealAllowlist?.[0]??'',entrada);
        if(recibo)console.info('NOTO_MENSAGEM_SAIDA',JSON.stringify(recibo));
      }
      // Log classificado SEM ID, numero, token, URL, payload ou corpo da mensagem.
      if (codigo !== 'SEM_NUMERO_PN' || Date.now() >= proximoLogSemNumeroPn) {
        console.info('NOTO_RECIBO_LINK', codigo);
        if (codigo === 'SEM_NUMERO_PN') proximoLogSemNumeroPn = Date.now() + 60_000;
      }
      return codigo==='ATUALIZADO';
    },
    descobrirProfissionais: descobrirProfissionaisConta,
    confirmarProfissionais: async (medicoBaseId, nomes) => {
      if (!config.notoPilotoRestrito) return { ok: false, motivo: 'CONFIRMACAO_DESLIGADA' };
      const resultado = await confirmarMedicosDaConta(pool, medicoBaseId, nomes);
      return resultado.ok ? { ok: true, nomes: resultado.medicos.map(m => m.nomeCompleto),
          medicos:resultado.medicos.map(m=>({id:m.id,nome:m.nomeCompleto})) }
        : { ok: false, motivo: resultado.motivo };
    },
    solicitarLinkAgenda: async (medicoId, agenda, telefone) => {
      // A criação exige operador autenticado pela mesma conta, destino autorizado
      // e a instância fiscal de pacientes permanece desligada.
      const seguro = config.envioRealAllowlist?.length === 1 &&
        gerarVariantesTelefoneBrasileiro(config.envioRealAllowlist[0]!).some(v => gerarVariantesTelefoneBrasileiro(telefone).includes(v));
      if (!seguro || !cofres.links) return { aceitoParaEnvio: false, motivo:
        !seguro ? 'ENVIO_INDISPONIVEL' : !cofres.configuracaoOk ? 'INTEGRACAO_NAO_CONFIGURADA' : 'ENVIO_INDISPONIVEL' };
      const r = contaDoCofreId(medicoId)
        ? await cofres.solicitarLinkConta(contaDoCofreId(medicoId)!, agenda, telefone)
        : await cofres.links.solicitarLinkCofre(medicoId, agenda, { contatoTelefone: telefone });
      return {
        aceitoParaEnvio: Boolean(r.ok && r.motivo === 'enviado'),
        ...(!r.ok || r.motivo !== 'enviado' ? { motivo: String(r.motivo) } : {})
      };
    },
    salvarDadosProfissionais: async (medicoId, dados) => {
      if (!config.notoPilotoRestrito) return { ok: false, motivo: 'CADASTRO_CONVERSACIONAL_DESLIGADO' };
      try {
        const resultado = await salvarPerfilProfissional(pool, {
          medicoId, ...dados
        });
        return { ok: true, nome: resultado.nome, crm: resultado.crm, rqe: resultado.rqe };
      } catch {
        return { ok: false, motivo: 'DADOS_PROFISSIONAIS_NAO_GRAVADOS' };
      }
    },
    consultarProntidao: async medicoId => {
      const status = await consultarStatusOnboarding(pool, medicoId, false);
      return {
        certificadoValido: status.passos.passo3CertificadoValido,
        dadosProfissionaisCompletos: status.dadosProfissionaisCompletos && status.passos.passoProfissionalAprovado,
        dadosFiscaisConfirmados: status.passos.passo2FiscalConfirmado,
        liberadoParaEmitir: false // piloto: emissão sempre desligada, independentemente do cadastro.
      };
    },
    persistirConversa: Boolean(config.notoPilotoRestrito),
    marcarLida: async chave => (await transporteAgente.marcarLida({
      instanciaNome: config.evolutionAssistantInstanceName,
      contatoTelefone: chave.remoteJid.split('@')[0] ?? '',
      mensagemId: chave.id, chaveMensagem: chave
    })).sucesso,
    reagir: (chave, emoji) => transporteAgente.reagirMensagem(config.evolutionAssistantInstanceName, chave, emoji),
    presenca: (telefone, estado) => transporteAgente.enviarPresenca(config.evolutionAssistantInstanceName, telefone, estado),
    enviar: async (telefone, texto, opcoes) => {
      const resultado = await transporteAgente.enviarTexto({
        instanciaNome: config.evolutionAssistantInstanceName, contatoTelefone: telefone, texto,
        ...(opcoes?{linkPreview:opcoes.linkPreview}:{})
      });
      if(config.notoPilotoRestrito&&config.notoAgentDiagnosticoAtivo){
        const aceite=diagnosticarAceiteSaida(config.evolutionAssistantWebhookSecret,
          config.evolutionAssistantInstanceName,resultado);
        console.info('NOTO_MENSAGEM_SAIDA',JSON.stringify(aceite));
      }
      return resultado.sucesso;
    }
  }));

  const cadastroCertificado = new CadastroCertificado(new PostgresCadastro(pool), criarConsultaEmpresa(config.hubDesenvolvedorToken), consultaRegistro,
    async (medicoId, certificadoId) => {
      const cert = await carregarCertificadoMedico(pool, authAdminService.supabaseClient, medicoId);
      if (!cert || cert.id !== certificadoId) return undefined;
      return extrairChavesCertificado(cert.pfxBuffer, cert.senhaCertificado).documentoTitular;
    }, hubCpfClient ? cpf => hubCpfClient.consultar(cpf) : undefined, pesquisaCrmConfigurada, 'openserp');
  if (process.env.NODE_ENV !== 'test' && config.notoPilotoRestrito !== true) {
    const timer = setInterval(() => {
      // Enriquecimento automático via OpenSerp sem envio de perguntas no WhatsApp.
      void cadastroCertificado.recuperar().catch(() => console.warn('[Cadastro automático]', {codigo:'RECUPERACAO_FALHOU',acao:'verificar migrate:cadastro'}));
    }, 5000);
    timer.unref();
  }

  const adnNfseClient = new AdnNfseClient();

  const aoConectarWhatsapp = async (medicoId: string) => {
    const nomeInstancia = `medico_${medicoId.replace(/-/g, '').slice(0, 12)}`;
    await boasVindasInstancia(nomeInstancia);
  };

  // Healthcheck para o Easypanel
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Readiness inclui as colunas usadas pelo onboarding: um banco conectado
  // mas com schema incompleto nao pode receber novos cadastros.
  let ultimoAvisoReady = 0;
  app.get('/ready', async (_req: Request, res: Response) => {
    try {
      await pool.query(`select m.solicitar_cpf_direto_paciente,
          pf.proximo_numero_dps, pf.serie_dps, pf.opcao_simples_nacional,
          pf.extraido_automaticamente, pf.dados_reforma_tributaria,
          msf.aliquota_iss, msf.parametros_emissao,
          t.medico_id, w.nome_instancia
        from medicos m
        left join medico_perfil_fiscal pf on pf.medico_id=m.id
        left join medico_servicos_fiscais msf on msf.medico_id=m.id
        left join cadastro_certificado_trabalhos t on t.medico_id=m.id
        left join whatsapp_instancias w on w.medico_id=m.id
        limit 0`);
      if (config.notoPilotoRestrito === true) {
        // Bloqueia lançamento do piloto sem a reserva durável contra duplicidade.
        await pool.query('select conta_id from noto_boas_vindas_pareamento limit 0');
        await pool.query('select conta_id from noto_agent_conversas limit 0');
        await pool.query('select conta_id from noto_agent_mensagens limit 0');
      }
      res.json({ status: 'ready' });
    } catch (erro) {
      // Nunca registrar a mensagem do driver (pode conter URL/credenciais).
      // Limita o volume para healthchecks frequentes.
      if (Date.now() - ultimoAvisoReady > 60_000) {
        ultimoAvisoReady = Date.now();
        console.warn('[ready] schema_ou_banco_indisponivel', { codigo: codigoSeguroFalhaReady(erro) });
      }
      res.status(503).json({ status: 'unavailable' });
    }
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
      // NFS-e: somente sessão Supabase Auth verificada. Nunca interpretar token
      // como medicos.id/usuarios.id nem usar resolvedor com INSERT implícito.
      try {
        const { data, error } = await authAdminService.supabaseClient.auth.getUser(token);
        if (error || !data.user?.id) return null;
        const { rows } = await pool.query(`
          select m.id from usuarios u
          join medicos m on m.usuario_id = u.id and m.conta_id = u.conta_id
          where u.auth_user_id = $1 and u.ativo = true
          limit 2
        `, [data.user.id]);
        // A API legada recebe um token, não uma seleção explícita de médico:
        // recusar vínculo ambíguo em vez de usar o primeiro arbitrariamente.
        return rows.length === 1 ? String(rows[0]!.id) : null;
      } catch {
        return null;
      }
    }
  });
  // O piloto restrito permite leitura fiscal legada, mas não aceita criar solicitações.
  // Mesmo com um token válido, nenhuma rota POST de NFS-e deve enfileirar emissão.
  const bloquearEmissaoPiloto = (req: Request, res: Response, next: () => void) => {
    if (config.notoPilotoRestrito === true && req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(503).json({ ok: false, codigo: 'EMISSAO_DESLIGADA_NA_HOMOLOGACAO' });
      return;
    }
    next();
  };
  app.use('/api/v1/nfse', bloquearEmissaoPiloto, routerNfse);
  app.use('/v2/nfse', bloquearEmissaoPiloto, routerNfse);
  app.use('/v2/nfsen', bloquearEmissaoPiloto, routerNfse);

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

      if (config.notoPilotoRestrito === true) {
        const permitidos = config.envioRealAllowlist ?? [];
        const variantes = gerarVariantesTelefoneBrasileiro(String(telefone));
        if (permitidos.length !== 1 || !variantes.some(v =>
          gerarVariantesTelefoneBrasileiro(permitidos[0]!).includes(v))) {
          return res.status(403).json({ ok: false, motivo: 'telefone_nao_autorizado' });
        }
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

      // Só o telefone explicitamente autorizado usa o login piloto
      // "conta existente apenas"; demais usuários mantêm o login normal.
      const allowlistTeste = config.envioRealAllowlist ?? [];
      const testeAutorizado = allowlistTeste.length === 1 &&
        gerarVariantesTelefoneBrasileiro(String(telefone ?? '')).some(
          v => gerarVariantesTelefoneBrasileiro(allowlistTeste[0]!).includes(v));
      const resultado = await autenticarComOtp(telefone, codigo, {
        otpRepositorio: otpRepo,
        authAdminService,
        pepper: config.appPepper,
        localizarContaExistente: config.notoAgentLoginContaExistenteApenas && testeAutorizado
          ? numero => localizarContaExistentePorTelefone(pool, numero)
          : undefined
      });

      if (!resultado.ok) {
        return res.status(401).json(resultado);
      }

      // Nenhuma boas-vindas no OTP. O envio só ocorre após OPEN real na Evolution.
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

  // O mesmo token Supabase emitido no OTP é validado antes de QUALQUER
  // operação nessas rotas. A consulta de vínculo nunca cria registros.
  const rotasProtegidas = [
    '/api/onboarding/confirmar-fiscal', '/api/onboarding/certificado',
    '/api/onboarding/nome', '/api/conta/perfil', '/api/conta/preferencias',
    '/api/onboarding/buscar-referencia', '/api/onboarding/xml',
    '/api/onboarding/status', '/api/onboarding/whatsapp/iniciar',
    '/api/onboarding/whatsapp/status'
  ];
  app.use(rotasProtegidas, criarGuardaMedicoDaConta({
    pool,
    autenticar: async token => {
      const { data, error } = await authAdminService.supabaseClient.auth.getUser(token);
      return error ? null : data.user?.id ?? null;
    }
  }));

  // --- ROTAS DO ONBOARDING MÉDICO (5 PASSOS) ---

  // Passo 0: Status Geral do Onboarding
  app.get('/api/onboarding/status', async (req: Request, res: Response) => {
    try {
      // Guard já verificou sessão + vínculo sem SELECT sensível nem criação.
      const { medicoId } = medicoAutorizado(res);
      let status = await consultarStatusOnboarding(pool, medicoId, config.preparacaoFiscalAtiva);
      // Reconcile an outdated local record before asking an already linked user to pair again.
      if (status.passos.passo4WhatsappVinculado && !status.passos.passo4WhatsappConectado) {
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
      const { nome } = req.body || {};
      const { medicoId, usuarioId, medicoUsuarioId } = medicoAutorizado(res);
      if (!nome || typeof nome !== 'string' || nome.trim().length < 2) {
        return res.status(400).json({ ok: false, detalhe: 'Nome completo é obrigatório' });
      }
      const nomeLimpo = nome.trim();
      await pool.query('update medicos set nome_completo = $2, atualizado_em = now() where id = $1', [medicoId, nomeLimpo]);
      // A atualização de identidade da conta só alcança o próprio usuário.
      if (medicoUsuarioId === usuarioId) {
        await pool.query('update usuarios set nome = $2, atualizado_em = now() where id = $1', [usuarioId, nomeLimpo]);
      }
      return res.json({ ok: true, nome: nomeLimpo, medicoId });
    } catch (err: any) {
      return res.status(500).json({ ok: false, detalhe: err?.message || 'Erro ao salvar nome' });
    }
  });

  // Atualizar Perfil do Médico (Nome, CRM, RQE) na aba Conta
  app.post('/api/conta/perfil', async (req: Request, res: Response) => {
    try {
      const { nome, crm, rqe, email } = req.body || {};
      const { medicoId, usuarioId, medicoUsuarioId } = medicoAutorizado(res);
      const proprioUsuario = medicoUsuarioId === usuarioId;
      if (!proprioUsuario && email !== undefined) {
        return res.status(403).json({ ok: false, detalhe: 'E-mail de outro usuário não pode ser alterado' });
      }
      const perfil = await salvarPerfilProfissional(pool, {
        medicoId, nome, crm, rqe, email, atualizarUsuarioVinculado: proprioUsuario,
        ...(proprioUsuario ? { usuarioId } : {})
      });
      await dadosProfissionais.retomar(medicoId);
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
      const { solicitarCpfDiretoPaciente } = req.body || {};
      const { medicoId } = medicoAutorizado(res);
      const resultado = await salvarPreferenciasMedico(pool, {
        medicoId,
        solicitarCpfDiretoPaciente: Boolean(solicitarCpfDiretoPaciente)
      });
      return res.json({ ok: true, ...resultado });
    } catch (err: any) {
      return res.status(400).json({ ok: false, detalhe: err?.message || 'Erro ao salvar preferências' });
    }
  });

  const escopoFiscalPiloto = (medicoId:string) =>
    config.ambienteEmissaoWhatsApp?.medicoId === medicoId
      ? {contaPilotoHomologacao:config.ambienteEmissaoWhatsApp.contaId} : {};

  // Nova consulta usando o A1 já armazenado; nenhuma cidade é fixada no código.
  app.post('/api/onboarding/buscar-referencia', async (req: Request, res: Response) => {
    try {
      if (!req.body?.medicoId) return res.status(400).json({ ok: false, detalhe: 'Médico não informado.' });
      const { medicoId } = medicoAutorizado(res);
      const certificado = await carregarCertificadoMedico(pool, authAdminService.supabaseClient, medicoId);
      if (!certificado) throw new Error('Cadastre seu certificado A1 para localizar a nota.');
      const titular = extrairChavesCertificado(certificado.pfxBuffer, certificado.senhaCertificado);
      if (!titular.documentoTitular || !titular.validoAte || titular.validoAte < new Date()
        || (titular.validoDe && titular.validoDe > new Date())) throw new Error('O certificado precisa estar válido e identificar seu titular.');
      const consulta = await adnNfseClient.buscarNfseMaisRecente(certificado.pfxBuffer, certificado.senhaCertificado, titular.documentoTitular);
      console.info('[ADN] Busca de referência concluída:', consulta.resumo);
      const fiscal = await processarOnboardingXml({
        pool, supabase: authAdminService.supabaseClient,
        documentoTitularEsperado: titular.documentoTitular, chaveCriptografia: config.encryptionKey, ...escopoFiscalPiloto(medicoId), pepperCpf: config.appPepper
      },
        medicoId, consulta.documento.xml);
      const adocaoFiscal = await adotarReferenciaConsentida({ pool, preparacaoFiscalAtiva: Boolean(config.preparacaoFiscalAtiva), ...escopoFiscalPiloto(medicoId) },
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
      const { medicoId } = medicoAutorizado(res);
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
          ...escopoFiscalPiloto(medicoId), pepperCpf: config.appPepper
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
      const { medicoId } = medicoAutorizado(res);
      const {contaPilotoHomologacao}=escopoFiscalPiloto(medicoId);
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
      }, ...(contaPilotoHomologacao?[contaPilotoHomologacao] as const:[]));

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
      const { medicoId: medicoIdRaw, arquivoBase64, senha, consentimentoFiscal } = req.body || {};
      if (consentimentoFiscal !== versaoConsentimentoFiscal) {
        return res.status(400).json({ ok: false, detalhe: 'Atualize a página antes de continuar com o certificado.' });
      }
      if (!medicoIdRaw || !arquivoBase64 || !senha) {
        return res.status(400).json({ ok: false, detalhe: 'medicoId, arquivo e senha são obrigatórios' });
      }
      const { medicoId, usuarioId } = medicoAutorizado(res);
      const arquivoBuffer = Buffer.from(arquivoBase64, 'base64');

      let certificado: ReturnType<typeof extrairChavesCertificado>;
      try {
        certificado = extrairChavesCertificado(arquivoBuffer, senha);
      } catch (err: any) {
        return res.status(400).json({
          ok: false,
          detalhe: `Certificado A1 ou senha invalidos: ${err?.message || 'nao foi possivel abrir o arquivo'}`
        });
      }

      const { validoDe, validoAte, documentoTitular } = certificado;
      const agora = Date.now();
      if (!validoDe || !validoAte || !Number.isFinite(validoDe.getTime()) || !Number.isFinite(validoAte.getTime())) {
        return res.status(400).json({ ok: false, detalhe: 'Não consegui verificar as datas do certificado A1.' });
      }
      if (validoDe.getTime() > agora || validoAte.getTime() <= agora) {
        return res.status(400).json({ ok: false, detalhe: 'O certificado A1 está fora do período de validade.' });
      }

      const resultado = await salvarCertificadoMedico(pool, authAdminService.supabaseClient, {
        medicoId,
        arquivoBuffer,
        usuarioId, validoDe, validoAte,
        senhaCertificado: senha
      });

      await cadastroCertificado.agendar({medicoId, certificadoId:resultado.certificadoId, documentoTitular}).catch(() =>
        console.warn('[Cadastro automático]', {codigo:'AGENDAMENTO_FALHOU'}));

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
            ...escopoFiscalPiloto(medicoId), pepperCpf: config.appPepper
          },
          medicoId,
          consulta.documento.xml
        );

        const adocaoFiscal = await adotarReferenciaConsentida({ pool, preparacaoFiscalAtiva: Boolean(config.preparacaoFiscalAtiva), ...escopoFiscalPiloto(medicoId) },
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
      console.error('Erro ao salvar certificado:', { codigo: err?.code, mensagem: err?.message });
      return res.status(500).json({ ok: false, detalhe: 'Não foi possível salvar o certificado. Tente novamente.' });
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
      const { medicoId } = medicoAutorizado(res);
      // Conectar WhatsApp antes do onboarding fiscal; dados profissionais serão solicitados na conversa.
      const appUrl = config.pareamentoWebhookOrigin;
      if (!appUrl || !/^https:\/\/[^/]+$/i.test(appUrl)) {
        return res.status(503).json({ ok: false, detalhe: 'APP_PUBLIC_ORIGIN HTTPS é obrigatório para pareamento.' });
      }

      const nomeInstancia = `medico_${medicoId.replace(/-/g, '').slice(0, 12)}`;
      const revisaoAntesDaConsulta = revisoesPareamento.get(nomeInstancia);
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
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ...resultado, medicoId, revisaoAntesDaConsulta, revisaoCodigo: resultado.pairingCode
        ? revisaoPareamento(resultado.nomeInstancia, resultado.pairingCode) : undefined });
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
      const { medicoId } = medicoAutorizado(res);
      const nomeInstancia = `medico_${medicoId.replace(/-/g, '').slice(0, 12)}`;
      const revisaoAntesDaConsulta = revisoesPareamento.get(nomeInstancia);
      const resultado = await consultarStatusInstanciaWhatsapp(pool, {
        consultarCodigo: req.query['consultarCodigo'] === '1',
        medicoId,
        evolutionUrl: config.evolutionApiUrl,
        evolutionApiKey: config.evolutionGlobalApiKey,
        aoConectar: aoConectarWhatsapp
      });

      res.setHeader('Cache-Control', 'no-store');
      const revisaoCodigo = resultado.pairingCode
        ? revisaoPareamento(nomeInstancia, resultado.pairingCode)
        : resultado.state === 'connecting' ? revisoesPareamento.get(nomeInstancia) : undefined;
      return res.json({ ...resultado, medicoId, revisaoCodigo,
        revisaoAntesDaConsulta: resultado.pairingCode ? revisaoAntesDaConsulta : undefined });
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
  // Banco real do piloto NUNCA pode ser aberto pelo servidor completo, que
  // mantém rotas mutáveis e o recuperador automático de cadastro profissional.
  if (process.env['NOTO_AGENT_PILOTO_DATABASE_URL']) {
    throw new Error('PILOTO_EXIGE_ENTRYPOINT_EXCLUSIVO_START_PILOTO_AGENTE');
  }
  const app = criarAppExpress();
  const servidor = app.listen(config.porta, config.host, () => {
    console.log(`[Notomed Whats] Servidor rodando em http://${config.host}:${config.porta}`);
  });
  servidor.on('error', (erro) => {
    console.error(`[Notomed Whats] Falha ao abrir ${config.host}:${config.porta}:`, erro.message);
    process.exit(1);
  });

  // Inicia worker da fila em segundo plano no mesmo container
  const worker = config.workerEmbutidoAtivo === false
    ? { parar: async () => {} }
    : iniciarWorkerEmbutido(pool, config);
  const workerAgente = app.locals.iniciarTrabalhos();
  console.log(config.workerEmbutidoAtivo === false
    ? '[Notomed Whats] Worker embutido desativado por configuração.'
    : '[Notomed Whats] Worker de fila NFS-e iniciado com sucesso.');

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
    pararWorker: async () => { await Promise.allSettled([worker.parar(), workerAgente.parar()]); },
    fecharPool: () => pool.end()
  }, { tempoLimiteMs: 8_000, sair: (codigo) => process.exit(codigo) }));
}
