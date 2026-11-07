import type pg from 'pg';
import type { CausaLeitura } from '../agenda/diagnostico-descoberta.js';
import { normalizarNomeMedico } from '../conta/medicos-conta.js';
import { validarTarefas, type TarefaPendente } from './tarefas.js';
import { leituraPesquisaEstado, type PesquisaRegistroConversa } from './pesquisa-profissional-conversa.js';

export type AgendaEscolhida = 'tribemd' | 'amplimed';
export type PerguntaPendente = 'agenda' | 'profissional' | 'confirmar_profissional' | 'periodo' | null;
export interface EstadoConversa {
  agendaEscolhida?: AgendaEscolhida;
  profissionalConfirmadoId?: string;
  perguntaPendente?: PerguntaPendente;
  periodoConferencia?: {profissionalId:string;inicio:string};
  profissionalPerguntadoId?: string;
  nomeProfissionalPerguntado?: string;
  descoberta?: { agenda: AgendaEscolhida; nomes: string[] };
  /** Fase sem nomes ou dados clínicos. Permite retomar após callback autenticado. */
  faseAgenda?: 'DESCOBERTA_PENDENTE'|'CONFIRMACAO_PENDENTE'|'VINCULO_CONFIRMADO';
  causaDescoberta?: CausaLeitura;
  tarefasPendentes?: TarefaPendente[];
  /** Sugestões públicas em revisão, por profissional; nunca são aprovação fiscal. */
  pesquisasRegistro?: Record<string,PesquisaRegistroConversa>;
  /** Última consulta comprovada, sem texto livre nem dados fiscais de pacientes. */
  ultimaConsultaFiscal?: { escopo: 'conta' | 'profissional'; profissionalNome?: string; verificadaEm: string };
}
const causasLeituraValidas:readonly CausaLeitura[]=[
  'SEM_RESULTADO','COBERTURA_PARCIAL','AGENDA_LIMITADA',
  'DETALHES_NAO_DISPONIVEIS','DETALHES_PENDENTES',
  'SEM_CONSULTAS_NO_RECORTE','SEM_IDENTIFICACAO_PROFISSIONAL','NOMES_NAO_VALIDOS'
];
type Banco = Pick<pg.Pool, 'query'>;

export async function lerEstadoConversa(pool: Banco, contaId: string): Promise<EstadoConversa> {
  const resultado = await pool.query('select estado from noto_agent_conversas where conta_id=$1', [contaId]);
  const e = resultado.rows[0]?.estado;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return {};
  return {
    ...(['tribemd','amplimed'].includes(e.agendaEscolhida) ? { agendaEscolhida: e.agendaEscolhida as AgendaEscolhida } : {}),
    ...(typeof e.profissionalConfirmadoId === 'string' ? { profissionalConfirmadoId: e.profissionalConfirmadoId } : {}),
    ...(['agenda','profissional','confirmar_profissional','periodo',null].includes(e.perguntaPendente) ?
      { perguntaPendente: e.perguntaPendente as PerguntaPendente } : {}),
    ...(typeof e.profissionalPerguntadoId === 'string' ? { profissionalPerguntadoId: e.profissionalPerguntadoId } : {}),
    ...(typeof e.nomeProfissionalPerguntado === 'string' && e.nomeProfissionalPerguntado.length <= 150 ? { nomeProfissionalPerguntado: e.nomeProfissionalPerguntado } : {}),
    ...(Array.isArray(e.tarefasPendentes) ? { tarefasPendentes: validarTarefas(e.tarefasPendentes) } : {}),
    ...(typeof e.periodoConferencia?.profissionalId==='string'&&
      typeof e.periodoConferencia?.inicio==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(e.periodoConferencia.inicio)
      ?{periodoConferencia:e.periodoConferencia}:{}),
    ...(e.pesquisasRegistro ? {pesquisasRegistro:leituraPesquisaEstado(e.pesquisasRegistro)} : {}),
    ...(e.ultimaConsultaFiscal && ['conta','profissional'].includes(e.ultimaConsultaFiscal.escopo) &&
      typeof e.ultimaConsultaFiscal.verificadaEm === 'string' &&
      e.ultimaConsultaFiscal.verificadaEm.length <= 40 &&
      Number.isFinite(Date.parse(e.ultimaConsultaFiscal.verificadaEm)) &&
      (e.ultimaConsultaFiscal.escopo === 'conta' ||
        (typeof e.ultimaConsultaFiscal.profissionalNome === 'string' &&
          e.ultimaConsultaFiscal.profissionalNome.length <= 150)) ? {
        ultimaConsultaFiscal: {
          escopo: e.ultimaConsultaFiscal.escopo as 'conta' | 'profissional',
          verificadaEm: e.ultimaConsultaFiscal.verificadaEm as string,
          ...(e.ultimaConsultaFiscal.escopo === 'profissional' ?
            { profissionalNome: e.ultimaConsultaFiscal.profissionalNome as string } : {})
        }
      } : {}),
    ...(['DESCOBERTA_PENDENTE','CONFIRMACAO_PENDENTE','VINCULO_CONFIRMADO'].includes(e.faseAgenda) ?
      {faseAgenda:e.faseAgenda as EstadoConversa['faseAgenda']} : {}),
    ...(typeof e.causaDescoberta==='string' && causasLeituraValidas.includes(e.causaDescoberta as CausaLeitura) ?
      {causaDescoberta:e.causaDescoberta as CausaLeitura}:{}),
    ...(e.descoberta && ['tribemd','amplimed'].includes(e.descoberta.agenda) && Array.isArray(e.descoberta.nomes) ? {
      descoberta: { agenda: e.descoberta.agenda as AgendaEscolhida, nomes: e.descoberta.nomes.filter((n: unknown) => typeof n === 'string' && n.length <= 150).slice(0,20) as string[] }
    } : {})
  };
}

/** A data é escopo informado pelo usuário, nunca evidência de ausência de notas. */
export async function registrarPeriodoConferencia(pool:Banco,contaId:string,profissionalId:string,inicio:string):Promise<boolean>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(inicio))return false;
  const data=new Date(inicio+'T00:00:00Z');
  if(!Number.isFinite(data.getTime())||data.toISOString().slice(0,10)!==inicio)return false;
  const r=await pool.query([
    'update public.noto_agent_conversas c set',
    "estado=c.estado||jsonb_build_object('periodoConferencia',",
    "jsonb_build_object('profissionalId',$2::text,'inicio',$3::text),'perguntaPendente',null),atualizado_em=now()",
    "where c.conta_id=$1 and c.estado->>'profissionalConfirmadoId'=$2",
    "and (c.estado->>'perguntaPendente'='periodo' or (",
    "c.estado->>'faseAgenda'='VINCULO_CONFIRMADO'",
    "and (c.estado->'periodoConferencia' is null or c.estado->'periodoConferencia'='null'::jsonb)))",
    'and exists(select 1 from public.medicos m where m.id=$2::uuid and m.conta_id=$1)',
    'returning conta_id'
  ].join('\n'),[contaId,profissionalId,inicio]);
  return r.rows.length===1;
}

export async function reservarMensagemConversa(pool: Banco, contaId: string, instancia: string, mensagemId: string): Promise<boolean> {
  const r = await pool.query(
    'insert into noto_agent_mensagens(conta_id,instancia,mensagem_id) values($1,$2,$3) on conflict do nothing returning mensagem_id',
    [contaId,instancia,mensagemId]
  );
  return r.rows.length === 1;
}

export async function registrarBalaoConversa(pool: Banco, contaId: string, instancia: string, mensagemId: string): Promise<void> {
  await pool.query(
    "update noto_agent_mensagens set baloes_confirmados=baloes_confirmados+1,atualizado_em=now() where conta_id=$1 and instancia=$2 and mensagem_id=$3 and estado='reservada'",
    [contaId,instancia,mensagemId]
  );
}

export async function finalizarMensagemConversa(pool: Banco, contaId: string, instancia: string, mensagemId: string, entregue: boolean): Promise<void> {
  await pool.query(
    "update noto_agent_mensagens set estado=$4,atualizado_em=now() where conta_id=$1 and instancia=$2 and mensagem_id=$3 and estado='reservada'",
    [contaId,instancia,mensagemId, entregue ? 'concluida' : 'incerta']
  );
}

/** Uma escolha declarada na mensagem, independente do resultado do envio da resposta. */
export function escolhaAgendaExplicita(entrada: string): AgendaEscolhida | undefined {
  if (entrada.includes('?')) return;
  const nome = normalizarNomeMedico(entrada.replace(/^\s*n[aã]o\s*,\s*/i, ''));
  const curta = /^(tribe(?:md)?|amplimed)(?: nao (?:e )?(?:a |o )?(?:tribe(?:md)?|amplimed))?$/.exec(nome);
  const declarada = /^(?:e|eh|eu uso|uso|utilizo|utilizamos|tenho|(?:a )?minha agenda e|a agenda e|a correta e|quero conectar|preciso conectar|vamos conectar|conecte|vamos usar|vamos pela|quis dizer)\s+(?:(?:a|o)\s+)?(tribe(?:md)?|amplimed)\b/.exec(nome);
  const fonte = (curta ?? declarada)?.[1];
  if (!fonte) return;
  const outra = fonte === 'amplimed' ? 'tribe(?:md)?' : 'amplimed';
  if (new RegExp('\\b' + outra + '\\b').test(nome) &&
      !new RegExp('\\bnao\\s+(?:(?:e|a|o)\\s+)*' + outra + '$').test(nome)) return;
  return fonte === 'amplimed' ? 'amplimed' : 'tribemd';
}

/** Somente fatos conversacionais autorizados, nenhum texto livre ou dado fiscal. */
export function evoluirEstadoConversa(
  anterior: EstadoConversa, entrada: string, resposta: string,
  profissionais: readonly { id: string; nome: string }[]
): EstadoConversa {
  const atual: EstadoConversa = { ...anterior };
  const escolha = escolhaAgendaExplicita(entrada);
  if (escolha) atual.agendaEscolhida = escolha;

  // Autorização/vínculo são efeitos EXCLUSIVOS da ferramenta tipada e do banco.
  // Nunca transformar fala, menção de nome ou 'sim' em identidade confirmada.

  // A última pergunta passa a ser uma categoria fechada; nunca persistimos o balão.
  const perguntas = resposta.split(/[.!?\n]+/).filter(Boolean);
  const ultima = perguntas.at(-1)?.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase() ?? '';
  const confirmacaoDeCadastro = /\b(?:confirma|confirmar|autoriza|autorizar)\b/.test(ultima) &&
    /\b(?:adicionar|incluir|cadastrar|vincular)\b/.test(ultima);
  const nomesComprovados = anterior.descoberta?.nomes.filter(n =>
    ultima.includes(normalizarNomeMedico(n))) ?? [];
  if (confirmacaoDeCadastro && nomesComprovados.length === 1) {
    atual.perguntaPendente = 'confirmar_profissional';
    atual.nomeProfissionalPerguntado = nomesComprovados[0]!;
    delete atual.profissionalPerguntadoId;
  } else if (/\bagenda\b/.test(ultima) && /(qual|usa|utiliza|tribemd|amplimed)/.test(ultima)) {
    atual.perguntaPendente = 'agenda';
  } else if (/qual profissional|qual medico|de qual medico|qual dos profissionais|de quem e a agenda/.test(ultima)) {
    atual.perguntaPendente = 'profissional';
    const mencionados = profissionais.filter(p => normalizarNomeMedico(resposta).includes(normalizarNomeMedico(p.nome)));
    atual.profissionalPerguntadoId = mencionados.length === 1 ? mencionados[0]!.id : undefined;
  } else if (/desde quando|qual periodo|a partir de quando/.test(ultima)) {
    atual.perguntaPendente = 'periodo';
  } else {
    atual.perguntaPendente = null;
    delete atual.profissionalPerguntadoId;
    delete atual.nomeProfissionalPerguntado;
  }
  return atual;
}

export async function salvarEstadoConversa(pool: Banco, contaId: string, estado: EstadoConversa): Promise<void> {
  const permitido: EstadoConversa = {};
  if (estado.agendaEscolhida) permitido.agendaEscolhida = estado.agendaEscolhida;
  if (estado.profissionalConfirmadoId) permitido.profissionalConfirmadoId = estado.profissionalConfirmadoId;
  if (estado.faseAgenda) permitido.faseAgenda = estado.faseAgenda;
  if (estado.causaDescoberta && causasLeituraValidas.includes(estado.causaDescoberta))
    permitido.causaDescoberta = estado.causaDescoberta;
  if (estado.perguntaPendente !== undefined) permitido.perguntaPendente = estado.perguntaPendente;
  if (estado.profissionalPerguntadoId) permitido.profissionalPerguntadoId = estado.profissionalPerguntadoId;
  if (estado.nomeProfissionalPerguntado && estado.nomeProfissionalPerguntado.length <= 150) permitido.nomeProfissionalPerguntado = estado.nomeProfissionalPerguntado;
  if (estado.descoberta && ['tribemd','amplimed'].includes(estado.descoberta.agenda)) permitido.descoberta = {
    agenda: estado.descoberta.agenda, nomes: estado.descoberta.nomes.filter(n => n && n.length <= 150).slice(0,20)
  };
  if (estado.tarefasPendentes) permitido.tarefasPendentes = validarTarefas(estado.tarefasPendentes);
  if (estado.ultimaConsultaFiscal && Number.isFinite(Date.parse(estado.ultimaConsultaFiscal.verificadaEm)) &&
      (estado.ultimaConsultaFiscal.escopo === 'conta' ||
        (estado.ultimaConsultaFiscal.escopo === 'profissional' &&
         !!estado.ultimaConsultaFiscal.profissionalNome && estado.ultimaConsultaFiscal.profissionalNome.length <= 150))) {
    permitido.ultimaConsultaFiscal = estado.ultimaConsultaFiscal;
  }
  await pool.query(
    'insert into noto_agent_conversas(conta_id,estado) values($1,$2::jsonb) on conflict(conta_id) do update set estado=noto_agent_conversas.estado || excluded.estado,atualizado_em=now()',
    [contaId, JSON.stringify(permitido)]
  );
}
