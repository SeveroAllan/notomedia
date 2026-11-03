import type pg from 'pg';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';
import type { AgendaEscolhida } from './estado-conversa.js';

export type TipoTrabalhoNoto = 'descoberta_agenda' | 'conferencia_fiscal';
export type EstadoTrabalhoNoto = 'pendente'|'executando'|'resultado_pronto'|'notificando'|'aceito_api'|'falhou'|'envio_incerto';
export interface PedidoTrabalhoNoto {
  contaId: string; instancia: string; mensagemId: string; telefone: string;
  tipo: TipoTrabalhoNoto; agenda: AgendaEscolhida; medicoId: string | null;
}
export interface TrabalhoNoto extends PedidoTrabalhoNoto {
  id: string; estado: EstadoTrabalhoNoto; tentativas: number;
}
export interface SituacaoTrabalhoNoto {
  tipo: TipoTrabalhoNoto; agenda: AgendaEscolhida; estado: EstadoTrabalhoNoto;
}
export type ResultadoEnfileirar = { ok: true; estado: 'iniciado'|'ja_em_andamento' } |
  { ok: false; motivo: 'SEM_AUTORIZACAO'|'FILA_INDISPONIVEL'|'PEDIDO_INVALIDO' };

type Banco = Pick<pg.Pool, 'query'>;
const tipos = ['descoberta_agenda','conferencia_fiscal'];
const estados: EstadoTrabalhoNoto[] = ['pendente','executando','resultado_pronto','notificando','aceito_api','falhou','envio_incerto'];
const idSeguro = (s: unknown, min: number, max: number) =>
  typeof s === 'string' && s.length >= min && s.length <= max && !/[\u0000-\u001f]/.test(s);

const validarPedido = (p: PedidoTrabalhoNoto) =>
  idSeguro(p.contaId, 10, 80) && idSeguro(p.instancia, 1, 128) &&
  idSeguro(p.mensagemId, 5, 150) &&
  /^55\d{10,11}$/.test(p.telefone) && tipos.includes(p.tipo) &&
  ['tribemd','amplimed'].includes(p.agenda) &&
  (p.medicoId === null || idSeguro(p.medicoId, 10, 80)) &&
  !(p.tipo === 'conferencia_fiscal' && !p.medicoId);

/**
 * Responde ao turno rapidamente, sem abrir navegador.
 * Confere novamente operador ativo e médico na MESMA conta.
 * A chave única por mensagem impede duplicação de webhook.
 */
export async function enfileirarTrabalhoNoto(pool: Banco, p: PedidoTrabalhoNoto): Promise<ResultadoEnfileirar> {
  if (!validarPedido(p)) return {ok:false,motivo:'PEDIDO_INVALIDO'};
  try {
    const sql = [
      'insert into public.noto_agent_trabalhos',
      '(conta_id,instancia,mensagem_id,telefone_destino,tipo,agenda,medico_id)',
      'select $1,$2,$3,$4,$5,$6,$7::uuid',
      'where exists(select 1 from public.usuarios u',
      'where u.conta_id=$1 and u.ativo=true and u.auth_user_id is not null',
      "and regexp_replace(u.telefone,'[^0-9]','','g')=any($8::text[]))",
      'and ($7::uuid is null or exists(select 1 from public.medicos m',
      'where m.id=$7::uuid and m.conta_id=$1))',
      'on conflict do nothing returning id'
    ].join('\n');
    const r = await pool.query(sql,[p.contaId,p.instancia,p.mensagemId,p.telefone,p.tipo,p.agenda,p.medicoId,
      gerarVariantesTelefoneBrasileiro(p.telefone)]);
    if (r.rows.length===1) return {ok:true,estado:'iniciado'};
    const ativo=await pool.query([
      'select 1 from public.noto_agent_trabalhos',
      'where conta_id=$1 and instancia=$2 and tipo=$3 and agenda=$4',
      'and medico_id is not distinct from $5::uuid',
      "and estado in ('pendente','executando','resultado_pronto','notificando') limit 1"
    ].join('\n'),[p.contaId,p.instancia,p.tipo,p.agenda,p.medicoId]);
    if (ativo.rows.length) return {ok:true,estado:'ja_em_andamento'};
    return {ok:false,motivo:'SEM_AUTORIZACAO'};
  } catch { return {ok:false,motivo:'FILA_INDISPONIVEL'}; }
}
export async function listarTrabalhosNoto(
  pool: Banco, contaId: string, telefone: string, instancia: string
): Promise<SituacaoTrabalhoNoto[]> {
  if (!idSeguro(contaId,10,80) || !/^55\d{10,11}$/.test(telefone) || !idSeguro(instancia,1,128)) return [];
  try {
    const r=await pool.query([
      'select tipo,agenda,estado from public.noto_agent_trabalhos',
      'where conta_id=$1 and telefone_destino=$2 and instancia=$3',
      "and estado in ('pendente','executando','resultado_pronto','notificando','envio_incerto')",
      'order by criado_em desc limit 4'
    ].join('\n'),[contaId,telefone,instancia]);
    return r.rows.filter((x:Record<string,unknown>)=>tipos.includes(String(x.tipo)) &&
      ['tribemd','amplimed'].includes(String(x.agenda)) &&
      estados.includes(x.estado as EstadoTrabalhoNoto))
      .map((x:Record<string,unknown>)=>({
        tipo:x.tipo as TipoTrabalhoNoto,agenda:x.agenda as AgendaEscolhida,estado:x.estado as EstadoTrabalhoNoto
      }));
  } catch { return []; }
}

/** SKIP LOCKED permite várias instâncias. O lease expira após 4 minutos e
 * leituras podem recomeçar uma vez após crash; envio jamais é refeito às cegas. */
export async function reservarTrabalhoNoto(pool: Banco, executor: string): Promise<TrabalhoNoto|null> {
  const sql = [
    'with proximo as (select id from public.noto_agent_trabalhos',
    "where estado='pendente' or (estado='executando' and bloqueado_ate<now() and tentativas<2)",
    'order by criado_em,id for update skip locked limit 1)',
    'update public.noto_agent_trabalhos t',
    "set estado='executando', executado_por=$1, tentativas=t.tentativas+1,",
    "bloqueado_ate=now()+interval '4 minutes',atualizado_em=now()",
    'from proximo where t.id=proximo.id',
    'returning t.id,t.conta_id,t.instancia,t.mensagem_id,t.telefone_destino,',
    't.tipo,t.agenda,t.medico_id,t.estado,t.tentativas'
  ].join('\n');
  const r=await pool.query(sql,[executor]),x=r.rows[0];
  return x?{
    id:x.id,contaId:x.conta_id,instancia:x.instancia,mensagemId:x.mensagem_id,
    telefone:x.telefone_destino,tipo:x.tipo,agenda:x.agenda,medicoId:x.medico_id,
    estado:x.estado,tentativas:x.tentativas
  }:null;
}

export async function concluirLeituraNoto(
  pool: Banco, id: string, executor: string, resultado: unknown
): Promise<boolean> {
  const texto=JSON.stringify(resultado);
  if (!texto || texto.length>6000 ||
    /"(?:cpf|pacienteId|nomeAoVivo|telefonePaciente|idExterno|telefone|senha|token|consultaIndividual)"\s*:/i.test(texto)) return false;
  const r=await pool.query([
    'update public.noto_agent_trabalhos',
    "set estado='resultado_pronto',resultado=$3::jsonb,bloqueado_ate=null,atualizado_em=now()",
    "where id=$1 and executado_por=$2 and estado='executando' returning id"
  ].join('\n'),[id,executor,texto]);
  return r.rows.length===1;
}
export async function falharLeituraNoto(pool: Banco,id:string,executor:string,motivo:string):Promise<void>{
  const permitidos=['LEITURA_INCOMPLETA','ACESSO_INDISPONIVEL','AUTORIZACAO_INDISPONIVEL',
    'CONCILIACAO_INDISPONIVEL','EXECUCAO_INDISPONIVEL','RESULTADO_INVALIDO'];
  await pool.query([
    'update public.noto_agent_trabalhos',
    "set estado='resultado_pronto',",
    "resultado=jsonb_build_object('ok',false,'motivo',$3::text),",
    'bloqueado_ate=null,atualizado_em=now()',
    "where id=$1 and executado_por=$2 and estado='executando'"
  ].join('\n'),[id,executor,permitidos.includes(motivo)?motivo:'EXECUCAO_INDISPONIVEL']);
}
/** Leitura interrompida duas vezes não fica pendurada para sempre.
 * Notificação já iniciada nunca é reenviada automaticamente: entrega incerta.
 */
export async function recuperarTrabalhosInterrompidos(pool:Banco):Promise<void>{
  await pool.query([
    'update public.noto_agent_trabalhos',
    "set estado='resultado_pronto',",
    "resultado=jsonb_build_object('ok',false,'motivo','EXECUCAO_INDISPONIVEL'),",
    'bloqueado_ate=null,atualizado_em=now()',
    "where estado='executando' and tentativas>=2 and bloqueado_ate<now()"
  ].join('\n'),[]);
  await pool.query([
    'update public.noto_agent_trabalhos',
    "set estado='envio_incerto',atualizado_em=now()",
    "where estado='notificando' and atualizado_em<now()-interval '4 minutes'"
  ].join('\n'),[]);
}
export interface TrabalhoParaNotificar extends TrabalhoNoto {resultado:unknown}
export async function reservarNotificacaoNoto(pool:Banco):Promise<TrabalhoParaNotificar|null>{
  const sql=[
    'with proximo as (select id from public.noto_agent_trabalhos',
    "where estado='resultado_pronto' order by atualizado_em,id",
    'for update skip locked limit 1)',
    'update public.noto_agent_trabalhos t',
    "set estado='notificando',atualizado_em=now()",
    'from proximo where t.id=proximo.id',
    'returning t.id,t.conta_id,t.instancia,t.mensagem_id,t.telefone_destino,',
    't.tipo,t.agenda,t.medico_id,t.estado,t.tentativas,t.resultado'
  ].join('\n');
  const r=await pool.query(sql,[]),x=r.rows[0];
  return x?{
    id:x.id,contaId:x.conta_id,instancia:x.instancia,mensagemId:x.mensagem_id,
    telefone:x.telefone_destino,tipo:x.tipo,agenda:x.agenda,medicoId:x.medico_id,
    estado:x.estado,tentativas:x.tentativas,resultado:x.resultado
  }:null;
}
/** 'aceito_api' confirma apenas HTTP/servidor, NUNCA entrega ou leitura no WhatsApp. */
export async function terminarNotificacaoNoto(pool:Banco,id:string,confirmado:boolean):Promise<void>{
  await pool.query([
    'update public.noto_agent_trabalhos set estado=$2,atualizado_em=now()',
    "where id=$1 and estado='notificando'"
  ].join('\n'),[id,confirmado?'aceito_api':'envio_incerto']);
}
