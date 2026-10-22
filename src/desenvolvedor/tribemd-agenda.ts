import type { Page, Request, Response } from 'playwright-core';
import type { ObservadorRedeLoginTribemd } from './tribemd-rede.js';
import { dataISOTribemd, type ConsultaTribemd } from './tribemd-leitura.js';
const CHAVES_PROFISSIONAL=['profissional','profissionais','medico','medicos','usuario','usuarios','responsavel'] as const;
/** Só o nome do profissional, se o portal trouxer. Chaves não confirmadas: ausente vira undefined. */
export function nomeProfissionalTribemd(item:Record<string,unknown>):string|undefined{
 for(const k of CHAVES_PROFISSIONAL){
  const v=item[k];const o=Array.isArray(v)?v[0]:v;
  const nome=typeof o==='string'?o:objeto(o)&&typeof o.nome==='string'?o.nome:'';
  const limpo=nome.trim().replace(/\s+/g,' ').slice(0,120);
  if(limpo)return limpo;
 }
 return undefined;
}
/** Descoberta: nomes distintos de profissionais (sem paciente, horário ou valor). */
export function descobrirProfissionais(consultas:ReadonlyArray<{profissional?:string}>):string[]{
 const mapa=new Map<string,string>();
 for(const c of consultas){if(!c.profissional)continue;const chave=c.profissional.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();if(!mapa.has(chave))mapa.set(chave,c.profissional);}
 return [...mapa.values()].sort((a,b)=>a.localeCompare(b,'pt-BR'));
}
export class ErroAgendaTribemd extends Error { constructor(public codigo:string){super(codigo);} }
export interface RecorteAgendaTribemd {
 consultas:ConsultaTribemd[];totalAtendimentos:number;limitado:boolean;
 intervalo:{inicio:string|null;fim:string|null};
}
const objeto=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function extrairAgendaTribemd(dados:unknown,hoje:string):Omit<RecorteAgendaTribemd,'intervalo'> {
 const corpo=objeto(dados)&&objeto(dados.data)?dados.data:dados;
 if(!objeto(corpo)||!Array.isArray(corpo.atendimentos))throw new ErroAgendaTribemd('LEITURA_AGENDA_FORMATO_NAO_RECONHECIDO');
 const consultas:ConsultaTribemd[]=[];
 for(const item of corpo.atendimentos.slice(0,100)){
  if(!objeto(item))continue;
  // Valores confirmados no modelo público de atendimentos: 8=atendido; 10=finalizado.
  if(![8,10,'8','10'].includes(item.status as number|string))continue;
  const paciente=objeto(item.pacientes)?item.pacientes:undefined;
  const nome=typeof paciente?.nome==='string'?paciente.nome.trim().slice(0,200):'';
  const campo=typeof item.datahora_atendimento==='string'&&item.datahora_atendimento?'datahora_atendimento':'datahora_marcada';
  const valor=item[campo],data=typeof valor==='string'?dataISOTribemd(valor):null;
  if(!nome||!data||data>hoje)continue;
  const id=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):typeof v==='string'&&/^[1-9]\d{0,15}$/.test(v)?v:undefined;
  consultas.push({atendimentoId:id(item.id),pacienteId:id(item.paciente_id)??id(paciente?.id),situacao:Number(item.status)===10?'finalizado':'atendido',nome,ultimaConsulta:null,dataConsultaObservada:data,evidencia:'consulta_realizada_observada',origemData:campo,profissional:nomeProfissionalTribemd(item)});
 }
 return {consultas,totalAtendimentos:corpo.atendimentos.length,limitado:corpo.atendimentos.length>100};
}
interface ConsultaCarregada {request:Request;response?:Response;falhou?:boolean;resultado?:RecorteAgendaTribemd}
const limiteBytes=2*1024*1024;
/** Observa somente o GET que o próprio portal faz. Não dispara chamadas nem lê outros corpos. */
export class LeitorAgendaTribemd {
 private atual?:ConsultaCarregada;private fechado=false;private avisos=new Set<()=>void>();
 constructor(private page:Page){page.on('request',this.requisicao);page.on('response',this.resposta);page.on('requestfailed',this.falha);}
 private requisicao=(r:Request)=>{
  if(r.isNavigationRequest()&&r.frame()===this.page.mainFrame()){this.atual=undefined;this.avisar();}
  const u=new URL(r.url());
  if(r.method()==='GET'&&u.origin==='https://app.tribemd.com'&&u.pathname==='/api/atendimentos/agenda'&&r.frame()===this.page.mainFrame()){
   this.atual={request:r};this.avisar();
  }
 };
 private resposta=(r:Response)=>{if(this.atual?.request===r.request()){this.atual.response=r;this.avisar();}};
 private falha=(r:Request)=>{if(this.atual?.request===r){this.atual.falhou=true;this.avisar();}};
 private avisar(){for(const a of [...this.avisos])a();}
 async cabecalhosLeitura(recorte:RecorteAgendaTribemd){
  const atual=this.atual,headers:Record<string,string>={};
  if(!atual||atual.resultado!==recorte)throw new ErroAgendaTribemd('AGENDA_ATUALIZADA_REPITA_LEITURA');
  try{
   for(const nome of ['authorization','x-instituicao','x-timezone','x-version','x-device']){const valor=await atual.request.headerValue(nome);if(valor)headers[nome]=valor;}
   if(this.fechado||this.atual!==atual)throw new ErroAgendaTribemd('AGENDA_ATUALIZADA_REPITA_LEITURA');
   return headers;
  }catch(e){for(const nome of Object.keys(headers))delete headers[nome];throw e;}
 }
 temRequisicao(){return !!this.atual;}
 observarExistente(obs:ObservadorRedeLoginTribemd){if(this.atual)obs.incluirExistente(this.atual.request,this.atual.response);}
 private esperar(ms:number){return new Promise<void>((resolve,reject)=>{
  const fim=()=>{clearTimeout(timer);this.avisos.delete(fim);resolve();};
  const timer=setTimeout(()=>{this.avisos.delete(fim);reject(new ErroAgendaTribemd('LEITURA_AGENDA_TEMPO_ESGOTADO'));},ms);
  this.avisos.add(fim);
 });}
 async ler(hoje:string,tempoMs=20000):Promise<RecorteAgendaTribemd>{
  const prazo=Date.now()+tempoMs;
  while(!this.fechado){
   const atual=this.atual;
   if(atual?.falhou)throw new ErroAgendaTribemd('LEITURA_AGENDA_REDE_FALHOU');
   if(atual?.response){
    if(atual.resultado)return atual.resultado;
    const r=atual.response,status=r.status();
    if(status===401)throw new ErroAgendaTribemd('SESSAO_EXPIRADA');
    if(status===403)throw new ErroAgendaTribemd('LEITURA_AGENDA_SEM_PERMISSAO');
    if(status<200||status>=300)throw new ErroAgendaTribemd('LEITURA_AGENDA_HTTP_ERRO');
    const restante=prazo-Date.now();if(restante<=0)throw new ErroAgendaTribemd('LEITURA_AGENDA_TEMPO_ESGOTADO');
    let timer:NodeJS.Timeout|undefined;const alterada=Symbol();
    let notificar!:()=>void;
    const mudou=new Promise<typeof alterada>(resolve=>{notificar=()=>{if(this.fechado||this.atual!==atual)resolve(alterada);};this.avisos.add(notificar);notificar();});
    const lerCorpo=async()=>{
     let bytes:Buffer|undefined;
     try{
      const tamanho=Number(await r.headerValue('content-length'));
      if(this.fechado||this.atual!==atual||Date.now()>=prazo)throw new ErroAgendaTribemd('LEITURA_AGENDA_CANCELADA');
      if(tamanho>limiteBytes)throw new ErroAgendaTribemd('LEITURA_AGENDA_LIMITE_EXCEDIDO');
      bytes=await r.body();if(bytes.length>limiteBytes)throw new ErroAgendaTribemd('LEITURA_AGENDA_LIMITE_EXCEDIDO');
      if(this.fechado||this.atual!==atual||Date.now()>=prazo)throw new ErroAgendaTribemd('LEITURA_AGENDA_CANCELADA');
      const dados=extrairAgendaTribemd(JSON.parse(bytes.toString('utf8')),hoje),u=new URL(atual.request.url());
      const dia=(v:string|null)=>v&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&dataISOTribemd(v)?v:null;
      return {...dados,intervalo:{inicio:dia(u.searchParams.get('inicio')),fim:dia(u.searchParams.get('fim'))}};
     }catch(e){throw e instanceof ErroAgendaTribemd?e:new ErroAgendaTribemd('LEITURA_AGENDA_FORMATO_NAO_RECONHECIDO');}
     finally{bytes?.fill(0);}
    };
    let resultado:RecorteAgendaTribemd|typeof alterada;
    try{resultado=await Promise.race([lerCorpo(),mudou,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new ErroAgendaTribemd('LEITURA_AGENDA_TEMPO_ESGOTADO')),restante);})]);}
    catch(e){if(this.atual!==atual||this.fechado)continue;throw e;}
    finally{clearTimeout(timer);this.avisos.delete(notificar);}
    // Não retornar um filtro anterior se o próprio portal mudou a consulta durante a leitura.
    if(resultado===alterada||this.atual!==atual||this.fechado)continue;
    atual.resultado=resultado;return resultado;
   }
   const restante=prazo-Date.now();if(restante<=0)throw new ErroAgendaTribemd('LEITURA_AGENDA_TEMPO_ESGOTADO');await this.esperar(restante);
  }
  throw new ErroAgendaTribemd('SESSAO_ENCERRADA');
 }
 /** Retrocede pela UI; somente o GET disparado pelo próprio portal é lido. */
 async lerJanela(hoje:string,janelaDias=90,processar?:(recorte:RecorteAgendaTribemd)=>Promise<ConsultaTribemd[]>):Promise<RecorteAgendaTribemd>{
  if(!dataISOTribemd(hoje)||!Number.isInteger(janelaDias)||janelaDias<1||janelaDias>365)throw new ErroAgendaTribemd('JANELA_AGENDA_INVALIDA');
  const inicio=new Date(hoje+'T12:00:00Z');inicio.setUTCDate(inicio.getUTCDate()-janelaDias);
  const desde=inicio.toISOString().slice(0,10),consultas=new Map<string,ConsultaTribemd>();
  let recorte=await this.ler(hoje),fim=recorte.intervalo.fim,totalAtendimentos=0;
  if(!fim||fim<hoje||!recorte.intervalo.inicio||recorte.intervalo.inicio>hoje)throw new ErroAgendaTribemd('JANELA_AGENDA_NAO_CONFIRMADA');
  for(let pagina=0;pagina<55;pagina++){
   if(recorte.limitado)throw new ErroAgendaTribemd('LEITURA_AGENDA_LIMITE_EXCEDIDO');
   const inicioRecorte=recorte.intervalo.inicio;
   if(!inicioRecorte)throw new ErroAgendaTribemd('JANELA_AGENDA_NAO_CONFIRMADA');
   totalAtendimentos+=recorte.totalAtendimentos;
   const lidas=processar?await processar(recorte):recorte.consultas;
   for(const c of lidas)if(c.atendimentoId&&c.dataConsultaObservada&&c.dataConsultaObservada>=desde&&c.dataConsultaObservada<=hoje)consultas.set(c.atendimentoId,c);
   if(inicioRecorte<=desde)return {consultas:[...consultas.values()],totalAtendimentos,limitado:false,intervalo:{inicio:inicioRecorte,fim}};
   const botao=this.page.getByRole('button',{name:/^(semana anterior|anterior|previous(?: week)?)$/i}).or(this.page.locator('button.fc-prev-button'));
   if(await botao.count()!==1||!await botao.isVisible()||!await botao.isEnabled())throw new ErroAgendaTribemd('PAGINACAO_AGENDA_NAO_RECONHECIDA');
   await Promise.all([this.page.waitForRequest(r=>r.method()==='GET'&&new URL(r.url()).origin==='https://app.tribemd.com'&&new URL(r.url()).pathname==='/api/atendimentos/agenda',{timeout:10000}),botao.click()]);
   const proximo=await this.ler(hoje),anterior=new Date(inicioRecorte+'T12:00:00Z');anterior.setUTCDate(anterior.getUTCDate()-1);
   if(!proximo.intervalo.inicio||!proximo.intervalo.fim||proximo.intervalo.inicio>=inicioRecorte||proximo.intervalo.fim<anterior.toISOString().slice(0,10))throw new ErroAgendaTribemd('JANELA_AGENDA_NAO_CONFIRMADA');
   recorte=proximo;
  }
  throw new ErroAgendaTribemd('JANELA_AGENDA_NAO_CONFIRMADA');
 }
 encerrar(){this.fechado=true;this.page.off('request',this.requisicao);this.page.off('response',this.resposta);this.page.off('requestfailed',this.falha);this.atual=undefined;this.avisar();}
}
