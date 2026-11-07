import { normalizarNomeMedico } from '../conta/medicos-conta.js';
import type { EstadoConversa, AgendaEscolhida } from './estado-conversa.js';

export type DecisaoVinculo = 'confirmar'|'negar'|'corrigir'|'esclarecer';
export type ResultadoDecisaoVinculo =
  | {ok:true;nomes:string[];agenda:AgendaEscolhida}
  | {ok:false;motivo:'SEM_DESCOBERTA'|'OUTRA_AGENDA'|'ALVO_AMBIGUO'|'NOME_NAO_COMPROVADO'|'NAO_AUTORIZOU'|'ESCLARECIMENTO'};

/** A descoberta autenticada permite antecipar o vínculo de um único alvo.
 * A decisão contextual pode vetar o vínculo e nunca resolve ambiguidade sozinha. */
export function decidirVinculo(
  estado:EstadoConversa|undefined,
  entrada:{agenda:AgendaEscolhida;decisao:DecisaoVinculo;nomes:string[];mensagem:string}
):ResultadoDecisaoVinculo{
  const descoberta=estado?.descoberta;
  if (!descoberta || estado?.faseAgenda!=='CONFIRMACAO_PENDENTE')
    return {ok:false,motivo:'SEM_DESCOBERTA'};
  if (descoberta.agenda!==entrada.agenda ||
      (estado.agendaEscolhida && estado.agendaEscolhida!==entrada.agenda))
    return {ok:false,motivo:'OUTRA_AGENDA'};
  if (entrada.decisao==='negar') return {ok:false,motivo:'NAO_AUTORIZOU'};
  if (entrada.decisao!=='confirmar') return {ok:false,motivo:'ESCLARECIMENTO'};
  const disponiveis=descoberta.nomes.filter(n=>!!normalizarNomeMedico(n));
  if (!disponiveis.length ||
      new Set(disponiveis.map(normalizarNomeMedico)).size!==disponiveis.length)
    return {ok:false,motivo:'ALVO_AMBIGUO'};
  const propostos=entrada.nomes.length?entrada.nomes:
    disponiveis.length===1?[disponiveis[0]!]:[];
  if(!propostos.length||propostos.length>disponiveis.length ||
     new Set(propostos.map(normalizarNomeMedico)).size!==propostos.length)
    return {ok:false,motivo:'ALVO_AMBIGUO'};
  const confirmados=propostos.map(p=>
    disponiveis.filter(d=>normalizarNomeMedico(d)===normalizarNomeMedico(p)));
  if(confirmados.some(c=>c.length!==1))return {ok:false,motivo:'NOME_NAO_COMPROVADO'};

  // Com múltiplos médicos, "sim, sou eu" não escolhe Alice ou Bruno.
  // O nome precisa estar explicitamente identificável na mensagem atual.
  if(disponiveis.length>1 && confirmados.some(c=>{
    const alvo=normalizarNomeMedico(c[0]!);
    const mensagem=normalizarNomeMedico(entrada.mensagem);
    if(mensagem.includes(alvo))return false;
    const tokens=alvo.split(' ').filter(x=>x.length>=4);
    return !tokens.some(t=>mensagem.split(' ').includes(t) &&
      disponiveis.filter(n=>normalizarNomeMedico(n).split(' ').includes(t)).length===1);
  }))return {ok:false,motivo:'ALVO_AMBIGUO'};
  const mensagem = normalizarNomeMedico(entrada.mensagem);
  const alvo = confirmados.length === 1 ? normalizarNomeMedico(confirmados[0]![0]!) : '';
  const pedido = /^(?:(?:sim )?(?:confirmo|autorizo|quero|pode) )?vincul(?:a|ar|e) (?:a |o )?(.+?)(?: a (?:minha|sua) conta| a conta)?$/.exec(mensagem);
  const pedidoNomeado = alvo && pedido &&
    (pedido[1] === alvo || pedido[1] === alvo.replace(/^(?:dra|dr) /, ''));
  const contraponto = /\b(?:nao|nem|talvez|duvida|incerteza|errad[oa]|outro (?:medico|profissional)|outra (?:medica|profissional))\b/.test(mensagem);
  if (entrada.mensagem.includes('?') || contraponto || (disponiveis.length > 1 && !pedidoNomeado))
    return {ok:false,motivo:'ESCLARECIMENTO'};
  return {ok:true,nomes:confirmados.map(c=>c[0]!),agenda:entrada.agenda};
}

export function explicarVinculoNaoExecutado(motivo:ResultadoDecisaoVinculo extends never?never:string):string {
  if(motivo==='NAO_AUTORIZOU')return 'Certo, não vinculei esse profissional. Posso continuar quando você decidir.';
  if(motivo==='OUTRA_AGENDA')return 'O profissional que você mencionou não pertence à descoberta desta agenda. Qual agenda quer confirmar?';
  if(motivo==='NOME_NAO_COMPROVADO'||motivo==='SEM_DESCOBERTA')
    return 'Ainda não tenho uma descoberta comprovada desse profissional para vinculá-lo à conta. Não fiz cadastro nem consultei CRM ou RQE.';
  if(motivo==='ALVO_AMBIGUO')
    return 'Preciso saber qual dos profissionais encontrados você quer vincular. Não fiz nenhum vínculo nem pesquisa.';
  return 'Entendi. Ainda não vinculei ninguém; me diga qual profissional você está confirmando.';
}
