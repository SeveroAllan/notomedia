import type pg from 'pg';
import { gerarVariantesTelefoneBrasileiro } from './variantes-telefone-brasileiro.js';
import {
  diagnosticarEntregaLink, hashDestinatario,
  interpretarEstadoEvolution, type EstadoEntregaLink, type DiagnosticoEntregaLink
} from './status-entrega-link.js';
import { contaDoCofreId } from '../cofre/identidade-conta.js';

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
export async function registrarEstadoEvolution(
  pool: Banco, entrada:unknown, instanciaPermitida:string, segredo:string
):Promise<boolean> {
  const evento=interpretarEstadoEvolution(entrada);
  if (!evento || evento.instancia!==instanciaPermitida) return false;
  const candidatos=[...new Set(evento.destinatarios.flatMap(numero=>
    gerarVariantesTelefoneBrasileiro(numero)).map(t=>hashDestinatario(segredo,t)))];
  if (!candidatos.length) return false;
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
    returning link_id
  `,[evento.instancia,evento.mensagemId,candidatos,evento.estado]);
  // Explicitamente ignorar mensagens estranhas em vez de expor a existencia do link.
  return !!result.rows.length;
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
