/**
 * Memória durável de objetivos, NÃO de autorizações.
 * Reutiliza o JSONB da conversa e a fila existente; não armazena texto livre,
 * paciente, consulta, valor, credencial, telefone ou material fiscal.
 * Uma intenção persistente jamais autoriza emissão, cancelamento ou mudança fiscal.
 */
import type pg from 'pg';
import type { PesquisaRegistroConversa } from './pesquisa-profissional-conversa.js';
import type { SituacaoTrabalhoNoto } from './trabalhos-duraveis.js';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';

export type TipoObjetivoNoto = 'concluir_cadastro'|'acompanhar_fiscal';
export type AcaoObjetivoNoto = 'acompanhar'|'pausar'|'retomar';
export type StatusObjetivoNoto = 'ativo'|'pausado';
export type OrigemObjetivoNoto = 'vinculo_confirmado'|'solicitacao_operador'|'trabalho_autorizado';

export interface ObjetivoNoto {
  tipo:TipoObjetivoNoto;
  medicoId:string;
  status:StatusObjetivoNoto;
  origem:OrigemObjetivoNoto;
  criadoEm:string;
  atualizadoEm:string;
}
export type ObjetivosNoto = Record<string,ObjetivoNoto>;

export type ProximoPassoNoto =
  'verificar_inicio_pesquisa'|'aguardar_pesquisa'|'acompanhar_envio_resultado'|
  'oferecer_link_manual'|'aguardar_preenchimento'|'pedir_confirmacao_registro'|
  'verificar_prontidao'|'esclarecer_dados'|'verificar_entrega_resultado'|
  'escolher_agenda'|'consultar_estado_conferencia'|'aguardar_conferencia'|
  'revisar_conferencia'|'nenhuma_acao';
export type DependenciaNoto =
  'pesquisa_publica'|'resultado_persistido'|'autorizacao_operador'|'formulario_seguro'|
  'confirmacao_medico'|'consulta_prontidao'|'agenda_autorizada'|'consulta_fiscal'|'nenhuma';
export interface PlanoObjetivoNoto {
  tipo:TipoObjetivoNoto;
  profissional:string;
  status:StatusObjetivoNoto;
  proximoPasso:ProximoPassoNoto;
  dependeDe:DependenciaNoto;
  /** Não confundir acompanhamento com autorização para executar atos fiscais. */
  execucaoFiscalAutorizada:false;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tipos:readonly TipoObjetivoNoto[]=['concluir_cadastro','acompanhar_fiscal'];
const origens:readonly OrigemObjetivoNoto[]=['vinculo_confirmado','solicitacao_operador','trabalho_autorizado'];
const chave=(tipo:TipoObjetivoNoto,medicoId:string)=>tipo+':'+medicoId;

/** Whitelist para estado potencialmente legado ou modificado. Nomes só do DB autorizado. */
export function lerObjetivos(valor:unknown):ObjetivosNoto{
  if(!valor||typeof valor!=='object'||Array.isArray(valor))return {};
  const saida:ObjetivosNoto={};
  for(const [id,raw] of Object.entries(valor).slice(0,50)){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))continue;
    const x=raw as Record<string,unknown>;
    if(!tipos.includes(x['tipo'] as TipoObjetivoNoto)||
       typeof x['medicoId']!=='string'||!uuid.test(x['medicoId'])||
       id!==chave(x['tipo'] as TipoObjetivoNoto,x['medicoId'])||
       !['ativo','pausado'].includes(String(x['status']))||
       !origens.includes(x['origem'] as OrigemObjetivoNoto)||
       typeof x['criadoEm']!=='string'||!Number.isFinite(Date.parse(x['criadoEm']))||
       typeof x['atualizadoEm']!=='string'||!Number.isFinite(Date.parse(x['atualizadoEm'])))
      continue;
    saida[id]={tipo:x['tipo'] as TipoObjetivoNoto,medicoId:x['medicoId'],
      status:x['status'] as StatusObjetivoNoto,origem:x['origem'] as OrigemObjetivoNoto,
      criadoEm:x['criadoEm'],atualizadoEm:x['atualizadoEm']};
  }
  return saida;
}

/** Um plano por objetivo, derivado do estado atual comprovado, não de frases. */
export function planejarObjetivos(
  objetivos:ObjetivosNoto,
  profissionais:readonly {id:string;nome:string}[],
  pesquisas:Readonly<Record<string,PesquisaRegistroConversa>> = {},
  trabalhos:readonly SituacaoTrabalhoNoto[] = [],
  agenda?:'tribemd'|'amplimed'
):PlanoObjetivoNoto[]{
  const autorizados=new Map(profissionais.map(p=>[p.id,p.nome]));
  const out:PlanoObjetivoNoto[]=[];
  for(const obj of Object.values(lerObjetivos(objetivos)).slice(0,12)){
    const nome=autorizados.get(obj.medicoId);
    if(!nome)continue;
    if(obj.status==='pausado'){
      out.push({tipo:obj.tipo,profissional:nome,status:obj.status,
        proximoPasso:'nenhuma_acao',dependeDe:'autorizacao_operador',execucaoFiscalAutorizada:false});
      continue;
    }
    let proximoPasso:ProximoPassoNoto='verificar_inicio_pesquisa';
    let dependeDe:DependenciaNoto='resultado_persistido';
    if(obj.tipo==='concluir_cadastro'){
      const p=pesquisas[obj.medicoId];
      switch(p?.estado){
        case 'pendente':case 'executando':
          proximoPasso='aguardar_pesquisa';dependeDe='pesquisa_publica';break;
        case 'resultado_pronto':case 'notificando':
          proximoPasso='acompanhar_envio_resultado';dependeDe='resultado_persistido';break;
        case 'manual_pendente':
          proximoPasso='oferecer_link_manual';dependeDe='autorizacao_operador';break;
        case 'link_manual_reservado':case 'aguardando_preenchimento':
          proximoPasso='aguardar_preenchimento';dependeDe='formulario_seguro';break;
        case 'aguardando_confirmacao':
          proximoPasso='pedir_confirmacao_registro';dependeDe='confirmacao_medico';break;
        case 'confirmada':
          proximoPasso='verificar_prontidao';dependeDe='consulta_prontidao';break;
        case 'recusada':
          proximoPasso='esclarecer_dados';dependeDe='confirmacao_medico';break;
        case 'inconclusiva':
          proximoPasso='verificar_entrega_resultado';dependeDe='resultado_persistido';break;
        default:
          proximoPasso='verificar_inicio_pesquisa';dependeDe='resultado_persistido';
      }
    }else{
      const relevant=trabalhos.filter(t=>t.tipo==='conferencia_fiscal'&&(!agenda||t.agenda===agenda));
      if(!agenda){
        proximoPasso='escolher_agenda';dependeDe='agenda_autorizada';
      }else if(relevant.some(t=>['pendente','executando','resultado_pronto','notificando'].includes(t.estado))){
        proximoPasso='aguardar_conferencia';dependeDe='consulta_fiscal';
      }else if(relevant.some(t=>t.estado==='envio_incerto')){
        proximoPasso='verificar_entrega_resultado';dependeDe='resultado_persistido';
      }else{
        proximoPasso='consultar_estado_conferencia';dependeDe='consulta_fiscal';
      }
    }
    out.push({tipo:obj.tipo,profissional:nome,status:obj.status,
      proximoPasso,dependeDe,execucaoFiscalAutorizada:false});
  }
  return out;
}

type Banco=Pick<pg.Pool,'query'>;
export type ResultadoObjetivoNoto =
  {ok:true;estado:'iniciado'|'ja_existente'|'pausado'|'retomado'}|
  {ok:false;motivo:'ALVO_INVALIDO'|'SEM_AUTORIZACAO'|'SEM_OBJETIVO'|'LIMITE_OBJETIVOS'|'PERSISTENCIA_INDISPONIVEL'};

/** Operação atômica entre réplicas: só conta e médico autorizados.
 * O evento do vínculo verificado pode criar o objetivo sem telefone; todos
 * os pedidos conversacionais devem trazer o operador ativo autenticado.
 */
export async function alterarObjetivoNoto(
  pool:Banco,contaId:string,medicoId:string,tipo:TipoObjetivoNoto,
  acao:AcaoObjetivoNoto,origem:OrigemObjetivoNoto,telefone?:string
):Promise<ResultadoObjetivoNoto>{
  if(!uuid.test(contaId)||!uuid.test(medicoId)||!tipos.includes(tipo)||
     !origens.includes(origem)||!['acompanhar','pausar','retomar'].includes(acao)||
     (origem==='solicitacao_operador'&&!telefone)||
     (!telefone&&origem!=='vinculo_confirmado'))
    return {ok:false,motivo:'ALVO_INVALIDO'};
  const variantes=telefone?gerarVariantesTelefoneBrasileiro(telefone):[];
  if(telefone&&!variantes.length)return {ok:false,motivo:'SEM_AUTORIZACAO'};
  const id=chave(tipo,medicoId);
  const agora=new Date().toISOString();
  const novo:ObjetivoNoto={tipo,medicoId,status:'ativo',origem,criadoEm:agora,atualizadoEm:agora};
  const auth=[
    'exists(select 1 from public.medicos m where m.id=$2::uuid and m.conta_id=$1)',
    'and ($5::boolean or exists(select 1 from public.usuarios u',
    'where u.conta_id=$1 and u.ativo=true and u.auth_user_id is not null',
    "and regexp_replace(u.telefone,'[^0-9]','','g')=any($6::text[])))"
  ].join('\n');
  try{
    if(acao==='acompanhar'){
      const sql=[
        'update public.noto_agent_conversas c',
        "set estado=jsonb_set(c.estado,'{objetivos}',",
        "coalesce(c.estado->'objetivos','{}'::jsonb)||jsonb_build_object($3::text,$4::jsonb),true),",
        'atualizado_em=now() where c.conta_id=$1',
        "and not (coalesce(c.estado->'objetivos','{}'::jsonb) ? $3::text)",
        "and (select count(*) from jsonb_object_keys(coalesce(c.estado->'objetivos','{}'::jsonb)))<40",
        'and '+auth,'returning conta_id'
      ].join('\n');
      const r=await pool.query(sql,[contaId,medicoId,id,JSON.stringify(novo),!telefone,variantes]);
      if(r.rows.length===1)return {ok:true,estado:'iniciado'};
      const ja=await pool.query([
        'select c.estado#>>array[\'objetivos\',$3::text,\'status\'] as status',
        'from public.noto_agent_conversas c where c.conta_id=$1',
        'and '+auth
      ].join('\n'),[contaId,medicoId,id,null,!telefone,variantes]);
      if(ja.rows[0]?.status==='ativo'||ja.rows[0]?.status==='pausado')
        return {ok:true,estado:'ja_existente'};
      return {ok:false,motivo:ja.rows.length?'LIMITE_OBJETIVOS':'SEM_AUTORIZACAO'};
    }
    const esperado=acao==='pausar'?'ativo':'pausado';
    const destino=acao==='pausar'?'pausado':'ativo';
    const sql=[
      'update public.noto_agent_conversas c set',
      "estado=jsonb_set(jsonb_set(c.estado,array['objetivos',$3::text,'status'],",
      "to_jsonb($4::text),false),array['objetivos',$3::text,'atualizadoEm'],",
      'to_jsonb($7::text),false),atualizado_em=now()',
      'where c.conta_id=$1 and '+auth,
      "and c.estado#>>array['objetivos',$3::text,'status']=$8",
      'returning conta_id'
    ].join('\n');
    const r=await pool.query(sql,[contaId,medicoId,id,destino,!telefone,variantes,agora,esperado]);
    if(r.rows.length===1)return {ok:true,estado:destino==='ativo'?'retomado':'pausado'};
    const presente=await pool.query([
      "select c.estado#>>array['objetivos',$3::text,'status'] as status",
      'from public.noto_agent_conversas c where c.conta_id=$1 and '+auth
    ].join('\n'),[contaId,medicoId,id,null,!telefone,variantes]);
    if(!presente.rows.length)return {ok:false,motivo:'SEM_AUTORIZACAO'};
    if(!presente.rows[0]?.status)return {ok:false,motivo:'SEM_OBJETIVO'};
    return {ok:true,estado:'ja_existente'};
  }catch{return {ok:false,motivo:'PERSISTENCIA_INDISPONIVEL'};}
}
