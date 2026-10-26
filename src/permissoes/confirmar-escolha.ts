import type pg from 'pg';
import { ROTULOS } from './permissoes.js';

export type EscolhaPermissaoSalva={permissao:string;valor:string;medicoId:string;linkId:string};
export async function confirmarEscolhaPermissao(
  r:EscolhaPermissaoSalva,
  deps:{pool:Pick<pg.Pool,'query'>;confirmar:(entrada:{medicoId:string;chave:string;fala:string[]})=>Promise<unknown>}
):Promise<void>{
  const rotulo=ROTULOS[r.permissao as keyof typeof ROTULOS];
  if(!r.medicoId||!rotulo)return;
  const textoBotao=(rotulo.botoes as Record<string,string>)[r.valor];
  if(!textoBotao)return;
  if(r.permissao==='solicitar_cpf')await deps.pool.query(
    `update medicos m set solicitar_cpf_direto_paciente=$2, atualizado_em=now()
     from noto_whatsapps_medicos wm join noto_whatsapps_conectados c on c.id=wm.whatsapp_conectado_id
     where wm.medico_id=m.id and c.id=(select wm2.whatsapp_conectado_id from noto_whatsapps_medicos wm2 where wm2.medico_id=$1)`,
    [r.medicoId,r.valor==='paciente']
  ).catch(()=>{});
  await deps.confirmar({
    medicoId:r.medicoId,
    chave:`permissao_escolhida:${r.linkId}`,
    fala:[`Escolha salva: ${rotulo.titulo.toLowerCase()} - ${textoBotao}. Essa foi exatamente a opção escolhida na página. Isso só salva sua preferência. Não emite nem envia notas antigas. Se quiser mudar depois, é só me pedir.`]
  });
}
