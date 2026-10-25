import { z } from 'zod';
import type { completarOpenAi } from '../io/nvidia/chat-client.js';
import { sanitizarTextoMedico } from './contexto-conversa-medico.js';
import type { DecisaoConversa, FatosConversa } from './conversador-medico.js';
import type { PlanoConversa } from './memoria-conversa.js';

const periodoSchema = z.object({
  inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  fim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  referencia: z.enum(['explicito','contextual','nenhum'])
}).strict();

export const interpretacaoSemanticaSchema = z.object({
  dominio: z.enum(['agenda','fiscal','documento','conexao','permissoes','conversa','outro']),
  objetivo: z.enum(['consultar','preparar','emitir','reenviar','conectar','configurar','responder','conversar','desconhecido']),
  objeto: z.enum(['consultas','pendencias_fiscais','notas','pdf','entregas','agenda','permissoes','outro']).nullable(),
  granularidade: z.enum(['colecao','item','indefinida']),
  medida: z.enum(['lista','quantidade','valor_agenda','valor_realizado','valor_recebido','valor_notas','valor_indefinido']).default('lista'),
  permissaoNecessaria: z.enum(['emitir_autonomo','entregar_paciente','solicitar_cpf']).nullable().default(null),
  agendaAlvo: z.enum(['tribemd','amplimed']).nullable().optional(),
  periodo: periodoSchema,
  paciente: z.string().trim().min(1).max(150).nullable(),
  restricoes: z.object({
    naoEmitir: z.boolean(),
    somenteLeitura: z.boolean()
  }).strict(),
  faltando: z.array(z.enum(['periodo','paciente','consulta','agenda','agenda_foco','confirmacao','permissao','dados_consulta'])).max(8),
  confianca: z.number().min(0).max(1)
}).strict();

export type InterpretacaoSemantica = Omit<z.infer<typeof interpretacaoSemanticaSchema>, 'medida'|'permissaoNecessaria'|'agendaAlvo'> & {medida?:z.infer<typeof interpretacaoSemanticaSchema>['medida'];permissaoNecessaria?:z.infer<typeof interpretacaoSemanticaSchema>['permissaoNecessaria'];agendaAlvo?:'tribemd'|'amplimed'|null};

export const PROMPT_INTERPRETACAO_SEMANTICA = `Interpret the doctor's message by meaning. Do not use keyword matching as the primary method.

ROLE
- The doctor's conversation is in Brazilian Portuguese (pt-BR).
- Read pt-BR naturally.
- Do not answer the doctor.
- Do not execute an action.
- Do not decide safety policy.
- Return only the semantic JSON object.

CONTEXT
- Use texto, mensagens, resumo, plano, fatos, and calendario.
- Resolve natural time references.
- Resolve pronouns and references from context.
- Give the current request priority over stale context.
- Do not invent a fact that is not in the input.

MEANING
- Use objeto='consultas' for general agenda consultations.
- Use objeto='pendencias_fiscais' for consultations that do not have an invoice and are pending fiscal work.
- Use objeto='entregas' when the doctor asks about PDFs or invoices that Noto sent, tried to send, resent, or delivered and fatos.entregasRecentes can answer the question.
- For objeto='entregas', do not create a need to read the agenda.
- For objeto='entregas', do not change the request into a new resend request.
- Preserve the requested measure.
- Use medida='lista' for a list.
- Use medida='quantidade' for a count.
- Do not change a financial question into a request for a consultation list.
- Keep agenda value, completed-consultation value, received money, and invoice value as different measures.
- Use medida='valor_realizado' when a short financial question continues a recent agenda consultation context and there is no evidence for payment or invoices.
- valor_realizado means the value recorded for consultations with status realizada.
- valor_realizado does not prove received money.
- valor_realizado does not prove an issued invoice.
- Use medida='valor_recebido' when the doctor asks about money that was received.
- Use medida='valor_notas' when the doctor asks about invoice values.
- Use medida='valor_agenda' when the doctor asks for values recorded in the agenda without a status restriction.
- Use medida='valor_indefinido' only when context does not make one financial measure dominant.
- Do not ask for clarification for a theoretical ambiguity when context gives a safe dominant meaning.

AGENDA CONFIGURATION
- Treat questions about adding, connecting, changing, or configuring an agenda as configuration requests. They are not claims about consultations.
- Use objetivo='configurar' or objetivo='conectar' with objeto='agenda' for these requests.
- Set agendaAlvo='tribemd' or 'amplimed' only when the doctor explicitly identifies that supported agenda.
- "outra agenda" without a supported agenda name means agendaAlvo=null. Do not guess the other agenda for a configuration request.
- A connected agenda does not prevent the doctor from connecting the other supported agenda.
- For consultation, pending, preparation, or issue requests, use agendaAlvo when the doctor names TribeMD or Amplimed.
- When both agendas are connected, agendaAlvo may be contextual only when the recent conversation clearly established one agenda as the current source.
- When both agendas are connected and no source is clear, add agenda_foco to faltando. Never choose one silently.

PERMISSIONS
- Set permissaoNecessaria only when the goal depends on a configurable choice.
- Use emitir_autonomo for autonomous issue permission.
- Use entregar_paciente for invoice delivery destination.
- Use solicitar_cpf for the source of a missing CPF.
- Do not invent a permission requirement for a read-only agenda request.

SCOPE
- Do not change a collection request into an item request.
- If the doctor asks for consultations in a period, use granularidade='colecao'.
- Do not invent a patient, date, or time.
- Add a field to faltando only when the goal cannot run without that field.
- Keep restrictions such as "sem emitir", "só conferir", and "não prepare".
- Use YYYY-MM-DD dates.
- Derive relative dates from calendario.
- The available read range ends today.
- For a current period, use today's limit from calendario.
- Do not invent agenda facts.

OUTPUT
Return strict JSON:
{
 "dominio":"agenda|fiscal|documento|conexao|permissoes|conversa|outro",
 "objetivo":"consultar|preparar|emitir|reenviar|conectar|configurar|responder|conversar|desconhecido",
 "objeto":"consultas|pendencias_fiscais|notas|pdf|entregas|agenda|permissoes|outro"|null,
 "granularidade":"colecao|item|indefinida",
 "medida":"lista|quantidade|valor_agenda|valor_realizado|valor_recebido|valor_notas|valor_indefinido",
 "permissaoNecessaria":"emitir_autonomo|entregar_paciente|solicitar_cpf"|null,
 "agendaAlvo":"tribemd|amplimed"|null,
 "periodo":{"inicio":"YYYY-MM-DD"|null,"fim":"YYYY-MM-DD"|null,"referencia":"explicito|contextual|nenhum"},
 "paciente":string|null,
 "restricoes":{"naoEmitir":boolean,"somenteLeitura":boolean},
 "faltando":[],
 "confianca":0..1
}`;


function calendarioSemantico(agora: Date) {
  const hoje=agora.toLocaleDateString('sv-SE',{timeZone:'America/Sao_Paulo'});
  const d=new Date(hoje+'T12:00:00Z');
  const segunda=new Date(d);segunda.setUTCDate(segunda.getUTCDate()-(segunda.getUTCDay()+6)%7);
  const domingo=new Date(segunda);domingo.setUTCDate(domingo.getUTCDate()+6);
  const semanaPassadaInicio=new Date(segunda);semanaPassadaInicio.setUTCDate(semanaPassadaInicio.getUTCDate()-7);
  const semanaPassadaFim=new Date(segunda);semanaPassadaFim.setUTCDate(semanaPassadaFim.getUTCDate()-1);
  const mesAtualInicio=hoje.slice(0,8)+'01';
  const mesPassadoFim=new Date(mesAtualInicio+'T12:00:00Z');mesPassadoFim.setUTCDate(0);
  const mesPassadoInicio=new Date(mesPassadoFim);mesPassadoInicio.setUTCDate(1);
  return {
    hoje,
    semanaAtual:{inicio:segunda.toISOString().slice(0,10),fimAteHoje:hoje,fimCalendario:domingo.toISOString().slice(0,10)},
    semanaPassada:{inicio:semanaPassadaInicio.toISOString().slice(0,10),fim:semanaPassadaFim.toISOString().slice(0,10)},
    mesAtual:{inicio:mesAtualInicio,fimAteHoje:hoje},
    mesPassado:{inicio:mesPassadoInicio.toISOString().slice(0,10),fim:mesPassadoFim.toISOString().slice(0,10)}
  };
}

export class InterpretadorSemantico {
  constructor(private readonly apiKey:string|undefined,private readonly modelo:string|undefined,private readonly completar:typeof completarOpenAi){}
  async interpretar(entrada:{texto:string;mensagens:readonly string[];resumo:string|null;plano?:PlanoConversa|null;fatos:FatosConversa;agora:Date}):Promise<InterpretacaoSemantica|null>{
    if(!this.apiKey?.trim()||!this.modelo?.trim())return null;
    const seguro=JSON.parse(JSON.stringify({
      texto:sanitizarTextoMedico(entrada.texto),
      mensagens:entrada.mensagens.map(sanitizarTextoMedico),
      resumo:entrada.resumo?sanitizarTextoMedico(entrada.resumo):null,
      plano:entrada.plano??null,
      fatos:entrada.fatos,
      calendario:calendarioSemantico(entrada.agora)
    }));
    try{
      const opcoes=this.modelo.startsWith('gpt-6')
        ? {formatoJson:true,reasoningEffort:'medium' as const,maxTokens:4096,tentativasMax:2 as const}
        : {formatoJson:true,temperature:.1,tentativasMax:2 as const};
      const bruto=await this.completar(this.apiKey,this.modelo,[{role:'system',content:PROMPT_INTERPRETACAO_SEMANTICA},{role:'user',content:JSON.stringify(seguro)}],opcoes);
      const r=interpretacaoSemanticaSchema.parse(JSON.parse(bruto));
      if(r.periodo.inicio&&r.periodo.fim&&r.periodo.fim<r.periodo.inicio)return null;
      return reconciliarInterpretacaoSemantica(r,entrada.fatos);
    }catch{return null;}
  }
}

function permissaoEscolhida(fatos:FatosConversa,permissao:NonNullable<InterpretacaoSemantica['permissaoNecessaria']>):boolean {
  const p=fatos.permissoes;
  if(!p)return false;
  if(permissao==='emitir_autonomo')return p.emitirAutonomo!==null;
  if(permissao==='entregar_paciente')return p.entregarPaciente!==null;
  return p.solicitarCpf!==null&&p.solicitarCpf!==undefined;
}

export function reconciliarInterpretacaoSemantica(i:InterpretacaoSemantica,fatos:FatosConversa):InterpretacaoSemantica {
  const faltando=new Set(i.faltando);
  const dependeDeConsulta=['consultar','preparar','emitir'].includes(i.objetivo)&&
    ['consultas','pendencias_fiscais','notas'].includes(i.objeto??'');
  const agendaAlvo=i.agendaAlvo??null;
  const conectadas=fatos.agendas ? (['tribemd','amplimed'] as const).filter(a=>fatos.agendas?.[a].conectada) : [];
  const alvoConectado=agendaAlvo
    ? (fatos.agendas?.[agendaAlvo]?.conectada ?? (fatos.agenda.conectada&&fatos.agenda.nome?.toLowerCase()===agendaAlvo))
    : fatos.agenda.conectada;
  if(dependeDeConsulta&&!alvoConectado){
    if(fatos.semAgendaDigital){
      faltando.delete('agenda');
      faltando.delete('agenda_foco');
      faltando.add('dados_consulta');
    }else faltando.add('agenda');
  }else if(alvoConectado)faltando.delete('agenda');
  if(dependeDeConsulta&&conectadas.length>1&&!agendaAlvo)faltando.add('agenda_foco');
  else faltando.delete('agenda_foco');

  if(i.permissaoNecessaria){
    if(permissaoEscolhida(fatos,i.permissaoNecessaria))faltando.delete('permissao');
    else faltando.add('permissao');
  }else faltando.delete('permissao');

  return {...i,faltando:[...faltando]};
}

/** Mapeia significado estruturado para capacidade; não interpreta linguagem. */
export function planejarPorSemantica(i:InterpretacaoSemantica,fatos:FatosConversa,permitidas:readonly string[]):DecisaoConversa|null{
  if(i.confianca<.8)return null;
  const permissaoNecessaria=i.permissaoNecessaria??null;
  const faltaPermissao=permissaoNecessaria!==null&&i.faltando.includes('permissao');
  const agendaAlvo=i.agendaAlvo??null;
  if((i.dominio==='agenda'||i.dominio==='conexao')&&i.objeto==='agenda'&&(i.objetivo==='configurar'||i.objetivo==='conectar')){
    if(!agendaAlvo)return null;
    const conectada=fatos.agendas?.[agendaAlvo]?.conectada ?? (fatos.agenda.conectada&&fatos.agenda.nome?.toLowerCase()===agendaAlvo);
    const nome=agendaAlvo==='amplimed'?'Amplimed':'TribeMD';
    if(conectada)return {fala:[`${nome} já está conectada. Posso usar essa agenda quando você pedir uma consulta.`],acao:null};
    if(permitidas.includes('pedir_link_agenda'))return {fala:[`Vou te mandar o link seguro para conectar a ${nome} também.`, 'Login e senha ficam apenas no link seguro. Aqui está o link seguro:'],acao:'pedir_link_agenda',parametros:{agenda:agendaAlvo}};
    return null;
  }
  if(faltaPermissao&&permissaoNecessaria&&i.dominio==='permissoes'&&permitidas.includes('pedir_link_permissoes')){
    return {fala:['Para seguir com essa escolha, vou te mandar o link seguro de configuração.'],acao:'pedir_link_permissoes',parametros:{permissao:permissaoNecessaria}};
  }
  if(i.faltando.includes('agenda')&&!fatos.semAgendaDigital&&permitidas.includes('pedir_link_agenda')){
    const alvo=i.agendaAlvo??(fatos.agenda.nome?.toLowerCase()==='amplimed'?'amplimed':fatos.agenda.nome?.toLowerCase()==='tribemd'?'tribemd':null);
    if(alvo)return {fala:['Para continuar, preciso conectar essa agenda só para leitura.','Login e senha ficam apenas no link seguro. Aqui está o link seguro:'],acao:'pedir_link_agenda',parametros:{agenda:alvo}};
  }
  if(i.faltando.includes('agenda_foco')){
    return {fala:['Você tem TribeMD e Amplimed conectadas. Qual delas quer usar neste pedido?'],acao:null};
  }
  if(faltaPermissao&&permissaoNecessaria&&permitidas.includes('pedir_link_permissoes')){
    return {fala:['Para registrar essa escolha, vou te mandar o link seguro.'],acao:'pedir_link_permissoes',parametros:{permissao:permissaoNecessaria}};
  }
  if((i.dominio==='agenda'||i.dominio==='fiscal')&&i.objetivo==='consultar'&&i.objeto==='consultas'&&i.granularidade==='colecao'){
    if(!i.periodo.inicio||i.faltando.length||!permitidas.includes('consultar_agenda'))return null;
    const alvo=i.agendaAlvo??(fatos.agenda.nome?.toLowerCase()==='amplimed'?'amplimed':fatos.agenda.nome?.toLowerCase()==='tribemd'?'tribemd':null);
    if(!alvo)return null;
    return {fala:[i.medida?.startsWith('valor_')?'Vou conferir os valores disponíveis nessa agenda nesse período.':'Vou conferir essa agenda nesse período.'],acao:'consultar_agenda',parametros:{agenda:alvo,medida:i.medida??'lista',desde:i.periodo.inicio,...(i.periodo.fim?{ate:i.periodo.fim}:{})}};
  }
  if(i.dominio==='fiscal'&&i.objeto==='pendencias_fiscais'&&i.objetivo==='consultar'){
    if(!i.periodo.inicio||i.faltando.length||!permitidas.includes('listar_pendencias'))return null;
    const alvo=i.agendaAlvo??(fatos.agenda.nome?.toLowerCase()==='amplimed'?'amplimed':fatos.agenda.nome?.toLowerCase()==='tribemd'?'tribemd':null);
    if(!alvo)return null;
    return {fala:['Vou conferir as pendências desse período nessa agenda.'],acao:'listar_pendencias',parametros:{agenda:alvo,desde:i.periodo.inicio,...(i.periodo.fim?{ate:i.periodo.fim}:{})}};
  }
  return null;
}
