import type pg from 'pg';

export interface MedicoConta {
  id: string;
  nomeCompleto: string;
  crm: string | null;
  certificadoValido: boolean;
}

const normalizar = (texto: string) => texto
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
    const alvo=normalizar(informado);
    const exatos=medicos.filter(m=>normalizar(m.nomeCompleto)===alvo);
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
