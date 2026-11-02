import type pg from 'pg';
import { normalizarNomeMedico } from '../conta/medicos-conta.js';
import { validarTarefas, type TarefaPendente } from './tarefas.js';

export type AgendaEscolhida = 'tribemd' | 'amplimed';
export type PerguntaPendente = 'agenda' | 'profissional' | 'confirmar_profissional' | 'periodo' | null;
export interface EstadoConversa {
  agendaEscolhida?: AgendaEscolhida;
  profissionalConfirmadoId?: string;
  perguntaPendente?: PerguntaPendente;
  profissionalPerguntadoId?: string;
  nomeProfissionalPerguntado?: string;
  descoberta?: { agenda: AgendaEscolhida; nomes: string[] };
  tarefasPendentes?: TarefaPendente[];
}
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
    ...(e.descoberta && ['tribemd','amplimed'].includes(e.descoberta.agenda) && Array.isArray(e.descoberta.nomes) ? {
      descoberta: { agenda: e.descoberta.agenda as AgendaEscolhida, nomes: e.descoberta.nomes.filter((n: unknown) => typeof n === 'string' && n.length <= 150).slice(0,20) as string[] }
    } : {})
  };
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

/** Somente fatos conversacionais autorizados, nenhum texto livre ou dado fiscal. */
export function evoluirEstadoConversa(
  anterior: EstadoConversa, entrada: string, resposta: string,
  profissionais: readonly { id: string; nome: string }[]
): EstadoConversa {
  const atual: EstadoConversa = { ...anterior };
  const nome = normalizarNomeMedico(entrada);
  const fonteTribe = /\btribemd\b/i.test(nome);
  const fonteAmpli = /\bamplimed\b/i.test(nome);
  const escolhaCurta = /^(?:tribemd|amplimed)[.! ]*$/.test(nome);
  const declaracao = !entrada.includes('?') && /^(?:(?:nao,?\s*)?(?:e|eh|eu uso|uso|utilizo|utilizamos|tenho|minha agenda e|a agenda e|quero conectar|preciso conectar|vamos conectar|conecte|vamos usar)\b)/.test(nome);
  if (fonteTribe !== fonteAmpli && (escolhaCurta || declaracao)) {
    atual.agendaEscolhida = fonteTribe ? 'tribemd' : 'amplimed';
  }

  const confirmacao = /^(sim|isso|correto|confirmo|exatamente|pode ser)[.! ]*$/i.test(entrada.trim());
  const identificados = profissionais.filter(p =>
    normalizarNomeMedico(p.nome).split(' ').filter(t => t.length >= 4)
      .some(t => nome.split(' ').includes(t)));
  // Mencionar Alice numa pergunta não equivale a escolher a identidade.
  // Somente atribuição declarativa ou resposta à confirmação pendente atualiza foco.
  const atribuiu = !/[?]/.test(entrada) && !/\b(?:nao sei|talvez|quem|qual)\b/.test(nome) &&
    /\b(?:sou|e|para|da|do|pertence|confirmo)\b/.test(nome);
  if (identificados.length === 1 && atribuiu) atual.profissionalConfirmadoId = identificados[0]!.id;
  else if (confirmacao && anterior.perguntaPendente === 'profissional' && anterior.profissionalPerguntadoId &&
      profissionais.some(p => p.id === anterior.profissionalPerguntadoId)) {
    atual.profissionalConfirmadoId = anterior.profissionalPerguntadoId;
  }

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
  if (estado.perguntaPendente !== undefined) permitido.perguntaPendente = estado.perguntaPendente;
  if (estado.profissionalPerguntadoId) permitido.profissionalPerguntadoId = estado.profissionalPerguntadoId;
  if (estado.nomeProfissionalPerguntado && estado.nomeProfissionalPerguntado.length <= 150) permitido.nomeProfissionalPerguntado = estado.nomeProfissionalPerguntado;
  if (estado.descoberta && ['tribemd','amplimed'].includes(estado.descoberta.agenda)) permitido.descoberta = {
    agenda: estado.descoberta.agenda, nomes: estado.descoberta.nomes.filter(n => n && n.length <= 150).slice(0,20)
  };
  if (estado.tarefasPendentes) permitido.tarefasPendentes = validarTarefas(estado.tarefasPendentes);
  await pool.query(
    'insert into noto_agent_conversas(conta_id,estado) values($1,$2::jsonb) on conflict(conta_id) do update set estado=excluded.estado,atualizado_em=now()',
    [contaId, JSON.stringify(permitido)]
  );
}
