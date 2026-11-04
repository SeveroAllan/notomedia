import type pg from 'pg';
import type { AgendaEscolhida } from './estado-conversa.js';
import { normalizarNomeMedico } from '../conta/medicos-conta.js';
import { lerEstadoConversa } from './estado-conversa.js';

type Banco=Pick<pg.Pool,'query'>;
export interface VinculoConfirmado {id:string;nome:string}
export type RegistroVinculoConversa =
  |{ok:true;profissional:VinculoConfirmado;restantes:string[]}
  |{ok:false;motivo:'PENDENCIA_ALTERADA'|'PROFISSIONAL_NAO_CONFIRMADO'|'ESTADO_INDISPONIVEL'};

/** Registrar imediatamente a evidência: o runner pode abortar DEPOIS que
 * a operação em medicos tiver sido concluída. O balão não decide o estado.
 * Sem pacientes, transcrições ou dados sensíveis da agenda.
 */
export async function registrarVinculoConversa(
  pool:Banco,contaId:string,agenda:AgendaEscolhida,profissional:VinculoConfirmado
):Promise<RegistroVinculoConversa>{
  try{
    const anterior=await lerEstadoConversa(pool,contaId);
    const fonte=anterior.descoberta;
    if(anterior.faseAgenda!=='CONFIRMACAO_PENDENTE'||fonte?.agenda!==agenda)
      return {ok:false,motivo:'PENDENCIA_ALTERADA'};
    const selecionado=fonte.nomes.filter(n=>normalizarNomeMedico(n)===normalizarNomeMedico(profissional.nome));
    if(selecionado.length!==1)return {ok:false,motivo:'PROFISSIONAL_NAO_CONFIRMADO'};
    const restantes=fonte.nomes.filter(n=>normalizarNomeMedico(n)!==normalizarNomeMedico(profissional.nome));
    const fase=restantes.length?'CONFIRMACAO_PENDENTE':'VINCULO_CONFIRMADO';
    const novo=JSON.stringify({agenda,nomes:restantes});
    const sql=[
      'update public.noto_agent_conversas c set',
      "estado=(c.estado-'nomeProfissionalPerguntado'-'profissionalPerguntadoId') ||",
      "jsonb_build_object('profissionalConfirmadoId',$2::text,",
      "'faseAgenda',$3::text,'perguntaPendente',null,'descoberta',$4::jsonb),",
      'atualizado_em=now()',
      'where c.conta_id=$1',
      "and c.estado->>'faseAgenda'='CONFIRMACAO_PENDENTE'",
      "and c.estado#>>'{descoberta,agenda}'=$5",
      'and exists(select 1 from public.medicos m where m.id=$2::uuid',
      'and m.conta_id=$1 and m.nome_completo=$6)',
      'returning conta_id'
    ].join('\n');
    const r=await pool.query(sql,[contaId,profissional.id,fase,novo,agenda,profissional.nome]);
    return r.rows.length===1?{ok:true,profissional,restantes}:
      {ok:false,motivo:'PENDENCIA_ALTERADA'};
  }catch{return {ok:false,motivo:'ESTADO_INDISPONIVEL'};}
}
