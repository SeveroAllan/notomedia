import type pg from 'pg';
import { normalizarNomeMedico } from '../conta/medicos-conta.js';

export type AgendaEscolhida = 'tribemd' | 'amplimed';
export type PerguntaPendente = 'agenda' | 'profissional' | 'periodo' | null;
export interface EstadoConversa {
  agendaEscolhida?: AgendaEscolhida;
  profissionalConfirmadoId?: string;
  perguntaPendente?: PerguntaPendente;
  profissionalPerguntadoId?: string;
}
type Banco = Pick<pg.Pool, 'query'>;

export async function lerEstadoConversa(pool: Banco, contaId: string): Promise<EstadoConversa> {
  const resultado = await pool.query('select estado from noto_agent_conversas where conta_id=$1', [contaId]);
  const e = resultado.rows[0]?.estado;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return {};
  return {
    ...(['tribemd','amplimed'].includes(e.agendaEscolhida) ? { agendaEscolhida: e.agendaEscolhida as AgendaEscolhida } : {}),
    ...(typeof e.profissionalConfirmadoId === 'string' ? { profissionalConfirmadoId: e.profissionalConfirmadoId } : {}),
    ...(['agenda','profissional','periodo',null].includes(e.perguntaPendente) ?
      { perguntaPendente: e.perguntaPendente as PerguntaPendente } : {}),
    ...(typeof e.profissionalPerguntadoId === 'string' ? { profissionalPerguntadoId: e.profissionalPerguntadoId } : {})
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
  if (fonteTribe !== fonteAmpli) atual.agendaEscolhida = fonteTribe ? 'tribemd' : 'amplimed';

  const confirmacao = /^(sim|isso|correto|confirmo|exatamente|pode ser)[.! ]*$/i.test(entrada.trim());
  const identificados = profissionais.filter(p =>
    normalizarNomeMedico(p.nome).split(' ').filter(t => t.length >= 4)
      .some(t => nome.split(' ').includes(t)));
  if (identificados.length === 1) atual.profissionalConfirmadoId = identificados[0]!.id;
  else if (confirmacao && anterior.perguntaPendente === 'profissional' && anterior.profissionalPerguntadoId &&
      profissionais.some(p => p.id === anterior.profissionalPerguntadoId)) {
    atual.profissionalConfirmadoId = anterior.profissionalPerguntadoId;
  }

  // A última pergunta passa a ser uma categoria fechada; nunca persistimos o balão.
  const perguntas = resposta.split(/[.!?\n]+/).filter(Boolean);
  const ultima = perguntas.at(-1)?.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase() ?? '';
  if (/\bagenda\b/.test(ultima) && /(qual|usa|utiliza|tribemd|amplimed)/.test(ultima)) {
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
  }
  return atual;
}

export async function salvarEstadoConversa(pool: Banco, contaId: string, estado: EstadoConversa): Promise<void> {
  const permitido: EstadoConversa = {};
  if (estado.agendaEscolhida) permitido.agendaEscolhida = estado.agendaEscolhida;
  if (estado.profissionalConfirmadoId) permitido.profissionalConfirmadoId = estado.profissionalConfirmadoId;
  if (estado.perguntaPendente !== undefined) permitido.perguntaPendente = estado.perguntaPendente;
  if (estado.profissionalPerguntadoId) permitido.profissionalPerguntadoId = estado.profissionalPerguntadoId;
  await pool.query(
    'insert into noto_agent_conversas(conta_id,estado) values($1,$2::jsonb) on conflict(conta_id) do update set estado=excluded.estado,atualizado_em=now()',
    [contaId, JSON.stringify(permitido)]
  );
}
