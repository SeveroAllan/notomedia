import {referenciaDiagnostica} from '../agente/diagnostico.js';
import {gerarVariantesTelefoneBrasileiro} from './variantes-telefone-brasileiro.js';
import {interpretarEstadoEvolutionComDiagnostico} from './status-entrega-link.js';

export interface MarcoSaidaWhatsapp {
  mensagemRef?:string;
  estado:'ACEITO_API'|'ACEITO_SEM_ID'|'NAO_ACEITO'|
    'PENDING'|'SERVER_ACK'|'DELIVERY_ACK'|'READ'|'ERROR';
}
/** Não guarda corpo da mensagem, telefone, ID real nem URL. */
function ref(segredo:string,instancia:string,id:string):string{
  return referenciaDiagnostica(segredo,'mensagem',[instancia,id]);
}
/** Aceite HTTP não é DELIVERY_ACK. Sem key.id, não há como correlacionar. */
export function diagnosticarAceiteSaida(
  segredo:string,instancia:string,
  resposta:{sucesso:boolean;mensagemId?:string}
):MarcoSaidaWhatsapp{
  if(!resposta.sucesso)return {estado:'NAO_ACEITO'};
  const id=resposta.mensagemId;
  if(!segredo||!instancia||typeof id!=='string'||!/^[A-Za-z0-9_-]{5,150}$/.test(id))
    return {estado:'ACEITO_SEM_ID'};
  return {estado:'ACEITO_API',mensagemRef:ref(segredo,instancia,id)};
}
/** Recibos são telemetria de entrega, não gatilho de ação ou reenvio.
 * Só correlacionar instância correta, fromMe=true e destinatário autorizado.
 */
export function diagnosticarReciboSaida(
  segredo:string,instancia:string,telefonePermitido:string,evento:unknown
):MarcoSaidaWhatsapp|null{
  if(!segredo||!instancia)return null;
  const r=interpretarEstadoEvolutionComDiagnostico(evento);
  if(!r.ok||r.evento.instancia!==instancia)return null;
  const permitidos=gerarVariantesTelefoneBrasileiro(telefonePermitido);
  if(permitidos.length===0||!r.evento.destinatarios.some(n=>
    gerarVariantesTelefoneBrasileiro(n).some(v=>permitidos.includes(v))))return null;
  return {
    estado:r.evento.estado,mensagemRef:ref(segredo,instancia,r.evento.mensagemId)
  };
}
