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
