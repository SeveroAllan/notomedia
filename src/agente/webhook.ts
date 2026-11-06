import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';
import { responderAgente, type StatusFontes } from './agente.js';
import type { AgendaEscolhida, EstadoConversa } from './estado-conversa.js';
import {
  alvoExplicito, cancelouTarefas, classificarPedidoTarefa, finalizarPedido,
  registrarPedido, selecionarConclusao, validarTarefas,
  type ComprovanteTarefa, type TarefaPendente
} from './tarefas.js';
import { separarBaloes, reacaoContextual } from './baloes.js';
import {
  lerEstadoConversa, reservarMensagemConversa, registrarBalaoConversa,
  finalizarMensagemConversa, evoluirEstadoConversa, salvarEstadoConversa
} from './estado-conversa.js';
import type { Model } from '@openai/agents';
import { referenciaDiagnostica, type DiagnosticoAgente, type DiagnosticoMensagem } from './diagnostico.js';
import { nomeProfissionalValido } from '../conta/validar-dados-emissao.js';
import { cofreIdDaConta } from '../cofre/identidade-conta.js';
import type { ResultadoPanoramaFiscal, PanoramaFiscal } from './panorama-operacional.js';
import type { ResultadoConferencia } from './conferencia-atendimentos.js';
import type { PedidoTrabalhoNoto, ResultadoEnfileirar, SituacaoTrabalhoNoto } from './trabalhos-duraveis.js';
import { registrarVinculoConversa } from './vinculo-conversa.js';

export interface ChaveMensagemRecebida { id: string; remoteJid: string; fromMe: boolean }
const eventoSchema = z.object({
  instance: z.string(),
  event: z.string().optional(),
  data: z.object({
    key: z.object({
      id: z.string().min(1), remoteJid: z.string(), fromMe: z.boolean()
    }).passthrough(),
    message: z.object({
      conversation: z.string().optional(),
      extendedTextMessage: z.object({ text: z.string().optional() }).passthrough().optional()
    }).passthrough().optional()
  }).passthrough()
}).passthrough();

function segredoIgual(recebido: string | undefined, esperado: string): boolean {
  if (!recebido || !esperado) return false;
  const a = createHash('sha256').update(recebido).digest();
  const b = createHash('sha256').update(esperado).digest();
  return timingSafeEqual(a, b);
}

/** Apenas a instância do assistente. Nenhum efeito é disparado antes da autorização. */
export function criarRouterWebhookAgente(deps: {
  pool: pg.Pool;
  ativo: boolean;
  envioAtivo: boolean;
  segredo: string;
  instancia: string;
  allowlist: string[];
  apiKey?: string;
  modeloNome?: string;
  tracesAtivos?: boolean;
  modeloTeste?: Model;
  /** Banco de orçamento do piloto, com fail closed se indisponível. */
  controleCusto?:pg.Pool;
  diagnosticoAtivo?: boolean;
  registrarDiagnostico?: (registro: DiagnosticoMensagem) => void;
  consultarStatus: (medicoId: string) => Promise<StatusFontes>;
  consultarPanorama?: (contaId: string, medicoIds: string[]) => Promise<ResultadoPanoramaFiscal>;
  consultarConferencia?: (contaId: string, medicoId: string, agenda: AgendaEscolhida) => Promise<ResultadoConferencia>;
  solicitarTrabalho?: (pedido: PedidoTrabalhoNoto) => Promise<ResultadoEnfileirar>;
  listarTrabalhos?: (contaId: string, telefone: string, instancia: string) => Promise<SituacaoTrabalhoNoto[]>;
  descobrirProfissionais?: (medicoId: string, agenda: AgendaEscolhida) => Promise<{ ok: boolean; nomes?: string[]; motivo?: string }>;
  confirmarProfissionais?: (medicoBaseId: string, nomes: string[]) => Promise<{
    ok:boolean;nomes?:string[];motivo?:string;medicos?:{id:string;nome:string}[]
  }>;
  agendarPesquisa?: (contaId:string,medicoId:string,nome:string) => Promise<'agendada'|'ja_existe'|'indisponivel'>;
  solicitarLinkRegistro?: (contaId:string,medicoId:string,telefone:string,
    acao:'solicitar'|'consultar'|'substituir',mensagemId:string)=>Promise<{ok:boolean;motivo?:string;anteriorInvalidado?:boolean}>;
  aprovarRegistroProfissional?: (contaId:string,medicoId:string)=>Promise<{ok:true;nome:string;crm:string;rqe:string|null}|{ok:false;motivo:string}>;
  proporCorrecaoPesquisa?: (contaId:string,medicoId:string,dados:{crm:string;rqe?:string})=>Promise<boolean>;
  concluirRevisaoPesquisa?: (contaId:string,medicoId:string)=>Promise<boolean>;
  salvarDadosProfissionais?: (medicoId: string, dados: { nome?: string; crm?: string; rqe?: string }) => Promise<{ ok: boolean; nome?: string; crm?: string | null; rqe?: string | null; motivo?: string }>;
  solicitarLinkAgenda?: (medicoId: string, agenda: AgendaEscolhida, telefone: string) => Promise<{ aceitoParaEnvio: boolean; motivo?: string }>;
  consultarEntregaLink?: (referencia: string, agenda: AgendaEscolhida) => Promise<{estado:string; comId:boolean; segundosDesdeAceite:number}|null>;
  atualizarEstadoLink?: (evento:unknown) => Promise<boolean>;
  consultarProntidao?: (medicoId: string) => Promise<{ certificadoValido: boolean; dadosProfissionaisCompletos: boolean; dadosFiscaisConfirmados: boolean; liberadoParaEmitir: boolean }>;
  enviar: (telefone: string, texto: string) => Promise<boolean>;
  painelUrl?: string;
  persistirConversa?: boolean;
  marcarLida?: (chave: ChaveMensagemRecebida) => Promise<boolean>;
  reagir?: (chave: ChaveMensagemRecebida, emoji: '👍' | '❤️' | '🔎' | '👀' | '✅') => Promise<boolean>;
  presenca?: (telefone: string, estado: 'composing' | 'paused') => Promise<boolean>;
}) {
  const router = Router();
  // Compatibilidade de testes e processo de leitura sem permissão de escrita.
  // O servidor principal usa a reserva durável abaixo para sobreviver a réplicas.
  const mensagensVistas = new Set<string>();
  const contextoPorConta = new Map<string, string[]>();
  // Somente no piloto read-only; no modo durável o banco é a autoridade.
  const tarefasEmMemoria = new Map<string, TarefaPendente[]>();

  // byEvents=true adiciona /messages-update. Mesmo handler autenticado
  // da rota-base, sem mudar a configuracao ativa da Evolution.
  router.post(['/', '/messages-update'], async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // Eventos de recibo autenticados sao passivos: nao disparam IA, nao
    // enviam mensagem e nao consomem URL, inclusive com IA pausada.
    const possivelRecibo=typeof req.body?.event==='string' &&
      req.body.event.toLowerCase().replace('_','.')==='messages.update';
    if (possivelRecibo) {
      if (!segredoIgual(req.header('x-webhook-secret'),deps.segredo)) {
        console.info('NOTO_RECIBO_LINK','AUTENTICACAO_RECUSADA');
        res.sendStatus(401); return;
      }
      if (req.body?.instance!==deps.instancia) {
        console.info('NOTO_RECIBO_LINK','OUTRA_INSTANCIA');
        res.sendStatus(204); return;
      }
      try {
        if(deps.atualizarEstadoLink) await deps.atualizarEstadoLink(req.body);
        // No servidor, a funcao registra codigo detalhado sem payload.
        res.sendStatus(200);
      } catch {
        console.warn('NOTO_RECIBO_LINK','PROCESSAMENTO_INDISPONIVEL');
        res.sendStatus(503);
      }
      return;
    }
    if (!deps.ativo || !deps.envioAtivo) { res.sendStatus(204); return; }
    if (!segredoIgual(req.header('x-webhook-secret'), deps.segredo)) {
      res.sendStatus(401); return;
    }
    const parsed = eventoSchema.safeParse(req.body);
    if (!parsed.success) { res.sendStatus(204); return; }
    const evento = parsed.data;
    if (evento.instance !== deps.instancia || evento.event?.toLowerCase() !== 'messages.upsert' || evento.data.key.fromMe) {
      res.sendStatus(204); return;
    }
    const jid = /^(\d{10,13})@s\.whatsapp\.net$/.exec(evento.data.key.remoteJid);
    const telefone = jid?.[1];
    const texto = evento.data.message?.conversation || evento.data.message?.extendedTextMessage?.text || '';
    if (!telefone || !texto.trim() || texto.length > 1500) { res.sendStatus(204); return; }
    const variantes = gerarVariantesTelefoneBrasileiro(telefone);
    if (deps.allowlist.length !== 1 ||
        !gerarVariantesTelefoneBrasileiro(deps.allowlist[0]!).some(v => variantes.includes(v))) {
      res.sendStatus(204); return;
    }

    // Banco é a autoridade do modo durável. Não marcar localmente antes do
    // SELECT/reserva: uma falha transitória ainda precisa permitir replay.
    if (!deps.persistirConversa) {
      const chave = createHash('sha256').update(JSON.stringify([evento.instance, evento.data.key.id, telefone])).digest('hex');
      if (mensagensVistas.has(chave)) { res.sendStatus(200); return; }
      mensagensVistas.add(chave);
      if (mensagensVistas.size > 2500) {
        const primeiro = mensagensVistas.values().next().value;
        if (primeiro) mensagensVistas.delete(primeiro);
      }
    }

    let reservada = false;
    let contaId: string | null = null;
    let digitando = false;
    let intervalo: ReturnType<typeof setInterval> | undefined;
    let presencaPendente: Promise<void> = Promise.resolve();
    // Serializa renovação e parada: um composing atrasado não pode chegar
    // depois do paused. Na falha do provedor, o atendimento segue.
    const renovarPresenca = (): Promise<void> => {
      presencaPendente = presencaPendente.then(async () => {
        if (!digitando || !deps.presenca) return;
        try { await deps.presenca(telefone, 'composing'); } catch { /* Efeito opcional. */ }
      });
      return presencaPendente;
    };
    let enviado = false;
    try {
      const conta = await deps.pool.query(
        "select distinct conta_id from usuarios where ativo=true and auth_user_id is not null and conta_id is not null and regexp_replace(telefone, '[^0-9]', '', 'g') = any($1::text[]) limit 2",
        [variantes]
      );
      if (conta.rows.length > 1) { res.sendStatus(204); return; }
      contaId = conta.rows[0]?.conta_id ?? null;
      // Somente SELECT sem resultado é evidência de conta ausente.
      // Uma falha de consulta cai no catch e jamais é tratada como ausência.
      const medicos = contaId ? await deps.pool.query(
        'select id,nome_completo from medicos where conta_id=$1 order by nome_completo,id limit 21',
        [contaId]
      ) : { rows: [] };
      const profissionais = medicos.rows.map((m: { id: string; nome_completo: string | null }) => ({
        id: m.id, nome: String(m.nome_completo ?? '')
      })).filter(p => nomeProfissionalValido(p.nome));
      const estado: EstadoConversa = deps.persistirConversa && contaId ? await lerEstadoConversa(deps.pool, contaId) : {};
      if (deps.persistirConversa && contaId) {
        if (!await reservarMensagemConversa(deps.pool, contaId, evento.instance, evento.data.key.id)) {
          res.sendStatus(200); return;
        }
        reservada = true;
      }
      const chaveContexto = JSON.stringify([contaId ?? 'sem_cadastro', telefone]);
      // Guarda somente referência e tipo fechado, nunca o conteúdo da solicitação.
      const remetenteRef = referenciaDiagnostica(deps.segredo, 'mensagem', ['remetente', telefone]);
      const anteriores = deps.persistirConversa && contaId ?
        estado.tarefasPendentes ?? [] : tarefasEmMemoria.get(chaveContexto) ?? [];
      const pedidoTipo = classificarPedidoTarefa(texto);
      const tribemdMencionada = /\btribe(?:md)?\b/i.test(texto);
      const amplimedMencionada = /\bamplimed\b/i.test(texto);
      const agenda = tribemdMencionada !== amplimedMencionada ?
        (tribemdMencionada ? 'tribemd' : 'amplimed') : undefined;
      const profissionalId = alvoExplicito(texto, profissionais);
      let tarefasPendentes = cancelouTarefas(texto)
        ? validarTarefas(anteriores).filter(t => t.remetenteRef !== remetenteRef)
        : pedidoTipo
          ? registrarPedido(anteriores, {
              tipo: pedidoTipo, instancia: evento.instance,
              mensagemId: evento.data.key.id, remetenteRef, criadaEm: Date.now(),
              ...(profissionalId ? { profissionalId } : {}),
              ...(agenda ? { agenda } : {})
            })
          : validarTarefas(anteriores);
      // O pedido deve sobreviver ao processamento e a uma falha posterior de envio.
      if (deps.persistirConversa && contaId && (pedidoTipo || cancelouTarefas(texto))) {
        await salvarEstadoConversa(deps.pool, contaId, { ...estado, tarefasPendentes });
      } else if (!deps.persistirConversa) {
        tarefasEmMemoria.set(chaveContexto, tarefasPendentes);
      }
      const marcar = async () => {
        try { await deps.marcarLida?.(evento.data.key); } catch { /* Sem impacto sobre resposta. */ }
      };
      await marcar();
      const emoji = reacaoContextual(texto);
      if (emoji) {
        try { await deps.reagir?.(evento.data.key, emoji); } catch { /* Sem impacto. */ }
      }
      if (deps.presenca) {
        digitando = true;
        await renovarPresenca();
        intervalo = setInterval(() => { void renovarPresenca(); }, 1500);
      }

      let descobertaVerificada: { agenda: AgendaEscolhida; nomes: string[] } | undefined;
      let diagnostico: DiagnosticoAgente | undefined;
      const comprovantes: ComprovanteTarefa[] = [];
      const panoramaDaMensagem: { atual?: { foco: string | null; resultado: PanoramaFiscal } } = {};
      const conferenciaDaMensagem: { atual?: ResultadoConferencia } = {};
      const vinculoDaMensagem: { atual?: {
        agenda:AgendaEscolhida;id:string;nome:string;restantes:string[]
      } } = {};
      const aoDiagnostico = (resultado: DiagnosticoAgente) => { diagnostico = resultado; };
      // Link antigo é contexto, não substitui resposta a um pedido novo.
      // O agente consulta recibo pela ferramenta se houver necessidade.
      const trabalhos=contaId&&deps.listarTrabalhos
        ? await deps.listarTrabalhos(contaId,telefone,evento.instance):[];
      const resposta = await responderAgente({
        texto, profissionais, semConta: !contaId, estadoConversa: estado,
        trabalhos,
        painelUrl: deps.painelUrl,
        contexto: contextoPorConta.get(chaveContexto) ?? []
      }, {
        apiKey: deps.apiKey, modeloNome: deps.modeloNome, tracesAtivos: deps.tracesAtivos,
        modeloTeste: deps.modeloTeste,controleCusto:deps.controleCusto,
        consultarStatus: deps.consultarStatus, aoDiagnostico,
        ...(contaId ? { referenciaContaAgenda: async () => {
          // Novo acesso sempre pertence à conta. Para quem já tinha agenda
          // conectada sob médico, reutilizar a conexão antiga sem migrá-la.
          const chave = cofreIdDaConta(contaId!);
          const statusConta = await deps.consultarStatus(chave);
          if (statusConta.tribemd.salvo || statusConta.amplimed.salvo) return chave;
          const r = await deps.pool.query(
            'select id from medicos where conta_id=$1 order by criado_em,id limit 21',[contaId]);
          for (const p of r.rows) {
            const antigo = await deps.consultarStatus(p.id);
            if (antigo.tribemd.conectada || antigo.amplimed.conectada) return p.id;
          }
          return chave;
        } } : {}),
        aoComprovante: comprovante => comprovantes.push(comprovante),
        ...(deps.descobrirProfissionais ? { descobrirProfissionais: async (medicoId: string, agenda: AgendaEscolhida) => {
          const r = await deps.descobrirProfissionais!(medicoId, agenda);
          if (r.ok && r.nomes?.length) descobertaVerificada = { agenda, nomes: r.nomes.filter(nomeProfissionalValido).slice(0,20) };
          return r;
        } } : {}),
        ...(deps.confirmarProfissionais ? {
          confirmarProfissionais: deps.confirmarProfissionais,
          ...(contaId ? {
            aoVinculo: async (fonte:AgendaEscolhida,medico:{id:string;nome:string}) => {
              // O vínculo foi persistido em medicos pela ferramenta. Este marco
              // conversacional precisa existir antes do balão e da busca.
              const feito=await registrarVinculoConversa(deps.pool,contaId!,fonte,medico);
              if(!feito.ok)return {registrado:false,pesquisa:'indisponivel' as const};
              vinculoDaMensagem.atual={
                agenda:fonte,id:medico.id,nome:medico.nome,restantes:feito.restantes
              };
              const pesquisa=deps.agendarPesquisa
                ? await deps.agendarPesquisa(contaId!,medico.id,medico.nome)
                : 'indisponivel';
              return {registrado:true,pesquisa};
            }
          }: {})
        } : {}),
        ...(deps.salvarDadosProfissionais ? { salvarDadosProfissionais: deps.salvarDadosProfissionais } : {}),
        ...(contaId&&deps.solicitarLinkRegistro?{
          solicitarLinkRegistro:(medicoId:string,acao:'solicitar'|'consultar'|'substituir'='solicitar')=>
            deps.solicitarLinkRegistro!(contaId!,medicoId,telefone,acao,evento.data.key.id)
        }:{}),
        ...(contaId&&deps.aprovarRegistroProfissional?{
          aprovarRegistroProfissional:(medicoId:string)=>
            deps.aprovarRegistroProfissional!(contaId!,medicoId)
        }:{}),
        ...(contaId && deps.proporCorrecaoPesquisa ? {
          proporCorrecaoPesquisa:(medicoId:string,dados:{crm:string;rqe?:string})=>
            deps.proporCorrecaoPesquisa!(contaId!,medicoId,dados)
        } : {}),
        ...(contaId && deps.concluirRevisaoPesquisa ? {
          concluirRevisaoPesquisa:(medicoId:string)=>
            deps.concluirRevisaoPesquisa!(contaId!,medicoId)
        } : {}),
        ...(deps.solicitarLinkAgenda ? { solicitarLinkAgenda: (medicoId: string, agenda: AgendaEscolhida) => deps.solicitarLinkAgenda!(medicoId, agenda, telefone) } : {}),
        ...(deps.consultarEntregaLink ? { consultarEntregaLink: (ref:string,agenda:AgendaEscolhida) =>
          deps.consultarEntregaLink!(ref,agenda) } : {}),
        ...(deps.consultarProntidao ? { consultarProntidao: deps.consultarProntidao } : {}),
        ...(contaId && deps.consultarPanorama ? {
          consultarPanorama: (ids: string[]) => deps.consultarPanorama!(contaId!, ids),
          aoPanorama: (foco: string | null, resultado: ResultadoPanoramaFiscal) => {
            if (resultado.ok) panoramaDaMensagem.atual = { foco, resultado };
          }
        } : {}),
        ...(contaId && deps.solicitarTrabalho ? {
          solicitarTrabalho: (tipo, fonte, medicoId) =>
            deps.solicitarTrabalho!({contaId:contaId!,instancia:evento.instance,
              mensagemId:evento.data.key.id,telefone,tipo,agenda:fonte,medicoId})
        } : {}),
        ...(contaId && deps.consultarConferencia ? {
          consultarConferencia: (medicoId: string, fonte: AgendaEscolhida) =>
            deps.consultarConferencia!(contaId!,medicoId,fonte),
          aoConferencia: (resultado: ResultadoConferencia) => {
            if (resultado.ok) conferenciaDaMensagem.atual=resultado;
          }
        } : {})
      });

      const baloes = separarBaloes(resposta);
      enviado = baloes.length > 0;
      for (const balao of baloes) {
        if (deps.presenca) await renovarPresenca();
        const ok = await deps.enviar(telefone, balao);
        if (!ok) { enviado = false; break; }
        if (reservada && contaId) await registrarBalaoConversa(deps.pool, contaId, evento.instance, evento.data.key.id);
      }

      if (enviado) {
        const baseEstado = descobertaVerificada ? { ...estado, descoberta: descobertaVerificada } : estado;
        const novo = evoluirEstadoConversa(baseEstado, texto, resposta, profissionais);
        if(vinculoDaMensagem.atual){
          const v=vinculoDaMensagem.atual;
          novo.profissionalConfirmadoId=v.id;
          novo.faseAgenda=v.restantes.length?'CONFIRMACAO_PENDENTE':'VINCULO_CONFIRMADO';
          novo.descoberta={agenda:v.agenda,nomes:v.restantes};
          novo.perguntaPendente=null;
          delete novo.nomeProfissionalPerguntado;
        }
        if (conferenciaDaMensagem.atual?.ok) {
          novo.ultimaConsultaFiscal = {
            escopo:'profissional', profissionalNome:conferenciaDaMensagem.atual.profissional,
            verificadaEm:new Date().toISOString()
          };
        } else if (panoramaDaMensagem.atual) {
          const { foco } = panoramaDaMensagem.atual;
          novo.ultimaConsultaFiscal = {
            escopo: foco === null ? 'conta' : 'profissional',
            ...(foco !== null ? { profissionalNome: foco } : {}),
            verificadaEm: new Date().toISOString()
          };
        }
        // Somente comprovante real da ferramenta confirma uma ação,
        // nunca a resposta livre da IA ou um status ainda indisponível.
        const concluida = diagnostico?.codigo === 'RESPOSTA' ? selecionarConclusao(
          tarefasPendentes, comprovantes, evento.instance, remetenteRef,
          novo.profissionalConfirmadoId
        ) : null;
        if (concluida) {
          try {
            const chaveOriginal = { id: concluida.mensagemId, remoteJid: evento.data.key.remoteJid, fromMe: false };
            if (await deps.reagir?.(chaveOriginal, '✅')) {
              tarefasPendentes = finalizarPedido(tarefasPendentes, concluida);
            }
          } catch { /* Falha de reação não apaga a pendência nem impede o atendimento. */ }
        }
        if (reservada && contaId) {
          await salvarEstadoConversa(deps.pool, contaId, { ...novo, tarefasPendentes });
        } else {
          tarefasEmMemoria.set(chaveContexto, tarefasPendentes);
          contextoPorConta.set(chaveContexto, [...(contextoPorConta.get(chaveContexto) ?? []), resposta.slice(0, 500)].slice(-3));
          if (contextoPorConta.size > 300) {
            const primeiro = contextoPorConta.keys().next().value;
            if (primeiro) { contextoPorConta.delete(primeiro); tarefasEmMemoria.delete(primeiro); }
          }
        }
      }
      if (deps.diagnosticoAtivo && diagnostico) {
        const registro: DiagnosticoMensagem = {
          tipo: 'noto_agent_execucao', versao: 1,
          mensagemRef: referenciaDiagnostica(deps.segredo, 'mensagem', [evento.instance, evento.data.key.id, telefone]),
          respostaRef: referenciaDiagnostica(deps.segredo, 'resposta', [resposta]),
          conta: contaId ? 'CADASTRADA' : 'SEM_CADASTRO', envio: enviado ? 'ENVIADO' : 'FALHOU', agente: diagnostico
        };
        try {
          if (deps.registrarDiagnostico) deps.registrarDiagnostico(registro);
          else console.info('[Noto Agent diagnóstico]', JSON.stringify(registro));
        } catch { /* Observabilidade não bloqueia atendimento. */ }
      }
      if (reservada && contaId) await finalizarMensagemConversa(deps.pool, contaId, evento.instance, evento.data.key.id, enviado);
      res.sendStatus(enviado ? 200 : 503);
    } catch {
      // Incerto: nenhum replay automático de balões possivelmente enviados.
      if (reservada && contaId) {
        await finalizarMensagemConversa(deps.pool, contaId, evento.instance, evento.data.key.id, false).catch(() => {});
      }
      res.sendStatus(503);
    } finally {
      if (intervalo) clearInterval(intervalo);
      if (digitando) {
        digitando = false;
        await presencaPendente.catch(() => {});
        await deps.presenca?.(telefone, 'paused').catch(() => false);
      }
    }
  });
  return router;
}
