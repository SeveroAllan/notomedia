import type pg from 'pg';
import { gerarVariantesTelefoneBrasileiro } from './variantes-telefone-brasileiro.js';
import {
  diagnosticarEntregaLink, hashDestinatario,
  interpretarEstadoEvolutionComDiagnostico, type EstadoEntregaLink, type DiagnosticoEntregaLink
} from './status-entrega-link.js';


type Banco = Pick<pg.Pool,'query'>;

/** Somente identificadores da Evolution e hash HMAC do destinatario; nunca URL/token. */
export async function registrarAceiteLink(
  pool: Banco, entrada:{linkId:string; instancia:string; mensagemId?:string; telefone:string; segredo:string}
):Promise<void> {
  const destinatario=hashDestinatario(entrada.segredo, entrada.telefone);
  const mensagemId=entrada.mensagemId && /^[A-Za-z0-9_-]{5,150}$/.test(entrada.mensagemId)
    ? entrada.mensagemId : null;
  await pool.query(`
    insert into public.cofre_links_entregas
      (link_id,instancia,mensagem_id,destino_hash,estado)
    values($1,$2,$3,$4,'ACEITO_API')
    on conflict (link_id) do nothing
  `,[entrada.linkId,entrada.instancia,mensagemId,destinatario]);
}

/** Nao ha envio, reenvio nem consulta de URL neste handler. */
export type ResultadoRecibo = 'ATUALIZADO'|'DUPLICADO_OU_SEM_AVANCO'|
  'SEM_CORRELACAO'|'OUTRA_INSTANCIA'|'EVENTO_INESPERADO'|'CORPO_NAO_RECONHECIDO'|
  'STATUS_NAO_RECONHECIDO'|'MENSAGEM_SEM_ORIGEM_COMPROVADA'|
  'SEM_ID_DA_MENSAGEM'|'SEM_NUMERO_PN';
/** Esta funcao devolve somente um codigo seguro para o log.
 * Nenhum ID, telefone, nome, token ou payload sai no diagnostico.
 */
export async function diagnosticarRegistroEstadoEvolution(
  pool:Banco,entrada:unknown,instanciaPermitida:string,segredo:string
):Promise<ResultadoRecibo> {
  const recebido=interpretarEstadoEvolutionComDiagnostico(entrada);
  if (!recebido.ok) return recebido.motivo;
  const evento=recebido.evento;
  if(evento.instancia!==instanciaPermitida) return 'OUTRA_INSTANCIA';
  const candidatos=[...new Set(evento.destinatarios.flatMap(numero=>
    gerarVariantesTelefoneBrasileiro(numero)).map(t=>hashDestinatario(segredo,t)))];
  if (!candidatos.length) return 'SEM_NUMERO_PN';
  // Unico UPDATE atomico, sem SELECT FOR UPDATE fora de uma transacao.
  // Apenas recibo da mesma instancia, identificador e hash de destinatario.
  const result=await pool.query(`
    update public.cofre_links_entregas set
      estado=case
        when estado='READ' then estado
        when estado='DELIVERY_ACK' and $4='ERROR' then estado
        when $4='READ' then 'READ'
        when $4='DELIVERY_ACK' then 'DELIVERY_ACK'
        when $4='ERROR' and estado not in ('DELIVERY_ACK','READ') then 'ERROR'
        when $4='SERVER_ACK' and estado in ('ACEITO_API','PENDING') then 'SERVER_ACK'
        when $4='PENDING' and estado='ACEITO_API' then 'PENDING'
        else estado
      end,
      atualizado_em=clock_timestamp()
    where instancia=$1 and mensagem_id=$2 and destino_hash=ANY($3::text[])
      and estado <> 'READ'
      and estado IS DISTINCT FROM (
        case
          when estado='DELIVERY_ACK' and $4='ERROR' then estado
          when $4='READ' then 'READ'
          when $4='DELIVERY_ACK' then 'DELIVERY_ACK'
          when $4='ERROR' and estado not in ('DELIVERY_ACK','READ') then 'ERROR'
          when $4='SERVER_ACK' and estado in ('ACEITO_API','PENDING') then 'SERVER_ACK'
          when $4='PENDING' and estado='ACEITO_API' then 'PENDING'
          else estado
        end
      )
    returning link_id
  `,[evento.instancia,evento.mensagemId,candidatos,evento.estado]);
  if(result.rows.length) return 'ATUALIZADO';
  const anterior=await pool.query(`
    select estado from public.cofre_links_entregas
    where instancia=$1 and mensagem_id=$2 and destino_hash=ANY($3::text[])
    limit 1
  `,[evento.instancia,evento.mensagemId,candidatos]);
  return anterior.rows.length ? 'DUPLICADO_OU_SEM_AVANCO' : 'SEM_CORRELACAO';
}
/** Compatibilidade: a API booleana informa somente quando houve evolucao real. */
export async function registrarEstadoEvolution(
  pool:Banco,entrada:unknown,instanciaPermitida:string,segredo:string
):Promise<boolean> {
  return (await diagnosticarRegistroEstadoEvolution(pool,entrada,instanciaPermitida,segredo))==='ATUALIZADO';
}

/** Escopo imutavel: somente links da conta validada pela camada do webhook. */
export async function consultarEntregaLink(
  pool: Banco, contaId:string, agenda:'tribemd'|'amplimed', agora:Date=new Date()
):Promise<{estado:DiagnosticoEntregaLink; comId:boolean; segundosDesdeAceite:number}|null> {
  const r=await pool.query(`
    select e.estado,e.aceito_em,e.mensagem_id
    from public.cofre_links l
    left join public.cofre_links_entregas e on e.link_id=l.id
    where l.agenda=$2 and
      (l.conta_id=$1 OR (l.medico_id is not null and exists(
        select 1 from public.medicos m where m.id=l.medico_id and m.conta_id=$1
      )))
    order by l.criado_em desc,l.id desc limit 1
  `,[contaId,agenda]);
  const row=r.rows[0];
  if (!row?.aceito_em || !row?.estado) return null;
  const segundos=Math.max(0,Math.floor((agora.getTime()-new Date(row.aceito_em).getTime())/1000));
  return {estado:diagnosticarEntregaLink(row.estado as EstadoEntregaLink,new Date(row.aceito_em),agora),
    comId:typeof row.mensagem_id==='string',segundosDesdeAceite:segundos};
}
