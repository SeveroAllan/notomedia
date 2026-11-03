import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { nomeProfissionalValido } from '../conta/validar-dados-emissao.js';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';
import { descreverConferencia, type ResultadoConferencia } from './conferencia-atendimentos.js';
import type { AgendaEscolhida } from './estado-conversa.js';
import {
  reservarTrabalhoNoto,reservarNotificacaoNoto,concluirLeituraNoto,
  falharLeituraNoto,terminarNotificacaoNoto,recuperarTrabalhosInterrompidos,type TrabalhoParaNotificar
} from './trabalhos-duraveis.js';

type Banco=Pick<pg.Pool,'query'>;
export interface DependenciasTrabalhos {
  pool:Banco;
  instancia:string;
  descobrir:(contaId:string,medicoId:string|null,agenda:AgendaEscolhida)=>
    Promise<{ok:boolean;nomes?:string[];motivo?:string}>;
  conferir:(contaId:string,medicoId:string,agenda:AgendaEscolhida)=>Promise<ResultadoConferencia>;
  enviar:(telefone:string,texto:string)=>Promise<boolean>;
  relatar?:(codigo:string, duracaoMs:number, tipo:string)=>void;
}
const causaSegura=(motivo:string|undefined) =>
  ['LEITURA_INCOMPLETA','ACESSO_EXPIRADO','PROFISSIONAL_NAO_IDENTIFICADO',
    'SEM_AGENDA_CONECTADA','FONTE_INDISPONIVEL','IDENTIDADE_INCOMPLETA',
    'ESCOPO_NAO_CONFERIDO','REFERENCIAS_AMBIGUAS','CONCILIACAO_INDISPONIVEL']
    .includes(motivo??'')?motivo:'EXECUCAO_INDISPONIVEL';

export async function executarLeituraPendente(deps:DependenciasTrabalhos,executor:string):Promise<boolean>{
  const trabalho=await reservarTrabalhoNoto(deps.pool,executor);
  if(!trabalho)return false;
  const inicio=Date.now();
  try {
    if(trabalho.instancia!==deps.instancia) throw Error('INSTANCIA_DIVERGENTE');
    let resultado:object;
    if(trabalho.tipo==='descoberta_agenda'){
      const r=await deps.descobrir(trabalho.contaId,trabalho.medicoId,trabalho.agenda);
      const nomes=r.ok?(r.nomes??[]).filter(nomeProfissionalValido).slice(0,20):[];
      resultado=r.ok ? {ok:true,nomes,agenda:trabalho.agenda} :
        {ok:false,motivo:causaSegura(r.motivo)};
    } else if(trabalho.tipo==='conferencia_fiscal'&&trabalho.medicoId){
      const r=await deps.conferir(trabalho.contaId,trabalho.medicoId,trabalho.agenda);
      // Resultado é estritamente agregado e nunca inclui pacientes.
      resultado=r;
    } else throw Error('TRABALHO_INVALIDO');
    if(!await concluirLeituraNoto(deps.pool,trabalho.id,executor,resultado)){
      deps.relatar?.('RESULTADO_NAO_PERSISTIDO',Date.now()-inicio,trabalho.tipo);
    } else deps.relatar?.('LEITURA_FINALIZADA',Date.now()-inicio,trabalho.tipo);
  } catch {
    await falharLeituraNoto(deps.pool,trabalho.id,executor,'EXECUCAO_INDISPONIVEL');
    deps.relatar?.('FALHA_LEITURA',Date.now()-inicio,trabalho.tipo);
  }
  return true;
}

function textoResultado(job:TrabalhoParaNotificar):string {
  const r=job.resultado;
  const fonte=job.agenda==='tribemd'?'TribeMD':'Amplimed';
  if(!r||typeof r!=='object'||Array.isArray(r)) return 'Ainda não consegui conferir os dados da '+fonte+'. A tarefa continua registrada para acompanhamento.';
  const d=r as Record<string,unknown>;
  if(d['ok']!==true){
    const m=typeof d['motivo']==='string'?d['motivo']:'EXECUCAO_INDISPONIVEL';
    if(m==='LEITURA_INCOMPLETA'||m==='SINCRONIZACAO_INCOMPLETA')return 'A leitura da '+fonte+' não trouxe cobertura suficiente para conferir tudo com segurança. Mantive a tarefa registrada, sem presumir que a agenda esteja vazia.';
    if(m==='PROFISSIONAL_NAO_IDENTIFICADO'||m==='IDENTIDADE_INCOMPLETA')return 'A '+fonte+' ainda não identificou com segurança o profissional responsável pelos atendimentos. Não associei consultas por suposição.';
    return 'A conferência da '+fonte+' ainda não trouxe um resultado comprovável. Não alterei a agenda e não fiz nenhuma emissão.';
  }
  if(job.tipo==='descoberta_agenda'){
    const nomes=Array.isArray(d['nomes']) ? d['nomes'].filter((n:unknown):n is string=>typeof n==='string'&&nomeProfissionalValido(n)).slice(0,20):[];
    if(!nomes.length)return 'A leitura da '+fonte+' terminou, mas não trouxe nomes de profissionais comprovados. Isso não significa que não existam profissionais nessa agenda.';
    const visiveis=nomes.slice(0,5);
    const restantes=nomes.length>visiveis.length?' e outros '+(nomes.length-visiveis.length):'';
    return 'Terminei de conferir a '+fonte+'. Identifiquei '+visiveis.join(', ')+restantes+'. Quais desses médicos você quer vincular ao Noto?';
  }
  if(job.tipo==='conferencia_fiscal' &&
    d['agenda']===job.agenda&&typeof d['profissional']==='string' &&
    d['janelaDias']===30 && d['limite']==='VINCULOS_EXATOS_NAO_COMPROVAM_AUSENCIA_DE_NOTA'){
    const numericos=['realizados','comReferencia','semReferencia','comVinculoConfirmado',
      'comSolicitacaoVinculada','comNotaAutorizadaVinculada','semVinculoConfirmado'];
    if(numericos.every(k=>Number.isSafeInteger(d[k])&&(d[k] as number)>=0)){
      return descreverConferencia(d as unknown as ResultadoConferencia);
    }
  }
  return 'A conferência terminou, mas os dados não passaram na validação necessária para apresentar um resultado.';
}

async function destinatarioAutorizado(deps:DependenciasTrabalhos,job:TrabalhoParaNotificar):Promise<boolean>{
  if(job.instancia!==deps.instancia||!/^55\d{10,11}$/.test(job.telefone))return false;
  const r=await deps.pool.query([
    'select 1 from public.usuarios u',
    'where u.conta_id=$1 and u.ativo=true and u.auth_user_id is not null',
    "and regexp_replace(u.telefone,'[^0-9]','','g')=any($2::text[])",
    'limit 1'
  ].join('\n'),[job.contaId,gerarVariantesTelefoneBrasileiro(job.telefone)]);
  return r.rows.length===1;
}

/** A decisão de enviar acontece DEPOIS do resultado persistido.
 * 'notificando' NÃO é reenviado depois de crash/erro: aceite e entrega são incertos.
 */
export async function notificarResultadoPendente(deps:DependenciasTrabalhos):Promise<boolean>{
  const job=await reservarNotificacaoNoto(deps.pool);
  if(!job)return false;
  const inicio=Date.now();
  let aceitoApi=false;
  try{
    if(await destinatarioAutorizado(deps,job)){
      // Escrita atômica de evidência: nunca sobrescrever a conversa de outra
      // mensagem ou confirmar profissionais no lugar do usuário.
      if(job.tipo==='descoberta_agenda' && job.resultado &&
         typeof job.resultado==='object' && !Array.isArray(job.resultado)){
        const r=job.resultado as Record<string,unknown>;
        const nomes=r['ok']===true && Array.isArray(r['nomes'])
          ?r['nomes'].filter((n:unknown):n is string=>typeof n==='string'&&nomeProfissionalValido(n)).slice(0,20):[];
        if(nomes.length){
          await deps.pool.query([
            'update public.noto_agent_conversas',
            "set estado=jsonb_set(estado,'{descoberta}',$2::jsonb,true) ||",
            "jsonb_build_object('faseAgenda','CONFIRMACAO_PENDENTE'),atualizado_em=now()",
            'where conta_id=$1',
            "and (estado->>'agendaEscolhida' is null or estado->>'agendaEscolhida'=$3)"
          ].join('\n'),[job.contaId,JSON.stringify({agenda:job.agenda,nomes}),job.agenda]);
        }
      }
      aceitoApi=await deps.enviar(job.telefone,textoResultado(job));
    }
  }catch{ aceitoApi=false; }
  finally {
    await terminarNotificacaoNoto(deps.pool,job.id,aceitoApi);
    deps.relatar?.(aceitoApi?'NOTIFICACAO_ACEITA_API':'NOTIFICACAO_INCERTA',
      Date.now()-inicio,job.tipo);
  }
  return true;
}

/** Worker embutido, sem subagente bloqueando a conversa. Não usa IA paga. */
export function iniciarTrabalhosNoto(deps:DependenciasTrabalhos,intervaloMs=2500){
  const executor='noto-'+process.pid+'-'+randomUUID().slice(0,8);
  let ativo=true;
  let execucao:Promise<void>|null=null;
  const rodada=()=>{
    if(!ativo||execucao)return;
    execucao=(async()=>{
      await recuperarTrabalhosInterrompidos(deps.pool);
      const notificou=await notificarResultadoPendente(deps);
      if(!notificou) await executarLeituraPendente(deps,executor);
    })().catch(()=>deps.relatar?.('ERRO_CICLO',0,'worker')).finally(()=>{execucao=null});
  };
  const timer=setInterval(rodada,intervaloMs);
  timer.unref?.();
  rodada();
  return {parar:async()=>{ativo=false;clearInterval(timer);await execucao;}};
}
