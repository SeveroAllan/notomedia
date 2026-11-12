/**
 * A1 salvo é evento de produto, não autorização de emissão.
 * Notificação idempotente ao operador autenticado da mesma conta.
 * Não cria tarefas de emissão nem expõe certificado, senha ou titular.
 */
import {createHash} from 'node:crypto';
import type pg from 'pg';
import {gerarVariantesTelefoneBrasileiro} from '../whatsapp/variantes-telefone-brasileiro.js';
import {reservarMensagemConversa,finalizarMensagemConversa} from './estado-conversa.js';
import type {EventoTrabalhoVerificado} from './continuar-evento.js';

type Banco=Pick<pg.Pool,'query'>;
export interface EstadoFiscalCertificado {
  certificadoValido:boolean;
  profissionalConfirmado:boolean;
  perfilFiscalConfirmado:boolean;
}
export interface DependenciasCertificadoEvento {
  pool:Banco;
  operadorTeste:string;
  instanciaAssistente:string;
  consultarEstado:(medicoId:string)=>Promise<EstadoFiscalCertificado>;
  enviar:(telefone:string,relato:string)=>Promise<boolean>;
  continuarEvento?:(evento:EventoTrabalhoVerificado)=>Promise<string|null>;
}
export function descreverCertificadoVerificado(estado:EstadoFiscalCertificado):string{
  const certificado=estado.certificadoValido
    ? 'O certificado A1 foi recebido e está válido.'
    : 'O certificado A1 foi recebido, mas a validade ainda não está confirmada.';
  const profissional=estado.profissionalConfirmado
    ? 'Os dados profissionais já foram confirmados.'
    : 'A confirmação dos dados profissionais ainda está pendente.';
  const fiscal=estado.perfilFiscalConfirmado
    ? 'O perfil fiscal está confirmado.'
    : 'Os parâmetros do perfil fiscal ainda precisam ser conferidos e confirmados.';
  return [certificado,profissional,fiscal,
    'Não emiti nenhuma nota. Vou seguir somente com as próximas verificações autorizadas.'].join(' ');
}

export async function notificarCertificadoRecebido(
  medicoId:string,certificadoId:string,deps:DependenciasCertificadoEvento
):Promise<'enviado'|'ignorado'|'incerto'>{
  if(!/^[0-9a-f-]{36}$/i.test(medicoId)||!/^[0-9a-f-]{36}$/i.test(certificadoId)||
    !deps.instanciaAssistente||!deps.operadorTeste)return 'ignorado';
  const variantes=gerarVariantesTelefoneBrasileiro(deps.operadorTeste);
  const telefone=variantes.find(v=>/^55\d{10,11}$/.test(v));
  if(!telefone)return 'ignorado';
  const conta=await deps.pool.query([
    'select distinct m.conta_id from public.medicos m',
    'join public.usuarios u on u.conta_id=m.conta_id',
    'where m.id=$1::uuid and u.ativo=true and u.auth_user_id is not null',
    "and regexp_replace(u.telefone,'[^0-9]','','g')=any($2::text[])",
    'limit 2'
  ].join(' '),[medicoId,variantes]);
  if(conta.rows.length!==1)return 'ignorado';
  const contaId=conta.rows[0].conta_id as string;
  const chave='certificado-'+createHash('sha256').update(certificadoId).digest('hex').slice(0,32);
  if(!await reservarMensagemConversa(deps.pool,contaId,deps.instanciaAssistente,chave))return 'ignorado';
  let aceito=false;
  try{
    const estado=await deps.consultarEstado(medicoId);
    const comprovado=descreverCertificadoVerificado(estado);
    let aviso=comprovado;
    if(deps.continuarEvento){
      try{
        const fala=await deps.continuarEvento({tipo:'certificado_salvo',contaId,textoComprovado:comprovado});
        if(fala)aviso=fala;
      }catch{/* Falha de IA não apaga o comprovante. */}
    }
    aceito=await deps.enviar(telefone,aviso);
    return aceito?'enviado':'incerto';
  }catch{
    return 'incerto';
  }finally{
    await finalizarMensagemConversa(deps.pool,contaId,deps.instanciaAssistente,chave,aceito);
  }
}
