import type pg from 'pg';
import {nomeProfissionalValido} from '../conta/validar-dados-emissao.js';
import {normalizarNomeMedico} from '../conta/medicos-conta.js';
import type {AgendaEscolhida,EstadoConversa} from './estado-conversa.js';

type Banco=Pick<pg.Pool,'query'>;
type Descoberta={agenda:AgendaEscolhida;nomes:string[]};
export type OrigemDescoberta='cofre_sessao'|'trabalho_agenda';
export type EstadoRecuperacaoDescoberta='VINCULO_PRESERVADO'|'JA_COMPROVADA'|'RECUPERADA'|
  'RECUPERADA_ESTADO'|'SEM_PROVA'|'CONFLITO_ESTADO'|'CONFLITO_PROVAS';

function conferirDescoberta(agenda:unknown,nomes:unknown):Descoberta|null{
  if(agenda!=='tribemd'&&agenda!=='amplimed'||!Array.isArray(nomes))return null;
  const validos=nomes.filter((n:unknown):n is string=>
    typeof n==='string'&&n.length<=150&&nomeProfissionalValido(n)).slice(0,20);
  if(!validos.length||validos.length!==nomes.length||
    new Set(validos.map(normalizarNomeMedico)).size!==validos.length)return null;
  return {agenda,nomes:validos};
}

/** Fonte exclusivamente interna: callback autenticado do Cofre ou resultado
 * autenticado do worker. Prova e fase são gravadas numa única operação;
 * nunca aceitar nome informado pelo modelo/usuário como origem.
 */
export async function persistirDescobertaComprovada(
  pool:Banco,contaId:string,agenda:AgendaEscolhida,nomes:unknown,
  origem:OrigemDescoberta='trabalho_agenda'
):Promise<boolean>{
  const fonte=conferirDescoberta(agenda,nomes);
  if(!fonte||!['cofre_sessao','trabalho_agenda'].includes(origem))return false;
  const r=await pool.query([
    'insert into public.noto_agent_conversas as c (conta_id,estado)',
    "values ($1,jsonb_build_object('agendaEscolhida',$3::text,",
    "'faseAgenda','CONFIRMACAO_PENDENTE','descoberta',$2::jsonb,",
    "'origemDescoberta',$4::text,'perguntaPendente',",
    "case when jsonb_array_length($2::jsonb->'nomes')=1 then",
    "'confirmar_profissional' else null end))",
    'on conflict (conta_id) do update set',
    "estado=c.estado || jsonb_build_object('agendaEscolhida',$3::text,",
    "'faseAgenda','CONFIRMACAO_PENDENTE','descoberta',$2::jsonb,",
    "'origemDescoberta',$4::text,'perguntaPendente',",
    "case when jsonb_array_length($2::jsonb->'nomes')=1 then",
    "'confirmar_profissional' else null end),",
    'atualizado_em=now()',
    "where (c.estado->>'agendaEscolhida' is null or c.estado->>'agendaEscolhida'=$3)",
    "and (c.estado->>'faseAgenda' is null or c.estado->>'faseAgenda'",
    "in ('DESCOBERTA_PENDENTE','CONFIRMACAO_PENDENTE'))",
    "and (c.estado->'descoberta' is null or c.estado->'descoberta'=$2::jsonb)",
    "and (c.estado->>'profissionalConfirmadoId' is null or",
    "c.estado->>'faseAgenda'='CONFIRMACAO_PENDENTE')",
    'returning conta_id'
  ].join('\n'),[contaId,JSON.stringify(fonte),agenda,origem]);
  return r.rows.length===1;
}

/** Quando o navegador conecta, mas não encontra nomes, não rebaixar uma
 * confirmação ou vínculo que outro evento possa ter persistido.
 */
export async function persistirDescobertaAindaPendente(
  pool:Banco,contaId:string,agenda:AgendaEscolhida
):Promise<boolean>{
  const r=await pool.query([
    'insert into public.noto_agent_conversas as c (conta_id,estado)',
    "values($1,jsonb_build_object('agendaEscolhida',$2::text,",
    "'faseAgenda','DESCOBERTA_PENDENTE'))",
    'on conflict(conta_id) do update set',
    "estado=c.estado||jsonb_build_object('agendaEscolhida',$2::text,",
    "'faseAgenda','DESCOBERTA_PENDENTE'),atualizado_em=now()",
    "where (c.estado->>'agendaEscolhida' is null or c.estado->>'agendaEscolhida'=$2)",
    "and (c.estado->>'faseAgenda' is null or",
    "c.estado->>'faseAgenda'='DESCOBERTA_PENDENTE')",
    "and c.estado->'descoberta' is null",
    'returning conta_id'
  ].join('\n'),[contaId,agenda]);
  return r.rows.length===1;
}

/** Legado: descoberta persistida em tabela controlada pelo servidor a partir
 * de leitura autenticada, mas com fase ausente. Não cria prova a partir da
 * conversa. CAS compara o JSON bruto para evitar reconstruir a partir de
 * nomes filtrados ou de um estado mudado em paralelo.
 */
async function completarFaseDeSnapshotLegado(
  pool:Banco,contaId:string,atual:EstadoConversa
):Promise<'RECUPERADA_ESTADO'|'CONFLITO_ESTADO'|'SEM_PROVA'>{
  if(atual.faseAgenda!==undefined)return 'CONFLITO_ESTADO';
  const fonte=conferirDescoberta(atual.descoberta?.agenda,atual.descoberta?.nomes);
  if(!fonte)return 'SEM_PROVA';
  if(atual.agendaEscolhida&&atual.agendaEscolhida!==fonte.agenda)
    return 'CONFLITO_ESTADO';
  const r=await pool.query([
    'update public.noto_agent_conversas as c',
    "set estado=c.estado||jsonb_build_object(",
    "'agendaEscolhida',$3::text,'faseAgenda','CONFIRMACAO_PENDENTE',",
    "'perguntaPendente',case when jsonb_array_length($2::jsonb->'nomes')=1",
    "then 'confirmar_profissional' else null end,",
    "'origemDescoberta',coalesce(c.estado->>'origemDescoberta','legado_validado')),",
    'atualizado_em=now()',
    'where c.conta_id=$1',
    // Somente chave realmente AUSENTE; JSON null e valores ilegais
    // não são equivalentes à falta de uma fase nunca gravada.
    "and not (c.estado ? 'faseAgenda')",
    "and c.estado->'descoberta'=$2::jsonb",
    "and (c.estado->>'agendaEscolhida' is null or c.estado->>'agendaEscolhida'=$3)",
    "and (c.estado->>'origemDescoberta' is null or",
    "c.estado->>'origemDescoberta' in ('cofre_sessao','trabalho_agenda',",
    "'ferramenta_agenda','legado_validado'))",
    // Já vinculado é uma transição potencialmente concluída: não reabrir.
    "and c.estado->>'profissionalConfirmadoId' is null",
    'returning conta_id'
  ].join('\n'),[contaId,JSON.stringify(fonte),fonte.agenda]);
  return r.rows.length===1?'RECUPERADA_ESTADO':'CONFLITO_ESTADO';
}

/** Reparo pontual de um resultado autenticado já registrado antes da correção
 * do worker. Não faz consulta ao portal, não pede modelo, não autoriza vínculo.
 * Só reconstitui estado se uma fonte correta, da mesma conta/instância/agenda,
 * foi efetivamente registrada e a fase atual ainda permite confirmação.
 */
export async function recuperarDescobertaComprovada(
  pool:Banco,contaId:string,instancia:string,atual:EstadoConversa
):Promise<EstadoRecuperacaoDescoberta>{
  if(atual.faseAgenda==='VINCULO_CONFIRMADO')return 'VINCULO_PRESERVADO';
  if(atual.faseAgenda==='CONFIRMACAO_PENDENTE'&&
     conferirDescoberta(atual.descoberta?.agenda,atual.descoberta?.nomes))
    return 'JA_COMPROVADA';
  if(atual.faseAgenda==='CONFIRMACAO_PENDENTE'&&atual.descoberta?.nomes.length)
    return 'CONFLITO_ESTADO';
  if(!atual.faseAgenda&&atual.descoberta){
    // Cobrir o callback do navegador, que não cria noto_agent_trabalhos.
    // A fonte é o snapshot estruturado persistido pela aplicação, nunca
    // o nome repetido em um balão. Fase malformada no JSON bruto falha no CAS.
    const legado=await completarFaseDeSnapshotLegado(pool,contaId,atual);
    if(legado!=='SEM_PROVA')return legado;
  }
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
