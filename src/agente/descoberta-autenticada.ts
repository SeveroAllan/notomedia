import type pg from 'pg';
import {nomeProfissionalValido} from '../conta/validar-dados-emissao.js';
import {normalizarNomeMedico} from '../conta/medicos-conta.js';
import type {AgendaEscolhida,EstadoConversa} from './estado-conversa.js';

type Banco=Pick<pg.Pool,'query'>;
type Descoberta={agenda:AgendaEscolhida;nomes:string[]};
export type EstadoRecuperacaoDescoberta='JA_COMPROVADA'|'RECUPERADA'|'SEM_PROVA'|
  'CONFLITO_ESTADO'|'CONFLITO_PROVAS';

function conferirDescoberta(agenda:unknown,nomes:unknown):Descoberta|null{
  if(agenda!=='tribemd'&&agenda!=='amplimed'||!Array.isArray(nomes))return null;
  const validos=nomes.filter((n:unknown):n is string=>
    typeof n==='string'&&n.length<=150&&nomeProfissionalValido(n)).slice(0,20);
  if(!validos.length||validos.length!==nomes.length||
    new Set(validos.map(normalizarNomeMedico)).size!==validos.length)return null;
  return {agenda,nomes:validos};
}

/** Garantia fundamental: NENHUM balão pedindo confirmação se a prova não
 * entrou no estado da conta. A escrita usa CAS na fase/agenda e não ressuscita
 * convite já concluído nem substitui uma descoberta concorrente diferente.
 *
 * A origem deste método deve ser o resultado autenticado do worker ou um
 * registro autenticado em noto_agent_trabalhos, NUNCA o texto do WhatsApp/IA.
 */
export async function persistirDescobertaComprovada(
  pool:Banco,contaId:string,agenda:AgendaEscolhida,nomes:unknown
):Promise<boolean>{
  const fonte=conferirDescoberta(agenda,nomes);
  if(!fonte)return false;
  const r=await pool.query([
    'insert into public.noto_agent_conversas (conta_id,estado)',
    "values ($1,jsonb_build_object('agendaEscolhida',$3::text,",
    "'faseAgenda','CONFIRMACAO_PENDENTE','descoberta',$2::jsonb))",
    'on conflict (conta_id) do update set',
    "estado=public.noto_agent_conversas.estado ||",
    "jsonb_build_object('faseAgenda','CONFIRMACAO_PENDENTE','descoberta',$2::jsonb),",
    'atualizado_em=now()',
    'where (public.noto_agent_conversas.estado->>\'agendaEscolhida\' is null',
    'or public.noto_agent_conversas.estado->>\'agendaEscolhida\'=$3)',
    "and coalesce(public.noto_agent_conversas.estado->>'faseAgenda','')",
    "not in ('VINCULO_CONFIRMADO')",
    "and (public.noto_agent_conversas.estado->>'faseAgenda'",
    "is distinct from 'CONFIRMACAO_PENDENTE' or",
    "public.noto_agent_conversas.estado->'descoberta'=$2::jsonb)",
    'returning conta_id'
  ].join('\n'),[contaId,JSON.stringify(fonte),agenda]);
  return r.rows.length===1;
}

/** Reparo pontual de um resultado autenticado já registrado antes da correção
 * do worker. Não faz consulta ao portal, não pede modelo, não autoriza vínculo.
 * Só reconstitui estado se uma fonte correta, da mesma conta/instância/agenda,
 * foi efetivamente registrada e a fase atual ainda permite confirmação.
 */
export async function recuperarDescobertaComprovada(
  pool:Banco,contaId:string,instancia:string,atual:EstadoConversa
):Promise<EstadoRecuperacaoDescoberta>{
  if(atual.faseAgenda==='VINCULO_CONFIRMADO')return 'CONFLITO_ESTADO';
  if(atual.faseAgenda==='CONFIRMACAO_PENDENTE'&&
     conferirDescoberta(atual.descoberta?.agenda,atual.descoberta?.nomes))
    return 'JA_COMPROVADA';
  if(atual.faseAgenda==='CONFIRMACAO_PENDENTE'&&atual.descoberta?.nomes.length)
    return 'CONFLITO_ESTADO';
  const r=await pool.query([
    'select agenda,resultado from public.noto_agent_trabalhos',
    "where conta_id=$1 and instancia=$2 and tipo='descoberta_agenda'",
    "and estado='aceito_api' and resultado->>'ok'='true'",
    'order by atualizado_em desc,id desc limit 2'
  ].join('\n'),[contaId,instancia]);
  if(!r.rows.length)return 'SEM_PROVA';
  const fontes=r.rows.map(x=>{
    const dado=x.resultado;
    return dado && typeof dado==='object' && !Array.isArray(dado) &&
      dado.agenda===x.agenda ? conferirDescoberta(x.agenda,dado.nomes) : null;
  });
  if(!fontes[0])return 'SEM_PROVA';
  // Uma descoberta posterior incompatível não pode ser escolhida por ordem
  // cega quando o histórico tem candidatos conflitantes.
  if(fontes[1]&&JSON.stringify(fontes[0])!==JSON.stringify(fontes[1]))
    return 'CONFLITO_PROVAS';
  if(atual.agendaEscolhida&&atual.agendaEscolhida!==fontes[0].agenda)
    return 'CONFLITO_ESTADO';
  if(atual.descoberta&&JSON.stringify(atual.descoberta)!==JSON.stringify(fontes[0]))
    return 'CONFLITO_ESTADO';
  const ok=await persistirDescobertaComprovada(pool,contaId,
    fontes[0].agenda,fontes[0].nomes);
  return ok?'RECUPERADA':'CONFLITO_ESTADO';
}
