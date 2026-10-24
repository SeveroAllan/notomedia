import { z } from 'zod';
import type { completarOpenAi } from '../io/nvidia/chat-client.js';
import { sanitizarTextoMedico } from './contexto-conversa-medico.js';
import type { DecisaoConversa, FatosConversa } from './conversador-medico.js';

const periodoSchema = z.object({
  inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  fim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  referencia: z.enum(['explicito','contextual','nenhum'])
}).strict();

export const interpretacaoSemanticaSchema = z.object({
  dominio: z.enum(['agenda','fiscal','documento','conexao','permissoes','conversa','outro']),
  objetivo: z.enum(['consultar','preparar','emitir','reenviar','conectar','configurar','responder','conversar','desconhecido']),
  objeto: z.enum(['consultas','pendencias_fiscais','notas','pdf','agenda','permissoes','outro']).nullable(),
  granularidade: z.enum(['colecao','item','indefinida']),
  periodo: periodoSchema,
  paciente: z.string().trim().min(1).max(150).nullable(),
  restricoes: z.object({
    naoEmitir: z.boolean(),
    somenteLeitura: z.boolean()
  }).strict(),
  faltando: z.array(z.enum(['periodo','paciente','consulta','agenda','confirmacao'])).max(5),
  confianca: z.number().min(0).max(1)
}).strict();

export type InterpretacaoSemantica = z.infer<typeof interpretacaoSemanticaSchema>;

export const PROMPT_INTERPRETACAO_SEMANTICA = `Interprete a mensagem do médico pelo significado, não por palavras-chave.
Você NÃO executa ações, NÃO responde ao médico e NÃO decide política de segurança. Produza apenas a representação semântica JSON.

Use texto, histórico, resumo, fatos e calendario para resolver referências temporais, anafóricas e contextuais naturais.
"consultas" significa agenda em geral. "pendencias_fiscais" significa consultas sem nota/pendentes para emissão.
Não transforme uma coleção em item: se o médico pede consultas de um período, granularidade=colecao e não invente paciente/data/hora ausentes.
Só marque faltando quando o objetivo realmente não puder ser executado com os dados já presentes.
Restrições como "sem emitir", "só conferir", "não prepare" devem ser preservadas.
Datas devem ser YYYY-MM-DD e derivadas do calendario fornecido. A leitura disponível vai até hoje; em períodos ainda em curso use o limite até hoje fornecido no calendario. Não invente fatos da agenda.

SAÍDA JSON estrita:
{
 "dominio":"agenda|fiscal|documento|conexao|permissoes|conversa|outro",
 "objetivo":"consultar|preparar|emitir|reenviar|conectar|configurar|responder|conversar|desconhecido",
 "objeto":"consultas|pendencias_fiscais|notas|pdf|agenda|permissoes|outro"|null,
 "granularidade":"colecao|item|indefinida",
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
  async interpretar(entrada:{texto:string;mensagens:readonly string[];resumo:string|null;fatos:FatosConversa;agora:Date}):Promise<InterpretacaoSemantica|null>{
    if(!this.apiKey?.trim()||!this.modelo?.trim())return null;
    const seguro=JSON.parse(JSON.stringify({
      texto:sanitizarTextoMedico(entrada.texto),
      mensagens:entrada.mensagens.map(sanitizarTextoMedico),
      resumo:entrada.resumo?sanitizarTextoMedico(entrada.resumo):null,
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
      return r;
    }catch{return null;}
  }
}

/** Mapeia significado estruturado para capacidade; não interpreta linguagem. */
export function planejarPorSemantica(i:InterpretacaoSemantica,fatos:FatosConversa,permitidas:readonly string[]):DecisaoConversa|null{
  if(i.confianca<.8)return null;
  if(i.dominio==='agenda'&&i.objetivo==='consultar'&&i.objeto==='consultas'&&i.granularidade==='colecao'){
    if(!fatos.agenda.conectada||!i.periodo.inicio||i.faltando.length||!permitidas.includes('consultar_agenda'))return null;
    return {fala:['Vou conferir sua agenda nesse período.'],acao:'consultar_agenda',parametros:{desde:i.periodo.inicio,...(i.periodo.fim?{ate:i.periodo.fim}:{})}};
  }
  if(i.dominio==='fiscal'&&i.objetivo==='pendencias_fiscais'&&i.objetivo==='consultar'){
    if(!fatos.agenda.conectada||!i.periodo.inicio||i.faltando.length||!permitidas.includes('listar_pendencias'))return null;
    return {fala:['Vou conferir as pendências desse período.'],acao:'listar_pendencias',parametros:{desde:i.periodo.inicio,...(i.periodo.fim?{ate:i.periodo.fim}:{})}};
  }
  return null;
}
