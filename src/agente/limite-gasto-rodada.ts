import {randomUUID} from 'node:crypto';
import type pg from 'pg';

export type FinalidadeChamadaNoto='conversa'|'crm_rqe';
export type MotivoPausaNoto='SEM_RODADA'|'LIMITE_TESTE'|'MODELO_SEM_PRECO'|'CONTROLE_INDISPONIVEL';
export class PausaCustoPiloto extends Error{
  constructor(public readonly motivo:MotivoPausaNoto){
    super('NOTO_TESTE_IA_PAUSADO');this.name='PausaCustoPiloto';
  }
}
/** USD em nanos: evita erro de centavos e contabiliza separadamente reservas. */
export const TETO_RODADA_NANO_USD=1_000_000_000;
const PRECO_GPT_4O_MINI={entrada:150,saida:600,contexto:128_000,saidaMax:16_384} as const;
export const FALA_LIMITE_TESTE=
  'Pausei a rodada de homologação porque o orçamento de US$ 1 não comporta outra chamada de IA. O Noto não fez essa chamada. Uma nova rodada precisa ser iniciada pelo responsável pelos testes.';

export interface ConsumoChamadaNoto{entrada:number;saida:number}
export interface ReservaChamadaNoto{id:string;rodadaId:string;maximoNanoUsd:number}

/** Não interpretar uso ausente como zero: reter todo o valor reservado. */
export function consumoVerificado(bruto:unknown):ConsumoChamadaNoto|null{
  if(!bruto||typeof bruto!=='object')return null;
  const u=bruto as Record<string,unknown>;
  const entrada=u['inputTokens']??u['prompt_tokens'];
  const saida=u['outputTokens']??u['completion_tokens'];
  if(typeof entrada!=='number'||typeof saida!=='number'||
     !Number.isSafeInteger(entrada)||!Number.isSafeInteger(saida)||
     entrada<0||saida<0)return null;
  return {entrada,saida};
}
export function custoNanoUsd(consumo:ConsumoChamadaNoto):number{
  return consumo.entrada*PRECO_GPT_4O_MINI.entrada+
    consumo.saida*PRECO_GPT_4O_MINI.saida;
}
export function custoMaximoNanoUsd(modelo:string):number{
  if(modelo!=='gpt-4o-mini')throw new PausaCustoPiloto('MODELO_SEM_PRECO');
  // Reservar o MÁXIMO técnico por chamada, não uma estimativa por caracteres.
  // Protege até input 128k e output 16.384 do modelo, inclusive em falhas
  // nas quais o provedor não devolve usage.
  return custoNanoUsd({entrada:PRECO_GPT_4O_MINI.contexto,
    saida:PRECO_GPT_4O_MINI.saidaMax});
}

type Banco=Pick<pg.Pool,'connect'|'query'>;
export interface EstadoOrcamentoNoto{
  estado:'ativa'|'pausada'|'sem_rodada'|'indisponivel';
  limiteNanoUsd:number;
  reservadoNanoUsd:number;
  utilizadoNanoUsd:number;
}
export async function lerOrcamentoNoto(pool:Banco):Promise<EstadoOrcamentoNoto>{
  try{
    const r=await pool.query([
      'select estado,limite_nano_usd,reservado_nano_usd,utilizado_nano_usd',
      'from public.noto_piloto_rodadas_ia',
      "where estado in ('ativa','pausada') order by criada_em desc limit 1"
    ].join('\n'));
    const x=r.rows[0];
    return x?{estado:x.estado,
      limiteNanoUsd:Number(x.limite_nano_usd),
      reservadoNanoUsd:Number(x.reservado_nano_usd),
      utilizadoNanoUsd:Number(x.utilizado_nano_usd)}
      :{estado:'sem_rodada',limiteNanoUsd:TETO_RODADA_NANO_USD,reservadoNanoUsd:0,utilizadoNanoUsd:0};
  }catch{return {estado:'indisponivel',limiteNanoUsd:TETO_RODADA_NANO_USD,reservadoNanoUsd:0,utilizadoNanoUsd:0};}
}
export async function exigirRodadaAtiva(pool:Banco):Promise<void>{
  const estado=await lerOrcamentoNoto(pool);
  if(estado.estado!=='ativa')throw new PausaCustoPiloto(
    estado.estado==='pausada'?'LIMITE_TESTE':
    estado.estado==='indisponivel'?'CONTROLE_INDISPONIVEL':'SEM_RODADA');
}

/** Ordem atômica entre worker e webhook, incluindo múltiplos processos.
 * A reserva é feita ANTES da chamada externa; crash não devolve orçamento.
 */
export async function reservarCustoPiloto(pool:Banco,finalidade:FinalidadeChamadaNoto,
  modelo:string):Promise<ReservaChamadaNoto>{
  const maximo=custoMaximoNanoUsd(modelo);
  if(!['conversa','crm_rqe'].includes(finalidade))
    throw new PausaCustoPiloto('CONTROLE_INDISPONIVEL');
  let client:pg.PoolClient;
  try{client=await pool.connect();}
  catch{throw new PausaCustoPiloto('CONTROLE_INDISPONIVEL');}
  let concluiu=false;
  try{
    await client.query('begin');
    const r=await client.query([
      'select id,limite_nano_usd,reservado_nano_usd,utilizado_nano_usd',
      'from public.noto_piloto_rodadas_ia',
      "where estado='ativa' for update"
    ].join('\n'));
    const atual=r.rows[0];
    if(!atual){
      const ultima=await client.query([
        "select estado from public.noto_piloto_rodadas_ia",
        'order by criada_em desc limit 1'
      ].join('\n'));
      await client.query('rollback');concluiu=true;
      throw new PausaCustoPiloto(
        ultima.rows[0]?.estado==='pausada'?'LIMITE_TESTE':'SEM_RODADA');
    }
    const total=Number(atual.reservado_nano_usd)+Number(atual.utilizado_nano_usd);
    if(total+maximo>Number(atual.limite_nano_usd)){
      await client.query([
        'update public.noto_piloto_rodadas_ia',
        "set estado='pausada',aviso_estado='pendente' where id=$1"
      ].join('\n'),[atual.id]);
      await client.query('commit');concluiu=true;
      throw new PausaCustoPiloto('LIMITE_TESTE');
    }
    const id=randomUUID();
    await client.query([
      'update public.noto_piloto_rodadas_ia',
      'set reservado_nano_usd=reservado_nano_usd+$2 where id=$1'
    ].join('\n'),[atual.id,maximo]);
    await client.query([
      'insert into public.noto_piloto_chamadas_ia',
      '(id,rodada_id,finalidade,modelo,reservado_nano_usd,estado)',
      "values($1,$2,$3,$4,$5,'reservada')"
    ].join('\n'),[id,atual.id,finalidade,modelo,maximo]);
    await client.query('commit');concluiu=true;
    return {id,rodadaId:atual.id,maximoNanoUsd:maximo};
  }catch(error){
    if(error instanceof PausaCustoPiloto)throw error;
    throw new PausaCustoPiloto('CONTROLE_INDISPONIVEL');
  }finally{
    if(!concluiu)await client.query('rollback').catch(()=>undefined);
    client.release();
  }
}
/** No uso ausente/falha, todo o valor permanece retido, mesmo após reinício.
 * Não há resgate automático de reservas incertas.
 */
export async function liquidarCustoPiloto(pool:Banco,reserva:ReservaChamadaNoto,
  uso:ConsumoChamadaNoto|null):Promise<void>{
  let client:pg.PoolClient;
  try{client=await pool.connect();}
  catch{throw new PausaCustoPiloto('CONTROLE_INDISPONIVEL');}
  let confirmou=false;
  try{
    await client.query('begin');
    const r=await client.query([
      'select reservado_nano_usd,estado from public.noto_piloto_chamadas_ia',
      'where id=$1 and rodada_id=$2 for update'
    ].join('\n'),[reserva.id,reserva.rodadaId]);
    const atual=r.rows[0];
    if(!atual)throw Error('RESERVA_NAO_ENCONTRADA');
    if(atual.estado!=='reservada'){
      await client.query('commit');confirmou=true;return;
    }
    const valor=uso?custoNanoUsd(uso):null;
    const valido=valor!==null&&valor<=Number(atual.reservado_nano_usd);
    await client.query([
      'update public.noto_piloto_chamadas_ia set estado=$2,',
      'utilizado_nano_usd=$3,tokens_entrada=$4,tokens_saida=$5,finalizada_em=now()',
      'where id=$1'
    ].join('\n'),[reserva.id,valido?'liquidada':'incerta',
      valido?valor:null,valido?uso?.entrada:null,valido?uso?.saida:null]);
    if(valido){
      await client.query([
        'update public.noto_piloto_rodadas_ia',
        'set reservado_nano_usd=reservado_nano_usd-$2,',
        'utilizado_nano_usd=utilizado_nano_usd+$3 where id=$1'
      ].join('\n'),[reserva.rodadaId,reserva.maximoNanoUsd,valor]);
    }
    await client.query('commit');confirmou=true;
  }catch{throw new PausaCustoPiloto('CONTROLE_INDISPONIVEL');}
  finally{
    if(!confirmou)await client.query('rollback').catch(()=>undefined);
    client.release();
  }
}

/** Somente o worker do telefone permitido recebe uma notificação.
 * Reservar antes de enviar evita duplicados após crash ou webhooks repetidos.
 */
export async function notificarPausaPorCusto(pool:Banco,
  enviar:(mensagem:string)=>Promise<boolean>):Promise<boolean>{
  const r=await pool.query([
    'update public.noto_piloto_rodadas_ia',
    "set aviso_estado='reservado' where id=(",
    'select id from public.noto_piloto_rodadas_ia',
    "where estado='pausada' and aviso_estado='pendente'",
    'order by criada_em desc limit 1 for update skip locked)',
    'returning id'
  ].join('\n')).catch(()=>({rows:[]}));
  if(!r.rows.length)return false;
  let enviado=false;
  try{enviado=await enviar(FALA_LIMITE_TESTE);}
  catch{/* Falha de transporte não autoriza reenvio automático. */}
  await pool.query([
    "update public.noto_piloto_rodadas_ia set aviso_estado=$2 where id=$1",
    "and aviso_estado='reservado'"
  ].join('\n'),[r.rows[0].id,enviado?'aceito':'incerto']).catch(()=>undefined);
  return true;
}
