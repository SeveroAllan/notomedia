import type pg from 'pg';
import { normalizarNomeMedico } from '../conta/medicos-conta.js';
import { normalizarCrm, nomeProfissionalValido } from '../conta/validar-dados-emissao.js';
import type { ConsultaRegistro, ResultadoConsultaRegistro } from '../cadastro/consultas.js';
import type { DadosMedicoOnline } from '../medico/io/buscar-medico-online.js';

export interface SugestaoRegistro {
  crm:string; uf:string; rqes:string[]; origem:string; urlOrigem?:string;
}
export type StatusPesquisa = 'pendente'|'executando'|'resultado_pronto'|'notificando'|
  'aguardando_confirmacao'|'manual_pendente'|'link_manual_reservado'|'aguardando_preenchimento'|'inconclusiva'|'confirmada'|'recusada';
export type RazaoPesquisa = 'ENCONTRADO'|'HOMONIMOS'|'SEM_RESULTADO'|'FONTE_INDISPONIVEL'|'EVIDENCIA_INCOMPLETA'|'LIMITE_TENTATIVAS'|'MANUAL_INFORMADO';
export interface PesquisaRegistroConversa {
  nome:string; estado:StatusPesquisa; razao?:RazaoPesquisa;
  candidatos?:SugestaoRegistro[];
  proposta?:{crm:string;rqe?:string;origem:'correcao'|'manual'};
  tentativas?:number;
  proximaTentativaEm?:string;
  reservadoEm?:string;
  envio?:'aceito_api'|'incerto';
}
type Banco=Pick<pg.Pool,'query'>;
export const MAX_TENTATIVAS_REGISTRO=4;
// Evita sequência imediata de requisições e dá margem para rate limits externos.
const ESPERA_MINUTOS=[5,15,60] as const;
const estados=['pendente','executando','resultado_pronto','notificando','aguardando_confirmacao','manual_pendente','link_manual_reservado','aguardando_preenchimento','inconclusiva','confirmada','recusada'];
const razoes=['ENCONTRADO','HOMONIMOS','SEM_RESULTADO','FONTE_INDISPONIVEL','EVIDENCIA_INCOMPLETA','LIMITE_TENTATIVAS','MANUAL_INFORMADO'];
const rqeValido=(v:string)=>/^[1-9]\d{0,11}$/.test(v);

export function leituraPesquisaEstado(obj:unknown):Record<string,PesquisaRegistroConversa>{
  if(!obj||typeof obj!=='object'||Array.isArray(obj))return {};
  const resultado:Record<string,PesquisaRegistroConversa>={};
  for(const [id,r] of Object.entries(obj).slice(0,25)){
    if(!/^[0-9a-f-]{36}$/i.test(id)||!r||typeof r!=='object'||Array.isArray(r))continue;
    const e=r as Record<string,unknown>;
    if(!nomeProfissionalValido(e['nome'])||!estados.includes(String(e['estado'])))continue;
    // Copia exclusivamente campos autorizados: dados inesperados de um
    // registro persistido NUNCA podem chegar ao modelo ou ao WhatsApp.
    const candidatos:SugestaoRegistro[]=[];
    if(Array.isArray(e['candidatos'])){
      for(const bruto of e['candidatos'].slice(0,5)){
        if(!bruto||typeof bruto!=='object'||Array.isArray(bruto))continue;
        const c=bruto as Record<string,unknown>;
        const crm=c['crm'],uf=c['uf'],origem=c['origem'],url=c['urlOrigem'];
        if(typeof crm!=='string'||normalizarCrm(crm)!==crm||!crm.includes('/')||
          typeof uf!=='string'||crm.split('/')[1]!==uf||
          typeof origem!=='string'||origem.length>155||!origem.trim()||
          !Array.isArray(c['rqes'])||c['rqes'].length>5||
          !c['rqes'].every((v:unknown)=>typeof v==='string'&&rqeValido(v))||
          (url!==undefined&&(typeof url!=='string'||!url.startsWith('https://')||url.length>950)))
          continue;
        candidatos.push({crm,uf,rqes:[...c['rqes']] as string[],origem,
          ...(typeof url==='string'?{urlOrigem:url}:{})});
      }
    }
    const proposta=e['proposta']&&typeof e['proposta']==='object'&&!Array.isArray(e['proposta'])
      ?e['proposta'] as Record<string,unknown>:null;
    resultado[id]={
      nome:String(e['nome']),estado:e['estado'] as StatusPesquisa,
      ...(razoes.includes(String(e['razao']))?{razao:e['razao'] as RazaoPesquisa}:{}),
      ...(candidatos.length?{candidatos}:{}),
      ...((proposta?.['origem']==='correcao'||proposta?.['origem']==='manual')&&typeof proposta['crm']==='string'&&
        normalizarCrm(proposta['crm'])===proposta['crm']&&
        (proposta['rqe']===undefined ||
          (typeof proposta['rqe']==='string'&&rqeValido(proposta['rqe'])))?
        {proposta:{crm:proposta['crm'],...(proposta['rqe']?{rqe:proposta['rqe']}:{}),origem:proposta['origem'] as 'correcao'|'manual'}}:{}),
      ...(Number.isInteger(e['tentativas']) && (e['tentativas'] as number)>=0 && (e['tentativas'] as number)<=MAX_TENTATIVAS_REGISTRO ? {tentativas:e['tentativas'] as number}:{}),
      ...(typeof e['proximaTentativaEm']==='string'&&Number.isFinite(Date.parse(e['proximaTentativaEm']))?{proximaTentativaEm:e['proximaTentativaEm']}:{}),
      ...(e['envio']==='aceito_api'||e['envio']==='incerto'?{envio:e['envio'] as 'aceito_api'|'incerto'}:{})
    };
  }
  return resultado;
}

export function extrairSugestoes(nome:string,r:ResultadoConsultaRegistro):
  {razao:RazaoPesquisa;candidatos:SugestaoRegistro[]} {
  if(r.estado==='indisponivel')return {razao:'FONTE_INDISPONIVEL',candidatos:[]};
  if(r.estado==='nao_encontrado')return {razao:'SEM_RESULTADO',candidatos:[]};
  if(r.estado!=='consultado')return {razao:'FONTE_INDISPONIVEL',candidatos:[]};
  const encontrados=new Map<string,SugestaoRegistro>();
  for(const d of (r.dados as DadosMedicoOnline[]).slice(0,10)){
    // "verificado=false" na OpenSerp significa ausência de homologação oficial
    // do CRM, NÃO que as citações públicas validadas pelo serviço sejam falsas.
    // Requeremos, nesse caso, a evidência literal que a porta já verificou.
    if(normalizarNomeMedico(d.nomeCompleto)!==normalizarNomeMedico(nome) ||
      (d.verificado===false && (!d.evidenciaCrm?.trim() || !d.urlOrigem)))continue;
    const crm=normalizarCrm(d.crm+'/'+d.uf);
    if(!crm || !crm.includes('/'))continue;
    const link=d.urlOrigem;
    if(link!==undefined && !/^https:\/\/[^@\s/]+/i.test(link))continue;
    const rqes=(d.rqes??(d.rqe?[d.rqe]:[])).filter((x:string):x is string=>typeof x==='string'&&rqeValido(x));
    const item:SugestaoRegistro={crm,uf:crm.split('/')[1]!,rqes:[...new Set(rqes)].slice(0,5),
      origem:(d.origem??'Pesquisa pública, sugestão não oficial').slice(0,155),
      ...(link?{urlOrigem:link.slice(0,950)}:{})};
    const existente=encontrados.get(crm);
    if(existente){
      existente.rqes=[...new Set([...existente.rqes,...item.rqes])].slice(0,5);
    }else encontrados.set(crm,item);
  }
  const candidatos=[...encontrados.values()].slice(0,5);
  return {razao:candidatos.length>1?'HOMONIMOS':candidatos.length===1?'ENCONTRADO':'EVIDENCIA_INCOMPLETA',candidatos};
}

export async function agendarPesquisaRegistro(
  pool:Banco,contaId:string,medicoId:string,nome:string
):Promise<'agendada'|'ja_existe'|'indisponivel'> {
  if(!nomeProfissionalValido(nome)||!/^[0-9a-f-]{36}$/i.test(medicoId))return 'indisponivel';
  const pendente={nome,estado:'pendente',tentativas:0};
  try{
    // A conversa existe pois a confirmação do médico já foi registrada.
    // UPDATE com predicado negativo serializa concorrência na mesma conta.
    const sql=[
      'update public.noto_agent_conversas c',
      "set estado=jsonb_set(c.estado,'{pesquisasRegistro}',",
      "coalesce(c.estado->'pesquisasRegistro','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb),true),",
      'atualizado_em=now() where c.conta_id=$1',
      "and not coalesce(c.estado->'pesquisasRegistro','{}'::jsonb) ? $2::text",
      'and exists(select 1 from public.medicos m where m.conta_id=$1',
      'and m.id=$2::uuid and m.nome_completo=$4)',
      'returning conta_id'
    ].join('\n');
    const r=await pool.query(sql,[contaId,medicoId,JSON.stringify(pendente),nome]);
    if(r.rows.length===1)return 'agendada';
    const ja=await pool.query([
      'select 1 from public.medicos m',
      'join public.noto_agent_conversas c on c.conta_id=m.conta_id',
      'where m.conta_id=$1 and m.id=$2::uuid and m.nome_completo=$3',
      "and coalesce(c.estado->'pesquisasRegistro','{}'::jsonb) ? $2::text limit 1"
    ].join('\n'),[contaId,medicoId,nome]);
    return ja.rows.length?'ja_existe':'indisponivel';
  }catch(erro){
    // Apenas SQLSTATE, sem nome, telefone, CPF, query ou dados de pesquisa.
    const codigo=typeof (erro as {code?:unknown})?.code==='string'
      ? (erro as {code:string}).code:'INDEFINIDO';
    console.warn('NOTO_PESQUISA_AGENDAR',JSON.stringify({codigo}));
    return 'indisponivel';
  }
}
export interface PesquisaReservada {contaId:string;medicoId:string;nome:string;tentativas?:number}
/** Reserva da mesma linha JSONB, com incremento ANTES da chamada externa.
 * Se houver crash após a chamada paga, a tentativa continua consumida.
 */
export async function reservarPesquisaRegistro(pool:Banco):Promise<PesquisaReservada|null>{
  const sql=[
    'with proxima as (',
    'select c.conta_id,p.key as medico_id,p.value as item',
    'from public.noto_agent_conversas c',
    "cross join lateral jsonb_each(coalesce(c.estado->'pesquisasRegistro','{}'::jsonb)) p",
    "where p.value->>'estado'='pendente'",
    "and coalesce((p.value->>'tentativas')::int,0)<$1",
    "and coalesce((p.value->>'proximaTentativaEm')::timestamptz,'-infinity'::timestamptz)<=now()",
    'order by c.atualizado_em,c.conta_id,p.key for update of c skip locked limit 1)',
    'update public.noto_agent_conversas c',
    "set estado=jsonb_set(c.estado,array['pesquisasRegistro',proxima.medico_id],",
    "proxima.item||jsonb_build_object('estado','executando',",
    "'tentativas',coalesce((proxima.item->>'tentativas')::int,0)+1,",
    "'reservadoEm',now()::text),false),",
    'atualizado_em=now() from proxima where c.conta_id=proxima.conta_id',
    "returning c.conta_id,proxima.medico_id,proxima.item->>'nome' as nome,",
    "coalesce((proxima.item->>'tentativas')::int,0)+1 as tentativas"
  ].join('\n');
  const r=await pool.query(sql,[MAX_TENTATIVAS_REGISTRO]),x=r.rows[0];
  return x?{contaId:x.conta_id,medicoId:x.medico_id,nome:x.nome,tentativas:Number(x.tentativas)}:null;
}
async function atualizarPesquisa(
  pool:Banco,p:PesquisaReservada,anterior:StatusPesquisa,campos:Record<string,unknown>
):Promise<boolean>{
  const sql=[
    'update public.noto_agent_conversas c',
    "set estado=jsonb_set(c.estado,array['pesquisasRegistro',$2::text],",
    "c.estado#>array['pesquisasRegistro',$2::text]||$3::jsonb,false),atualizado_em=now()",
    "where c.conta_id=$1 and c.estado#>>array['pesquisasRegistro',$2::text,'estado']=$4",
    "and c.estado#>>array['pesquisasRegistro',$2::text,'nome']=$5",
    "and ($6::int is null or coalesce((c.estado#>>array['pesquisasRegistro',$2::text,'tentativas'])::int,0)=$6::int)",
    'returning conta_id'
  ].join('\n');
  const r=await pool.query(sql,[p.contaId,p.medicoId,JSON.stringify(campos),anterior,p.nome,p.tentativas]);
  return r.rows.length===1;
}
export async function executarPesquisaRegistro(pool:Banco,consulta:ConsultaRegistro):Promise<boolean>{
  const trabalho=await reservarPesquisaRegistro(pool);
  if(!trabalho)return false;
  let pesquisa:{razao:RazaoPesquisa;candidatos:SugestaoRegistro[]}={razao:'FONTE_INDISPONIVEL',candidatos:[]};
  try{
    const r=await pool.query(
      'select 1 from public.medicos where id=$1::uuid and conta_id=$2 and nome_completo=$3 limit 1',
      [trabalho.medicoId,trabalho.contaId,trabalho.nome]
    );
    if(r.rows.length===1)pesquisa=extrairSugestoes(trabalho.nome,await consulta.buscar(trabalho.nome));
  }catch{/* Nem a falha nem um timeout confirmam ausência de CRM/RQE. */}
  const confiavel=pesquisa.razao==='ENCONTRADO'&&pesquisa.candidatos.length===1;
  const esgotou=(trabalho.tentativas??MAX_TENTATIVAS_REGISTRO)>=MAX_TENTATIVAS_REGISTRO;
  const espera=ESPERA_MINUTOS[Math.min((trabalho.tentativas??1)-1,ESPERA_MINUTOS.length-1)]!;
  const proximaTentativaEm=new Date(Date.now()+espera*60_000).toISOString();
  // Uma pesquisa ambígua pode melhorar, mas NUNCA vira confirmação.
  await atualizarPesquisa(pool,trabalho,'executando',confiavel?
    {estado:'resultado_pronto',razao:'ENCONTRADO',candidatos:pesquisa.candidatos}:
    esgotou?{estado:'resultado_pronto',razao:'LIMITE_TENTATIVAS',candidatos:[]}:
    {estado:'pendente',razao:pesquisa.razao,candidatos:[],proximaTentativaEm});
  return true;
}

export interface PesquisaNotificar extends PesquisaReservada {pesquisa:PesquisaRegistroConversa}
export async function reservarAvisoPesquisa(pool:Banco):Promise<PesquisaNotificar|null>{
  const sql=[
    'with proxima as (select c.conta_id,p.key as medico_id,p.value as item',
    'from public.noto_agent_conversas c',
    "cross join lateral jsonb_each(coalesce(c.estado->'pesquisasRegistro','{}'::jsonb)) p",
    "where p.value->>'estado'='resultado_pronto'",
    'order by c.atualizado_em,c.conta_id,p.key for update of c skip locked limit 1)',
    'update public.noto_agent_conversas c',
    "set estado=jsonb_set(c.estado,array['pesquisasRegistro',proxima.medico_id],",
    "proxima.item||jsonb_build_object('estado','notificando','reservadoEm',now()::text),false),",
    'atualizado_em=now() from proxima where c.conta_id=proxima.conta_id',
    "returning c.conta_id,proxima.medico_id,proxima.item->>'nome' as nome,proxima.item"
  ].join('\n');
  const r=await pool.query(sql,[]),x=r.rows[0];
  return x?{contaId:x.conta_id,medicoId:x.medico_id,nome:x.nome,
    tentativas: x.item?.tentativas ?? undefined,
    pesquisa:leituraPesquisaEstado({[x.medico_id]:x.item})[x.medico_id]!}:null;
}
export async function marcarAvisoPesquisa(pool:Banco,p:PesquisaNotificar,aceito:boolean):Promise<boolean>{
  const proximo=p.pesquisa.razao==='ENCONTRADO'||p.pesquisa.razao==='MANUAL_INFORMADO'
    ?'aguardando_confirmacao':'inconclusiva';
  return atualizarPesquisa(pool,p,'notificando',{estado:
    p.pesquisa.razao==='LIMITE_TENTATIVAS'?'manual_pendente':aceito?proximo:'inconclusiva',
    envio:aceito?'aceito_api':'incerto'});
}
export function descreverPesquisaPublica(p:PesquisaNotificar):string{
  const fonte='Pesquisa pública de CRM/RQE (sugestão, não validação oficial).';
  if(p.pesquisa.razao==='LIMITE_TENTATIVAS')
    return 'Não consegui obter CRM/RQE confiáveis nas '+MAX_TENTATIVAS_REGISTRO+
      ' tentativas da pesquisa pública. Isso não significa que o registro não exista. Posso enviar uma página segura para você preencher os dados, se quiser.';
  if(p.pesquisa.razao==='MANUAL_INFORMADO'){
    const proposta=p.pesquisa.proposta;
    return proposta?'Recebi pelo cofre o CRM '+proposta.crm+
      (proposta.rqe?', RQE '+proposta.rqe:'')+
      ' de '+p.nome+'. Confirma esses números? Ainda não salvei no cadastro profissional.':
      'O preenchimento seguro ainda não trouxe uma proposta válida. Nada foi gravado.';
  }
  if(p.pesquisa.razao==='FONTE_INDISPONIVEL')return 'Confirmei o vínculo de '+p.nome+'. A consulta pública de registros está indisponível agora; não significa que o CRM ou o RQE não existam.';
  if(p.pesquisa.razao==='SEM_RESULTADO'||p.pesquisa.razao==='EVIDENCIA_INCOMPLETA')
    return 'Confirmei o vínculo de '+p.nome+'. A pesquisa pública não trouxe identificação suficiente para sugerir um CRM ou RQE. Não significa que não existam.';
  const itens=p.pesquisa.candidatos??[];
  if(!itens.length)return 'A pesquisa pública terminou sem registros suficientes para uma sugestão segura.';
  if(itens.length>1)return fonte+' Encontrei informações conflitantes para '+p.nome+'. Não há um CRM único confirmado. Ainda não salvei dados.';
  const item=itens[0]!;
  const rqe=item.rqes.length===1?'RQE '+item.rqes[0]:
    item.rqes.length>1?'RQEs possíveis '+item.rqes.join(', '):
    'não encontrei RQE comprovado nos resultados consultados';
  return fonte+' Para '+p.nome+', encontrei CRM '+item.crm+'; '+rqe+'. Esses dados estão corretos? Ainda não salvei o registro.';
}
export async function destinatarioPesquisaAutorizado(
  pool:Banco,contaId:string,telefone:string,medicoId:string,nome:string
):Promise<boolean>{
  const variantes=[telefone,telefone.replace(/^55/,'')];
  const r=await pool.query([
    'select 1 from public.usuarios u',
    'join public.medicos m on m.conta_id=u.conta_id',
    'and m.id=$3::uuid and m.nome_completo=$4',
    'where u.conta_id=$1 and u.ativo=true and u.auth_user_id is not null',
    "and regexp_replace(u.telefone,'[^0-9]','','g')=any($2::text[]) limit 1"
  ].join('\n'),[contaId,variantes,medicoId,nome]);
  return r.rows.length===1;
}

/** Notifica uma única vez e registra aceite da API sem presumir entrega. */
export async function notificarPesquisaRegistro(
  pool:Banco,telefone:string,enviar:(telefone:string,texto:string)=>Promise<boolean>
):Promise<boolean>{
  const tarefa=await reservarAvisoPesquisa(pool);
  if(!tarefa)return false;
  let aceito=false;
  try{
    if(await destinatarioPesquisaAutorizado(pool,tarefa.contaId,telefone,tarefa.medicoId,tarefa.nome))
      aceito=await enviar(telefone,descreverPesquisaPublica(tarefa));
  }catch{aceito=false;}
  finally{await marcarAvisoPesquisa(pool,tarefa,aceito);}
  return true;
}
export async function proporCorrecaoPesquisa(
  pool:Banco,contaId:string,medicoId:string,campos:{crm:string;rqe?:string}
):Promise<boolean>{
  const crm=normalizarCrm(campos.crm);
  if(!crm||!crm.includes('/')||(campos.rqe&&!rqeValido(campos.rqe)))return false;
  const sql=[
    'update public.noto_agent_conversas c set',
    "estado=jsonb_set(c.estado,array['pesquisasRegistro',$2],",
    "c.estado#>array['pesquisasRegistro',$2]||",
    "jsonb_build_object('proposta',$3::jsonb),false),atualizado_em=now()",
    'where c.conta_id=$1',
    "and c.estado#>>array['pesquisasRegistro',$2,'estado']='aguardando_confirmacao'",
    'and exists(select 1 from public.medicos m where m.id=$2::uuid and m.conta_id=$1)',
    'returning conta_id'
  ].join('\n');
  const proposta={crm,...(campos.rqe?{rqe:campos.rqe}:{}),origem:'correcao'};
  const r=await pool.query(sql,[contaId,medicoId,JSON.stringify(proposta)]);
  return r.rows.length===1;
}
export async function concluirRevisaoPesquisa(
  pool:Banco,contaId:string,medicoId:string
):Promise<boolean>{
  const r=await pool.query([
    'update public.noto_agent_conversas c set',
    "estado=jsonb_set(c.estado,array['pesquisasRegistro',$2,'estado'],",
    "'\"confirmada\"'::jsonb,false),atualizado_em=now()",
    'where c.conta_id=$1',
    "and c.estado#>>array['pesquisasRegistro',$2,'estado']='aguardando_confirmacao'",
    'and exists(select 1 from public.medicos m where m.id=$2::uuid and m.conta_id=$1)',
    'returning conta_id'
  ].join('\n'),[contaId,medicoId]);
  return r.rows.length===1;
}

/** A aprovação é única, transacional e revalidada com o registro guardado.
 * Jamais recebe números do modelo: somente a proposta apresentada ao médico.
 * Não requer RQE; se houver mais de um RQE, salva apenas o CRM.
 */
export async function aprovarRegistroProfissional(
  pool:pg.Pool,contaId:string,medicoId:string
):Promise<{ok:true;nome:string;crm:string;rqe:string|null}|{ok:false;motivo:string}>{
  const client=await pool.connect();
  let commit=false;
  try{
    await client.query('begin');
    const r=await client.query(
      'select estado from public.noto_agent_conversas where conta_id=$1 for update',
      [contaId]);
    const registro=leituraPesquisaEstado(r.rows[0]?.estado?.pesquisasRegistro)[medicoId];
    if(registro?.estado!=='aguardando_confirmacao')
      return {ok:false,motivo:'PROPOSTA_NAO_PENDENTE'};
    const candidatos=registro.candidatos??[];
    const proposta=registro.proposta;
    if(!proposta && (registro.razao!=='ENCONTRADO'||candidatos.length!==1))
      return {ok:false,motivo:'REGISTRO_AMBIGUO'};
    const escolhido=proposta??candidatos[0]!;
    const crm=normalizarCrm(escolhido.crm);
    if(!crm?.includes('/'))return {ok:false,motivo:'CRM_NAO_COMPROVADO'};
    const listaRqe='rqes' in escolhido?escolhido.rqes:[...((escolhido.rqe)?[escolhido.rqe]:[])];
    const rqe=listaRqe.length===1?listaRqe[0]!:null;
    const medico=(await client.query([
      'select id,nome_completo from public.medicos',
      'where id=$1::uuid and conta_id=$2 for update'
    ].join('\n'),[medicoId,contaId])).rows[0];
    if(!medico||medico.nome_completo!==registro.nome)
      return {ok:false,motivo:'PROFISSIONAL_ALTERADO'};
    const salvo=await client.query([
      'update public.medicos set crm=$3,',
      'rqe=case when $4::boolean then $5 else rqe end,',
      'atualizado_em=now()',
      'where id=$1::uuid and conta_id=$2 returning nome_completo,crm,rqe'
    ].join('\n'),[medicoId,contaId,crm,rqe!==null,rqe]);
    if(salvo.rows.length!==1)return {ok:false,motivo:'CADASTRO_NAO_GRAVADO'};
    await client.query([
      'update public.noto_agent_conversas c set',
      "estado=jsonb_set(c.estado,array['pesquisasRegistro',$2::text,'estado'],",
      "'\"confirmada\"'::jsonb,false),atualizado_em=now()",
      'where c.conta_id=$1'
    ].join('\n'),[contaId,medicoId]);
    await client.query('commit');commit=true;
    return {ok:true,nome:salvo.rows[0].nome_completo,crm:salvo.rows[0].crm,
      rqe:salvo.rows[0].rqe??null};
  }catch{return {ok:false,motivo:'GRAVACAO_INDISPONIVEL'};}
  finally{if(!commit)await client.query('rollback').catch(()=>undefined);client.release();}
}

/** Falhas de processo não repetem busca paga nem reenviam mensagem incerta. */
export async function recuperarPesquisaInterrompida(pool:Banco):Promise<void>{
  // O marcador de tentativa já foi consumido antes de chamar o provedor.
  // NUNCA reexecutar a mesma tentativa após reinício.
  const sql=[
    'with antigas as (select c.conta_id,p.key as medico_id,p.value as item',
    'from public.noto_agent_conversas c',
    "cross join lateral jsonb_each(coalesce(c.estado->'pesquisasRegistro','{}'::jsonb)) p",
    "where (p.value->>'estado'='executando' and",
    "coalesce((p.value->>'reservadoEm')::timestamptz,'-infinity'::timestamptz)<now()-interval '4 minutes')",
    "or (p.value->>'estado'='notificando' and",
    "coalesce((p.value->>'reservadoEm')::timestamptz,'-infinity'::timestamptz)<now()-interval '8 minutes')",
    'for update of c skip locked)',
    'update public.noto_agent_conversas c',
    "set estado=jsonb_set(c.estado,array['pesquisasRegistro',antigas.medico_id],",
    "antigas.item||case when antigas.item->>'estado'='notificando'",
    // Um aviso pode ter sido aceito: manter incerteza, não reenviar.
    "then jsonb_build_object('estado',case when antigas.item->>'razao'='LIMITE_TENTATIVAS'",
    "then 'manual_pendente' else 'inconclusiva' end,'envio','incerto')",
    "when coalesce((antigas.item->>'tentativas')::int,0)>=$1",
    "then jsonb_build_object('estado','resultado_pronto','razao','LIMITE_TENTATIVAS','candidatos','[]'::jsonb)",
    "else jsonb_build_object('estado','pendente',",
    "'proximaTentativaEm',(now()+interval '15 minutes')::text) end,false),",
    'atualizado_em=now() from antigas where c.conta_id=antigas.conta_id'
  ].join('\n');
  await pool.query(sql,[MAX_TENTATIVAS_REGISTRO]);
}
