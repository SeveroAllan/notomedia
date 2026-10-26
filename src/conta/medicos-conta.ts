import type pg from 'pg';
import { nomeProfissionalValido } from './validar-dados-emissao.js';

export interface MedicoConta {
  id: string;
  nomeCompleto: string;
  crm: string | null;
  certificadoValido: boolean;
}

export const normalizarNomeMedico = (texto: string) => texto
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('pt-BR')
  .replace(/\b(?:dr|dra|doutor|doutora)\.?\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export async function listarMedicosDaConta(pool: pg.Pool, medicoId: string): Promise<MedicoConta[]> {
  const { rows } = await pool.query(`
    select m.id, m.nome_completo, m.crm,
      exists(
        select 1 from medico_certificados c
        where c.medico_id=m.id and c.status='ativo'
          and (c.valido_ate is null or c.valido_ate >= current_date)
      ) as certificado_valido
    from medicos m
    where m.conta_id=(select conta_id from medicos where id=$1)
    order by m.nome_completo, m.id
  `, [medicoId]);
  return rows.map(r=>({
    id:r.id,
    nomeCompleto:String(r.nome_completo??'').trim(),
    crm:r.crm??null,
    certificadoValido:Boolean(r.certificado_valido)
  })).filter(m=>m.nomeCompleto);
}

export function resolverNomesParaConfiguracao(
  informados:readonly string[],
  existentes:readonly string[],
  descobertos:readonly string[],
  textoAtual:string
):{ok:true;nomes:string[]}|{ok:false;motivo:'MEDICO_NAO_IDENTIFICADO'|'MEDICO_AMBIGUO';nome:string}{
  const permitidos=[...existentes,...descobertos];
  const texto=normalizarNomeMedico(textoAtual);
  const nomes:string[]=[];
  for(const informado of informados){
    const chave=normalizarNomeMedico(informado);
    const candidatos=[...new Map(permitidos.filter(n=>normalizarNomeMedico(n)===chave).map(n=>[normalizarNomeMedico(n),n])).values()];
    if(candidatos.length>1)return {ok:false,motivo:'MEDICO_AMBIGUO',nome:informado};
    const canonico=candidatos[0]??(nomeProfissionalValido(informado)&&!!chave&&texto.includes(chave)?informado.trim():null);
    if(!canonico)return {ok:false,motivo:'MEDICO_NAO_IDENTIFICADO',nome:informado};
    if(!nomes.some(n=>normalizarNomeMedico(n)===normalizarNomeMedico(canonico)))nomes.push(canonico);
  }
  return {ok:true,nomes};
}

export async function medicoPertenceAContaDoUsuario(pool: pg.Pool, medicoId: string, authUserId: string): Promise<boolean> {
  const { rows } = await pool.query(`
    select 1
    from usuarios u
    join medicos m on m.conta_id=u.conta_id
    where u.auth_user_id=$2 and u.ativo=true and m.id=$1
    limit 1
  `, [medicoId,authUserId]);
  return rows.length===1;
}

export function resolverMedicosPorNomes(
  nomes: readonly string[],
  medicos: readonly MedicoConta[]
): { ok:true; medicos:MedicoConta[] } | { ok:false; motivo:'MEDICO_NAO_IDENTIFICADO'|'MEDICO_AMBIGUO'; nome:string } {
  const saida:MedicoConta[]=[];
  for(const informado of nomes) {
    const alvo=normalizarNomeMedico(informado);
    const exatos=medicos.filter(m=>normalizarNomeMedico(m.nomeCompleto)===alvo);
    if(exatos.length===0)return {ok:false,motivo:'MEDICO_NAO_IDENTIFICADO',nome:informado};
    if(exatos.length>1)return {ok:false,motivo:'MEDICO_AMBIGUO',nome:informado};
    if(!saida.some(m=>m.id===exatos[0]!.id))saida.push(exatos[0]!);
  }
  return {ok:true,medicos:saida};
}

export function linkCertificadoMedico(origem: string, medicoId: string): string {
  const url=new URL(origem);
  url.pathname='/';
  url.search='';
  url.hash='';
  url.searchParams.set('medicoId',medicoId);
  url.searchParams.set('etapa','certificado');
  return url.toString();
}

export async function confirmarMedicosDaConta(
  pool: pg.Pool,
  medicoBaseId: string,
  nomes: readonly string[]
): Promise<{ok:true;medicos:MedicoConta[]}|{ok:false;motivo:'MEDICO_NAO_IDENTIFICADO'|'MEDICO_AMBIGUO';nome:string}> {
  const client=await pool.connect();
  try {
    await client.query('begin');
    const base=(await client.query('select conta_id from medicos where id=$1 for share',[medicoBaseId])).rows[0];
    if(!base){await client.query('rollback');return {ok:false,motivo:'MEDICO_NAO_IDENTIFICADO',nome:nomes[0]??''};}
    const resultado:MedicoConta[]=[];
    for(const informado of nomes) {
      const nome=informado.trim();
      if(!nome){await client.query('rollback');return {ok:false,motivo:'MEDICO_NAO_IDENTIFICADO',nome:informado};}
      const chave=normalizarNomeMedico(nome);
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`medico_conta:${base.conta_id}:${chave}`]);
      const {rows}=await client.query(`
        select m.id,m.nome_completo,m.crm,
          exists(select 1 from medico_certificados c where c.medico_id=m.id and c.status='ativo'
            and (c.valido_ate is null or c.valido_ate>=current_date)) as certificado_valido
        from medicos m where m.conta_id=$1 order by m.nome_completo,m.id
      `,[base.conta_id]);
      const correspondentes=rows.filter(m=>normalizarNomeMedico(String(m.nome_completo??''))===chave);
      if(correspondentes.length>1){await client.query('rollback');return {ok:false,motivo:'MEDICO_AMBIGUO',nome};}
      let linha=correspondentes[0];
      if(!linha){
        linha=(await client.query(`
          insert into medicos (usuario_id,conta_id,nome_completo)
          values (null,$1,$2)
          returning id,nome_completo,crm,false as certificado_valido
        `,[base.conta_id,nome])).rows[0];
      }
      resultado.push({id:linha.id,nomeCompleto:linha.nome_completo,crm:linha.crm??null,certificadoValido:Boolean(linha.certificado_valido)});
    }
    await client.query('commit');
    return {ok:true,medicos:resultado};
  } catch(e) {
    await client.query('rollback').catch(()=>undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Resolve o nome canônico de um profissional que apareceu na descoberta da agenda
 * registrada nesta conversa (contexto:profissionais_agenda). Fail-closed: fonte
 * diferente, nome ausente da lista ou contexto inválido não confirmam o profissional.
 */
export function nomeProfissionalDescobertoNaConversa(
  contextos:readonly unknown[],
  agenda:'tribemd'|'amplimed',
  nomeInformado:string
):string|undefined{
  const alvo=normalizarNomeMedico(nomeInformado);
  if(!alvo)return undefined;
  for(const contexto of contextos){
    try{
      const parsed=typeof contexto==='string'?JSON.parse(contexto):contexto;
      if(parsed?.fonte===agenda&&Array.isArray(parsed?.profissionais)){
        const hit=parsed.profissionais.find((n:unknown)=>typeof n==='string'&&normalizarNomeMedico(n)===alvo);
        if(typeof hit==='string'&&hit)return hit;
      }
    }catch{/* contexto inválido não confirma profissional */}
  }
  return undefined;
}

/** Retoma apenas a configuração explícita observada na mesma conversa e conta.
 * O alvo sem perfil fiscal não vira origem operacional antes do vínculo.
 * Não resolve emissão, não herda certificado, perfil fiscal ou autorização.
 */
export async function origemConfiguracaoAgendaNaConversa(
  pool:pg.Pool, alvoId:string, conversa:string, texto:string
):Promise<string>{
  const atual=normalizarNomeMedico(texto);
  if(!/\b(?:associar|vincular|configurar)\b/.test(atual))return alvoId;
  const agendas=(['tribemd','amplimed'] as const).filter(a=>atual.includes(a));
  if(agendas.length!==1)return alvoId;
  const {rows}=await pool.query(`
    select cm.medico_id,cm.texto,alvo.nome_completo
    from medicos alvo
    join medicos fonte on fonte.conta_id=alvo.conta_id
    join medico_perfil_fiscal pf on pf.medico_id=fonte.id and pf.ambiente='homologacao'
    join conversa_mensagens cm on cm.medico_id=fonte.id and cm.conversa=$2
      and cm.mensagem_id like 'contexto:profissionais_agenda:%'
    where alvo.id=$1 and not exists(select 1 from medico_perfil_fiscal p where p.medico_id=alvo.id)
    order by cm.id desc limit 12
  `,[alvoId,conversa]);
  const origens=new Set<string>();
  for(const row of rows){
    const nome=String(row.nome_completo??'');
    if(!nome||!atual.includes(normalizarNomeMedico(nome)))continue;
    if(nomeProfissionalDescobertoNaConversa([row.texto],agendas[0]!,nome))origens.add(row.medico_id);
  }
  return origens.size===1?[...origens][0]!:alvoId;
}
