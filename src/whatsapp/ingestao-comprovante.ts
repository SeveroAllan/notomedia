/**
 * Entrada de mídia de pacientes na instância pareada, isolada do webhook
 * do operador. Em piloto, só números de teste explicitamente autorizados.
 *
 * Segurança: não salva mídia, remetente ou dados do paciente. Reserva só
 * (conta,instância,ID da mensagem) e marca entrega incerta sem reenvio cego.
 */
import type pg from 'pg';
import { gerarVariantesTelefoneBrasileiro } from './variantes-telefone-brasileiro.js';
import { reservarMensagemConversa,finalizarMensagemConversa } from '../agente/estado-conversa.js';
import { validarMidiaComprovante, type ClassificadorComprovante,
  type ClassificacaoMidia } from './classificar-documento.js';

type Banco=Pick<pg.Pool,'query'>;
export interface MidiaRecebida {
  instancia:string;
  mensagemId:string;
  remetente:string;
  mimetype:string;
}
export interface PossivelConsulta {
  estado:'identificada'|'ambiguo'|'indisponivel';
  dataConsulta?:string;
  profissional?:string;
}

export interface DependenciasIngestao {
  pool:Banco;
  classificador:ClassificadorComprovante;
  carregarMidia:(instancia:string,mensagemId:string)=>Promise<{base64?:string;mimetype?:string}|null>;
  informarOperador:(telefone:string,texto:string)=>Promise<boolean>;
  remetentesAutorizados:string[];
  operadorAutorizado:string;
  /** Somente leitura da agenda autenticada; jamais conclui ausência de nota. */
  consultarPossivelConsulta?:(contaId:string,medicoReferenciaId:string,
    remetente:string,classificacao:ClassificacaoMidia)=>Promise<PossivelConsulta>;
}

export function avisoComprovante(
  classificacao:ClassificacaoMidia,possivel?:PossivelConsulta|null
):string|null{
  if(classificacao.tipo==='outro'||classificacao.tipo==='ilegivel')return null;
  if(classificacao.tipo==='nota_fiscal')
    return 'Recebi um documento que parece uma nota fiscal no WhatsApp do consultório. Não vou emitir outra nota com base nisso. Preciso conferir o documento e os registros fiscais antes de qualquer ação.';
  const valor=classificacao.valorCentavos===null?'':
    ' A leitura sugere o valor de '+new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(classificacao.valorCentavos/100)+'.';
  const data=classificacao.dataPagamento?
    ' A data lida no documento é '+classificacao.dataPagamento.split('-').reverse().join('/')+'.':'';
  const consulta=possivel?.estado==='identificada' && possivel.dataConsulta &&
    /^\d{4}-\d{2}-\d{2}$/.test(possivel.dataConsulta)
    ? ' Há uma consulta que pode corresponder a esse documento, em '+
      possivel.dataConsulta.split('-').reverse().join('/')+
      (possivel.profissional?' com '+possivel.profissional:'')+'.'
    : possivel?.estado==='ambiguo'
      ? ' Há mais de uma possibilidade de atendimento; preciso que você identifique a correta.'
      : ' Ainda não consegui identificar uma consulta com segurança.';
  return 'Recebi uma imagem ou PDF com aparência de comprovante no WhatsApp do consultório.'+
    valor+data+consulta+
    ' Isso não confirma a liquidação do pagamento nem autoriza emissão. Vamos conferir antes de preparar uma proposta fiscal?';
}

export async function processarMidiaRecebida(
  evento:MidiaRecebida,deps:DependenciasIngestao
):Promise<'ignorado'|'duplicado'|'sem_revisao'|'notificado'|'incerto'>{
  const variantes=gerarVariantesTelefoneBrasileiro(evento.remetente);
  if(!/^[A-Za-z0-9_-]{5,150}$/.test(evento.mensagemId)||
    !/^medico_[a-f0-9]{12}$/i.test(evento.instancia)||
    !deps.remetentesAutorizados.some(t=>gerarVariantesTelefoneBrasileiro(t).some(v=>variantes.includes(v)))||
    !/^55\d{10,11}$/.test(deps.operadorAutorizado))return 'ignorado';
  // A identidade do emissor NÃO é inferida do médico técnico da instância.
  const instancia=await deps.pool.query([
    'select w.conta_id,w.medico_id from public.whatsapp_instancias w',
    'join public.medicos m on m.id=w.medico_id and m.conta_id=w.conta_id',
    'where w.nome_instancia=$1 and w.status=\'conectado\'',
    'and w.conectado_em is not null and w.oficial=false',
    'limit 2'
  ].join(' '),[evento.instancia]);
  if(instancia.rows.length!==1)return 'ignorado';
  const {conta_id:contaId,medico_id:medicoReferenciaId}=instancia.rows[0] as {conta_id:string;medico_id:string};
  const operador=await deps.pool.query([
    'select 1 from public.usuarios u where u.conta_id=$1 and u.ativo=true',
    'and u.auth_user_id is not null',
    'and regexp_replace(u.telefone,\'[^0-9]\',\'\',\'g\')=any($2::text[])',
    'limit 1'
  ].join(' '),[contaId,gerarVariantesTelefoneBrasileiro(deps.operadorAutorizado)]);
  if(operador.rows.length!==1)return 'ignorado';
  if(!await reservarMensagemConversa(deps.pool,contaId,evento.instancia,evento.mensagemId))
    return 'duplicado';
  let notificou=false;
  let resolvido=false;
  try{
    const original=await deps.carregarMidia(evento.instancia,evento.mensagemId);
    if(!original||(original.mimetype&&original.mimetype.split(';')[0]?.toLowerCase()!==evento.mimetype.toLowerCase()))return 'incerto';
    const midia=validarMidiaComprovante(original.mimetype??evento.mimetype,original.base64);
    if(!midia)return 'incerto';
    const classificacao=await deps.classificador.classificar(midia);
    if(!classificacao)return 'incerto';
    if(classificacao.tipo==='outro'||classificacao.tipo==='ilegivel'){
      resolvido=true;
      return 'sem_revisao';
    }
    let consulta:PossivelConsulta|undefined;
    if(classificacao.tipo==='comprovante_possivel'&&deps.consultarPossivelConsulta){
      try{
        const c=await deps.consultarPossivelConsulta(contaId,medicoReferenciaId,evento.remetente,classificacao);
        if(['identificada','ambiguo','indisponivel'].includes(c.estado))consulta=c;
      }catch{/* Falha na agenda não comprova ausência de atendimento. */}
    }
    const aviso=avisoComprovante(classificacao,consulta);
    if(!aviso)return 'incerto';
    notificou=await deps.informarOperador(deps.operadorAutorizado,aviso);
    return notificou?'notificado':'incerto';
  }catch{
    return 'incerto';
  }finally{
    // Mesmo em falha de transporte não repetir envio: a API pode ter aceitado.
    await finalizarMensagemConversa(deps.pool,contaId,evento.instancia,evento.mensagemId,resolvido||notificou);
  }
}
