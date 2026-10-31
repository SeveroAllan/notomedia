import type pg from 'pg';
import type {AgendaSuportada} from '../agenda/agendas-suportadas.js';
import {normalizarNomeMedico} from './medicos-conta.js';

export async function resolverVinculoAgendaConta(
  pool:pg.Pool,
  medicoId:string,
  agenda:AgendaSuportada
):Promise<{referenciaMedicoId:string;profissionalExternoId:string|null}>{
  const {rows}=await pool.query(`
    select r.referencia_medico_id, r.profissional_externo_id
    from public.noto_medico_agenda_referencias r
    join medicos alvo on alvo.id=r.medico_id
    join medicos fonte on fonte.id=r.referencia_medico_id and fonte.conta_id=alvo.conta_id
    where r.medico_id=$1 and r.agenda=$2
    limit 1
  `,[medicoId,agenda]);
  return {referenciaMedicoId:rows[0]?.referencia_medico_id??medicoId,profissionalExternoId:rows[0]?.profissional_externo_id??null};
}

export async function resolverReferenciaAgendaConta(
  pool:pg.Pool,
  medicoId:string,
  agenda:AgendaSuportada
):Promise<string>{
  return (await resolverVinculoAgendaConta(pool,medicoId,agenda)).referenciaMedicoId;
}

export async function vincularReferenciaAgendaConta(
  pool:pg.Pool,
  medicoIds:readonly string[],
  agenda:AgendaSuportada,
  referenciaMedicoId:string,
  profissionalExternoId?:string|null
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
        (medico_id,agenda,referencia_medico_id,profissional_externo_id,atualizado_em)
      select id,$2,(select id from fonte),$4,now() from alvos
      on conflict (medico_id,agenda) do update
        set referencia_medico_id=excluded.referencia_medico_id,
            profissional_externo_id=coalesce(excluded.profissional_externo_id,noto_medico_agenda_referencias.profissional_externo_id),
            atualizado_em=excluded.atualizado_em
      returning medico_id
    )
    select medico_id from gravados
  `,[medicoIds,agenda,referenciaMedicoId,profissionalExternoId??null]);
  return rows.length===new Set(medicoIds).size;
}

export type RevalidacaoVinculoAmplimed =
  | {status:'sem_vinculo'}
  | {status:'ok';profissionalExternoId:string}
  | {status:'divergente';nomeAgenda:string|null}
  | {status:'indisponivel'};

/** Fail-closed na LEITURA do vínculo existente: o nome do profissional da agenda para o
 *  código vinculado precisa continuar correspondendo ao médico Noto. Conexão+código seguem
 *  âncora; divergência de nome (rename, reatribuição) ou lista indisponível bloqueia a leitura
 *  até revisão confirmada — nunca reatribui nem quebra o vínculo silenciosamente. */
export async function revalidarVinculoProfissionalAmplimed(
  pool:pg.Pool,
  deps:{listarProfissionaisAmplimed:(medicoId:string)=>Promise<{ok:true;profissionais:Array<{codigo:number|string;nome:string}>}|{ok:false;motivo:string}>},
  medicoId:string
):Promise<RevalidacaoVinculoAmplimed>{
  const vinculo=await resolverVinculoAgendaConta(pool,medicoId,'amplimed').catch(()=>null);
  if(!vinculo?.profissionalExternoId) return {status:'sem_vinculo'};
  const lista=await deps.listarProfissionaisAmplimed(medicoId).catch(()=>null);
  if(!lista||!lista.ok) return {status:'indisponivel'};
  const {rows}=await pool.query('select nome_completo from medicos where id=$1',[medicoId]);
  const nomeMedico=String(rows[0]?.nome_completo??'');
  const profissional=lista.profissionais.find(p=>String(p.codigo)===String(vinculo.profissionalExternoId));
  if(!profissional) return {status:'divergente',nomeAgenda:null};
  if(normalizarNomeMedico(profissional.nome)!==normalizarNomeMedico(nomeMedico)) return {status:'divergente',nomeAgenda:profissional.nome};
  return {status:'ok',profissionalExternoId:String(vinculo.profissionalExternoId)};
}
