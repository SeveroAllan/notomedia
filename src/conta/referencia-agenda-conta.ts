import type pg from 'pg';
import type {AgendaSuportada} from '../agenda/agendas-suportadas.js';

export async function resolverReferenciaAgendaConta(
  pool:pg.Pool,
  medicoId:string,
  agenda:AgendaSuportada
):Promise<string>{
  const {rows}=await pool.query(`
    select r.referencia_medico_id
    from public.noto_medico_agenda_referencias r
    join medicos alvo on alvo.id=r.medico_id
    join medicos fonte on fonte.id=r.referencia_medico_id and fonte.conta_id=alvo.conta_id
    where r.medico_id=$1 and r.agenda=$2
    limit 1
  `,[medicoId,agenda]);
  return rows[0]?.referencia_medico_id??medicoId;
}

export async function vincularReferenciaAgendaConta(
  pool:pg.Pool,
  medicoIds:readonly string[],
  agenda:AgendaSuportada,
  referenciaMedicoId:string
):Promise<boolean>{
  if(!medicoIds.length)return true;
  const {rows}=await pool.query(`
    with fonte as (
      select id,conta_id from medicos where id=$3
    ), alvos as (
      select m.id
      from medicos m join fonte f on f.conta_id=m.conta_id
      where m.id=any($1::uuid[])
    ), gravados as (
      insert into public.noto_medico_agenda_referencias
        (medico_id,agenda,referencia_medico_id,atualizado_em)
      select id,$2,(select id from fonte),now() from alvos
      on conflict (medico_id,agenda) do update
        set referencia_medico_id=excluded.referencia_medico_id,atualizado_em=excluded.atualizado_em
      returning medico_id
    )
    select medico_id from gravados
  `,[medicoIds,agenda,referenciaMedicoId]);
  return rows.length===new Set(medicoIds).size;
}
