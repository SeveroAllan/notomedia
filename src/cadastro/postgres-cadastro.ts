import { mapearEscolhas } from './confirmar-pendencia.js';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { nomeProfissionalValido, normalizarCrm } from '../conta/validar-dados-emissao.js';
import { criarPendencia, type DadosCadastro, type PerfilCadastro, type ResultadoEnriquecimento } from './enriquecer-cadastro.js';
import { aprovacaoPainelSchema, pesquisaPainelSchema, ErroRevisaoCadastro, montarRevisao, temAprovacaoProfissional } from './revisao-painel.js';
const versaoRevisaoSql="md5(jsonb_build_array(t.dados,t.snapshot,t.estado,t.atualizado_em,m.nome_completo,m.crm,m.rqe)::text)";
export interface TrabalhoCadastro { id:string; medico_id:string; certificado_id:string; documento_titular:string|null; estado:string; dados:DadosCadastro; snapshot:{nome:string;crm:string|null}; tentativas:number }
export interface ReservaCadastro { trabalho:TrabalhoCadastro; token:string; perfil:PerfilCadastro }
export interface AvisoCadastro { id:string; trabalho_id:string; chave:string; pendencia_id:string|null; tipo:'pergunta'|'esclarecer'|'concluido'; texto:string|null; mensagem_recebida:string|null; estado:string; reserva:string; tentativas:number; trabalho:TrabalhoCadastro; telefone:string }
export interface RespostaCadastro { id:string; trabalho_id:string; pendencia_id:string; texto:string; reserva:string; tentativas:number; trabalho:TrabalhoCadastro }
export class PostgresCadastro {
 constructor(readonly pool:pg.Pool){}
 async agendarPesquisaProfissional(provedor?:'openserp'):Promise<void>{
  await this.pool.query(`update cadastro_certificado_trabalhos t set estado='pendente',proxima_tentativa_em=now(),reserva=null,reservado_em=null,
   diagnostico=null,dados=dados-'pesquisaProfissional',atualizado_em=now(),
   tentativas=case when $1='openserp' and left(dados->'pesquisaProfissional'->>'codigo',7)='SERPER_' then 0 else tentativas end
   where estado='aguardando_confirmacao' and dados #>> '{aprovacaoPainel,confirmadoEm}' is null
   and (tentativas<3 or ($1='openserp' and left(dados->'pesquisaProfissional'->>'codigo',7)='SERPER_')) and (
    dados->'pesquisaProfissional'->>'codigo'='CRM_FONTE_NAO_CONFIGURADA'
    or left(dados->'pesquisaProfissional'->>'codigo',4)='CFM_'
    or left(dados->'pesquisaProfissional'->>'codigo',12)='INFOSIMPLES_'
    or ($1='openserp' and left(dados->'pesquisaProfissional'->>'codigo',7)='SERPER_')
    or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(dados #> '{pesquisaProfissional,registros}')='array'
     then dados #> '{pesquisaProfissional,registros}' else '[]'::jsonb end) as r(registro) where r.registro->>'origem' ilike '%Infosimples%')
   )
   and (jsonb_array_length(coalesce(dados->'empresa'->'candidatos','[]'::jsonb))=1 or dados->>'nomeConfirmado' is not null)`,[provedor??null]);
 }
 async revisaoPainel(medicoId:string){
  const r=(await this.pool.query(`select m.nome_completo as nome,m.crm,m.rqe,to_jsonb(t) as trabalho,${versaoRevisaoSql} as versao
   ,exists(select 1 from whatsapp_instancias w where w.medico_id=m.id and w.oficial=false and w.status='conectado') as whatsapp_conectado
   from medicos m
   left join lateral(select id from medico_certificados where medico_id=m.id and status='ativo' order by criado_em desc,id desc limit 1) cert on true
   left join cadastro_certificado_trabalhos t on t.certificado_id=cert.id and t.medico_id=m.id where m.id=$1`,[medicoId])).rows[0];
  if(!r)throw new ErroRevisaoCadastro(404,'Cadastro não encontrado.');
  return {...montarRevisao(r.trabalho?{...r.trabalho,versao:r.versao}:null,r),whatsappConectado:r.whatsapp_conectado};
 }
 async pesquisarPainel(medicoId:string,entrada:unknown){
  const e=pesquisaPainelSchema.parse(entrada);
  await this.transacao(async c=>{
   const t=(await c.query('select * from cadastro_certificado_trabalhos where id=$1 and medico_id=$2 for update',[e.trabalhoId,medicoId])).rows[0] as TrabalhoCadastro|undefined;
   if(!t||!['aguardando_confirmacao','concluido'].includes(t.estado))throw new ErroRevisaoCadastro(409,'O cadastro mudou. Atualize os dados antes de pesquisar.');
   const cert=(await c.query("select id from medico_certificados where medico_id=$1 and status='ativo' order by criado_em desc,id desc limit 1 for update",[medicoId])).rows[0];
   const ativo=(await c.query('select exists(select 1 from usuarios u where u.conta_id=m.conta_id and u.ativo=true) as ativo from medicos m where m.id=$1',[medicoId])).rows[0]?.ativo;
   if(!ativo||cert?.id!==t.certificado_id)throw new ErroRevisaoCadastro(409,'A consulta ou o certificado mudou. Atualize os dados antes de pesquisar.');
   const versao=(await c.query(`select ${versaoRevisaoSql} as versao from cadastro_certificado_trabalhos t join medicos m on m.id=t.medico_id where t.id=$1`,[t.id])).rows[0]?.versao;
   if(versao!==e.versao)throw new ErroRevisaoCadastro(409,'Os dados foram atualizados. Revise novamente antes de pesquisar.');
   const candidatos=t.dados.empresa?.candidatos??(t.dados.pendencia?.tipo==='responsavel'?t.dados.pendencia.candidatos:[]);
   if(t.dados.nomeConfirmado!==e.nome&&!candidatos.some(candidato=>candidato.nome===e.nome))throw new ErroRevisaoCadastro(400,'Selecione um dos responsáveis encontrados para pesquisar.');
   const dados:DadosCadastro={...t.dados,nomeConfirmado:e.nome,pesquisaSolicitadaPainel:true};delete dados.pesquisaProfissional;delete dados.pendencia;delete dados.cadastroIndisponivel;
   if(t.dados.nomeConfirmado!==e.nome)delete dados.aprovacaoPainel;
   await c.query("update cadastro_certificado_trabalhos set estado='pendente',dados=$2,tentativas=0,proxima_tentativa_em=now(),reserva=null,reservado_em=null,diagnostico=null,atualizado_em=now() where id=$1",[t.id,JSON.stringify(dados)]);
  });
  return this.revisaoPainel(medicoId);
 }
 async aprovarPainel(medicoId:string,entrada:unknown){
  const e=aprovacaoPainelSchema.parse(entrada);
  await this.transacao(async c=>{
   const t=(await c.query('select * from cadastro_certificado_trabalhos where id=$1 and medico_id=$2 for update',[e.trabalhoId,medicoId])).rows[0] as TrabalhoCadastro|undefined;
   if(!t)throw new ErroRevisaoCadastro(409,'O cadastro mudou. Atualize os dados antes de confirmar.');
   const m=(await c.query('select nome_completo,crm,rqe from medicos where id=$1 for update',[medicoId])).rows[0];
   const cert=(await c.query("select id from medico_certificados where medico_id=$1 and status='ativo' order by criado_em desc,id desc limit 1 for update",[medicoId])).rows[0];
   const ativo=(await c.query('select exists(select 1 from usuarios u where u.conta_id=m.conta_id and u.ativo=true) as ativo from medicos m where m.id=$1',[medicoId])).rows[0]?.ativo;
   if(!ativo||cert?.id!==t.certificado_id||!['pendente','consultando','aguardando_confirmacao','concluido'].includes(t.estado))throw new ErroRevisaoCadastro(409,'A consulta ou o certificado mudou. Atualize os dados antes de confirmar.');
   const anterior=t.dados.aprovacaoPainel;
   if(t.estado==='concluido'&&anterior?.confirmadoEm&&anterior.nome===e.nome&&anterior.crm===e.crm&&anterior.rqe===e.rqe&&m.nome_completo===e.nome&&m.crm===e.crm&&m.rqe===e.rqe)return;
   const versao=(await c.query(`select ${versaoRevisaoSql} as versao from cadastro_certificado_trabalhos t join medicos m on m.id=t.medico_id where t.id=$1`,[t.id])).rows[0].versao;
   if(versao!==e.versao)throw new ErroRevisaoCadastro(409,'Os dados foram atualizados. Revise novamente antes de confirmar.');
   await c.query('update medicos set nome_completo=$2,crm=$3,rqe=$4,atualizado_em=now() where id=$1',[medicoId,e.nome,e.crm,e.rqe]);
   const dados:DadosCadastro={...t.dados,nomeConfirmado:e.nome,crmOrigem:'Confirmado pelo usuário no painel',aprovacaoPainel:{nome:e.nome,crm:e.crm!,rqe:e.rqe,confirmadoEm:new Date().toISOString()}};delete dados.pendencia;
   await c.query("update cadastro_certificado_trabalhos set estado='concluido',dados=$2,snapshot=$3,reserva=null,reservado_em=null,diagnostico=null,atualizado_em=now() where id=$1",[t.id,JSON.stringify(dados),JSON.stringify({nome:e.nome,crm:e.crm})]);
   await c.query("update cadastro_certificado_avisos set estado='falha',diagnostico='APROVADO_NO_PAINEL',reserva=null where trabalho_id=$1 and estado in ('pendente','preparado')",[t.id]);
   console.info('[Cadastro automático]',{etapa:'aprovado_no_painel',trabalhoId:t.id,medicoId});
  });
  return this.revisaoPainel(medicoId);
 }
 async transacao<T>(fn:(c:pg.PoolClient)=>Promise<T>):Promise<T>{const c=await this.pool.connect();try{await c.query('begin');const r=await fn(c);await c.query('commit');return r;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
 async agendar(e:{medicoId:string;certificadoId:string;documentoTitular?:string}):Promise<void>{
  await this.transacao(async c=>{
   await c.query(`insert into cadastro_certificado_trabalhos(medico_id,certificado_id,documento_titular,snapshot)
    select m.id,c.id,$3,jsonb_build_object('nome',m.nome_completo,'crm',m.crm) from medicos m join medico_certificados c on c.medico_id=m.id
    where m.id=$1 and c.id=$2 and c.status='ativo' on conflict(certificado_id) do nothing`,[e.medicoId,e.certificadoId,e.documentoTitular??null]);
   if(!e.documentoTitular)return;
   const trabalhos=(await c.query('select * from cadastro_certificado_trabalhos where medico_id=$1 order by criado_em desc,id desc for update',[e.medicoId])).rows as TrabalhoCadastro[];
   const atual=trabalhos.find(t=>t.medico_id===e.medicoId&&t.certificado_id===e.certificadoId);
   if(!atual||atual.estado==='obsoleto')return;
   const m=(await c.query('select nome_completo,crm,rqe from medicos where id=$1 for update',[e.medicoId])).rows[0];
   if(!m)return;
   const perfil={nome:m.nome_completo,crm:m.crm,rqe:m.rqe};
   const anterior=trabalhos.find(t=>t.medico_id===e.medicoId&&t.certificado_id!==e.certificadoId&&t.documento_titular===e.documentoTitular&&temAprovacaoProfissional(t,perfil));
   if(!anterior)return;
   const dados:DadosCadastro={nomeConfirmado:perfil.nome,crmOrigem:'Confirmado pelo usuário no painel',aprovacaoPainel:anterior.dados.aprovacaoPainel};
   await c.query("update cadastro_certificado_trabalhos set estado='concluido',dados=$2,documento_titular=$3,snapshot=$4,reserva=null,reservado_em=null,diagnostico=null,atualizado_em=now() where id=$1",[atual.id,JSON.stringify(dados),e.documentoTitular,JSON.stringify({nome:perfil.nome,crm:perfil.crm})]);
  });
 }
 async agendarAtivos():Promise<void>{
  await this.pool.query(`insert into cadastro_certificado_trabalhos(medico_id,certificado_id,snapshot)
   select m.id,c.id,jsonb_build_object('nome',m.nome_completo,'crm',m.crm) from medicos m
   join medico_certificados c on c.medico_id=m.id and c.status='ativo'
   where exists(select 1 from usuarios u where u.conta_id=m.conta_id and u.ativo=true)
   and not exists(select 1 from medico_certificados n where n.medico_id=m.id and n.status='ativo' and (n.criado_em,n.id)>(c.criado_em,c.id))
   on conflict(certificado_id) do nothing`);
 }
 async invalidarObsoletos():Promise<void>{
  await this.pool.query(`update cadastro_certificado_trabalhos t set estado='pendente',reserva=null,reservado_em=null,tentativas=0,proxima_tentativa_em=now(),diagnostico='CADASTRO_ALTERADO',
   dados=case when t.snapshot->>'nome' is not distinct from m.nome_completo then t.dados-'pendencia' else t.dados-'pendencia'-'nomeConfirmado' end,
   snapshot=jsonb_build_object('nome',m.nome_completo,'crm',m.crm) from medicos m
   where m.id=t.medico_id and t.estado='aguardando_confirmacao' and (m.nome_completo is distinct from t.snapshot->>'nome' or m.crm is distinct from t.snapshot->>'crm')`);
  await this.pool.query(`update cadastro_certificado_trabalhos t set estado='obsoleto',reserva=null,atualizado_em=now()
  where t.estado not in ('obsoleto','concluido') and not exists(select 1 from medico_certificados c join medicos m on m.id=c.medico_id
   where c.id=t.certificado_id and c.medico_id=t.medico_id and c.status='ativo'
   and exists(select 1 from usuarios u where u.conta_id=m.conta_id and u.ativo=true)
   and not exists(select 1 from medico_certificados n where n.medico_id=m.id and n.status='ativo' and (n.criado_em,n.id)>(c.criado_em,c.id)))`);}
 async reservar():Promise<ReservaCadastro|null>{
  await this.invalidarObsoletos();return this.transacao(async c=>{
   const r=(await c.query(`select * from cadastro_certificado_trabalhos where estado in ('pendente','consultando') and proxima_tentativa_em<=now()
    and (reserva is null or reservado_em<now()-interval '30 minutes') order by criado_em,id for update skip locked limit 1`)).rows[0] as TrabalhoCadastro|undefined;
   if(!r)return null;const token=randomUUID();
   const m=(await c.query('select nome_completo,crm,rqe from medicos where id=$1',[r.medico_id])).rows[0];
   const confirmadoAnterior=(await c.query("select id from cadastro_certificado_trabalhos where medico_id=$1 and dados->>'nomeConfirmado'=$2 limit 1",[r.medico_id,m.nome_completo])).rows.length>0;
   r.tentativas++;await c.query("update cadastro_certificado_trabalhos set estado='consultando',reserva=$2,reservado_em=now(),tentativas=$3 where id=$1",[r.id,token,r.tentativas]);
   return {trabalho:r,token,perfil:{nome:m.nome_completo,crm:m.crm,rqe:m.rqe,nomeConfirmado:nomeProfissionalValido(m.nome_completo)&&confirmadoAnterior}};
  });
 }
 async documento(r:ReservaCadastro,documento:string|undefined):Promise<void>{await this.pool.query('update cadastro_certificado_trabalhos set documento_titular=$3 where id=$1 and reserva=$2',[r.trabalho.id,r.token,documento??null]);r.trabalho.documento_titular=documento??null;}
 async aplicar(r:ReservaCadastro,resultado:ResultadoEnriquecimento):Promise<void>{
  await this.transacao(async c=>{
   const t=(await c.query('select * from cadastro_certificado_trabalhos where id=$1 and reserva=$2 for update',[r.trabalho.id,r.token])).rows[0] as TrabalhoCadastro|undefined;
   if(!t)return;
   const m=(await c.query('select nome_completo,crm,rqe from medicos where id=$1 for update',[t.medico_id])).rows[0];
   const ativo=(await c.query("select id from medico_certificados where medico_id=$1 and status='ativo' order by criado_em desc,id desc limit 1 for update",[t.medico_id])).rows[0];
   if(ativo?.id!==t.certificado_id){await c.query("update cadastro_certificado_trabalhos set estado='obsoleto',reserva=null where id=$1",[t.id]);return;}
   if(m.nome_completo!==t.snapshot.nome || m.crm!==t.snapshot.crm){
    const dados={...t.dados};delete dados.pendencia;if(m.nome_completo!==t.snapshot.nome)delete dados.nomeConfirmado;
    await c.query("update cadastro_certificado_trabalhos set estado='pendente',reserva=null,tentativas=0,snapshot=$2,dados=$3,diagnostico='CADASTRO_ALTERADO',proxima_tentativa_em=now() where id=$1",[t.id,JSON.stringify({nome:m.nome_completo,crm:m.crm}),JSON.stringify(dados)]);return;
   }
   if(resultado.nome && !nomeProfissionalValido(resultado.nome))throw Error('NOME_INVALIDO');
   if(resultado.crm && !normalizarCrm(resultado.crm))throw Error('CRM_INVALIDO');
   if(resultado.nome || (resultado.crm&&!normalizarCrm(m.crm)) || (resultado.rqe&&!m.rqe)){
    await c.query('update medicos set nome_completo=coalesce($2,nome_completo),crm=coalesce($3,crm),rqe=coalesce($4,rqe),atualizado_em=now() where id=$1',[t.medico_id,resultado.nome??null,normalizarCrm(m.crm)?null:resultado.crm??null,m.rqe?null:resultado.rqe??null]);
    // O interlocutor pode ser secretário: nunca mudar automaticamente usuarios.nome.
   }
   let dados=resultado.dados;let estado:string=resultado.estado;let espera=0;
   if(estado==='retentar'){
    if(t.tentativas<3){estado='pendente';espera=t.tentativas===1?30:120;}
    else{estado='pendente';dados={...dados,cadastroIndisponivel:true};if(dados.nomeConfirmado){estado='aguardando_confirmacao';if(!normalizarCrm(m.crm))dados.pendencia=criarPendencia('crm');}}
   }
   await c.query(`update cadastro_certificado_trabalhos set estado=$2,dados=$3,reserva=null,reservado_em=null,diagnostico=$4,
    proxima_tentativa_em=now()+$5*interval '1 second',snapshot=$6,atualizado_em=now() where id=$1`,[t.id,estado,JSON.stringify(dados),resultado.codigo??null,espera,JSON.stringify({nome:resultado.nome??m.nome_completo,crm:resultado.crm??m.crm})]);
   if(estado==='aguardando_confirmacao'&&dados.pendencia)await this.agendarAviso(c,t.id,dados.pendencia.id,'pergunta',dados.pendencia.id);
   if(estado==='concluido')await this.agendarAviso(c,t.id,'concluido','concluido',null);
  });
 }
 async pendencia(medicoId:string):Promise<TrabalhoCadastro|null>{const r=await this.pool.query(`select t.* from cadastro_certificado_trabalhos t join medico_certificados c on c.id=t.certificado_id
  join medicos m on m.id=t.medico_id where t.medico_id=$1 and t.estado='aguardando_confirmacao' and c.status='ativo'
  and exists(select 1 from usuarios u where u.conta_id=m.conta_id and u.ativo=true)
  and not exists(select 1 from medico_certificados n where n.medico_id=m.id and n.status='ativo' and (n.criado_em,n.id)>(c.criado_em,c.id)) order by t.criado_em desc limit 1`,[medicoId]);return r.rows[0]??null;}
 private async agendarAviso(c:pg.PoolClient,trabalhoId:string,chave:string,tipo:AvisoCadastro['tipo'],pendenciaId:string|null,texto?:string):Promise<void>{
  await c.query('insert into cadastro_certificado_avisos(trabalho_id,chave,tipo,pendencia_id,mensagem_recebida) values($1,$2,$3,$4,$5) on conflict do nothing',[trabalhoId,chave,tipo,pendenciaId,texto??null]);
 }
 async reservarAviso():Promise<AvisoCadastro|null>{
  await this.invalidarObsoletos();
  await this.pool.query("update cadastro_certificado_avisos set estado='incerto',diagnostico='ENVIO_SEM_CONFIRMACAO' where estado='enviando' and reservado_em<now()-interval '3 minutes'");
  return this.transacao(async c=>{
   const r=(await c.query(`select a.*,to_jsonb(t) trabalho,
      (select u.telefone from usuarios u where u.conta_id=m.conta_id and u.ativo=true and u.telefone is not null
       order by (u.id=m.usuario_id) desc,u.criado_em,u.id limit 1) as telefone
    from cadastro_certificado_avisos a join cadastro_certificado_trabalhos t on t.id=a.trabalho_id
    join medicos m on m.id=t.medico_id
    where a.estado in ('pendente','preparado') and a.proxima_tentativa_em<=now() and (a.reserva is null or a.reservado_em<now()-interval '3 minutes')
    and exists(select 1 from whatsapp_instancias w where w.medico_id=t.medico_id and w.oficial=false and w.status='conectado')
    and t.estado in ('aguardando_confirmacao','concluido') and m.nome_completo is not distinct from t.snapshot->>'nome' and m.crm is not distinct from t.snapshot->>'crm'
    and (a.tipo='concluido' and t.estado='concluido' or a.pendencia_id::text=t.dados->'pendencia'->>'id')
    and exists(select 1 from medico_certificados cert where cert.id=t.certificado_id and cert.status='ativo')
    order by a.criado_em,a.id for update of a skip locked limit 1`)).rows[0] as AvisoCadastro|undefined;
   if(!r||!r.telefone)return null;r.reserva=randomUUID();r.tentativas++;
   await c.query('update cadastro_certificado_avisos set reserva=$2,reservado_em=now(),tentativas=$3 where id=$1',[r.id,r.reserva,r.tentativas]);return r;
  });
 }
 async prepararAviso(a:AvisoCadastro,texto:string):Promise<void>{await this.pool.query("update cadastro_certificado_avisos set texto=$3,estado='preparado' where id=$1 and reserva=$2 and estado='pendente'",[a.id,a.reserva,texto]);a.texto=texto;}
 async iniciarAviso(a:AvisoCadastro):Promise<boolean>{const r=await this.pool.query(`update cadastro_certificado_avisos a set estado='enviando' where a.id=$1 and a.reserva=$2 and a.estado='preparado'
  and exists(select 1 from cadastro_certificado_trabalhos t join medico_certificados cert on cert.id=t.certificado_id join medicos m on m.id=t.medico_id
   where t.id=a.trabalho_id and cert.status='ativo' and exists(select 1 from usuarios u where u.conta_id=m.conta_id and u.ativo=true)
   and t.estado in ('aguardando_confirmacao','concluido')
   and exists(select 1 from whatsapp_instancias w where w.medico_id=t.medico_id and w.oficial=false and w.status='conectado')
   and m.nome_completo is not distinct from t.snapshot->>'nome' and m.crm is not distinct from t.snapshot->>'crm'
   and (a.tipo='concluido' and t.estado='concluido' or a.pendencia_id::text=t.dados->'pendencia'->>'id')) returning a.id`,[a.id,a.reserva]);return r.rows.length===1;}
 async confirmarAviso(a:AvisoCadastro):Promise<void>{await this.transacao(async c=>{
  const r=await c.query("update cadastro_certificado_avisos set estado='confirmado',reserva=null where id=$1 and reserva=$2 and estado in ('enviando','incerto') returning texto",[a.id,a.reserva]);
  if(r.rows.length&&a.pendencia_id&&a.trabalho.dados.pendencia)await c.query(`update cadastro_certificado_trabalhos set dados=jsonb_set(jsonb_set(dados,'{pendencia,perguntaConfirmada}',to_jsonb($3::text)),'{pendencia,escolhasApresentadas}',$4::jsonb) where id=$1 and dados->'pendencia'->>'id'=$2`,[a.trabalho_id,a.pendencia_id,r.rows[0].texto,JSON.stringify(mapearEscolhas(a.trabalho.dados.pendencia,r.rows[0].texto))]);
 });}
 async falharAviso(a:AvisoCadastro,codigo:string,rejeitadoSemEnvio=false):Promise<void>{await this.pool.query(`update cadastro_certificado_avisos set estado=case when estado='enviando' and not $4 then 'incerto' when tentativas>=3 then 'falha' when estado='enviando' then 'preparado' else estado end,
  diagnostico=$3,reserva=null,proxima_tentativa_em=now()+case when tentativas=1 then interval '30 seconds' else interval '120 seconds' end where id=$1 and reserva=$2`,[a.id,a.reserva,codigo,rejeitadoSemEnvio]);}
 async enfileirarResposta(e:{medicoId:string;instancia:string;mensagemId:string;texto:string}):Promise<boolean>{
  if(!e.texto.trim()||e.texto.length>2000)return false;
  const duplicada=await this.pool.query(`select r.id from cadastro_certificado_respostas r join cadastro_certificado_trabalhos t on t.id=r.trabalho_id where instancia=$1 and mensagem_id=$2 and t.medico_id=$3`,[e.instancia,e.mensagemId,e.medicoId]);if(duplicada.rows.length)return true;
  const t=await this.pendencia(e.medicoId);if(!t?.dados.pendencia?.perguntaConfirmada)return false;
  await this.pool.query(`insert into cadastro_certificado_respostas(trabalho_id,pendencia_id,instancia,mensagem_id,texto) values($1,$2,$3,$4,$5) on conflict do nothing`,[t.id,t.dados.pendencia.id,e.instancia,e.mensagemId,e.texto]);return true;
 }
 async reservarResposta():Promise<RespostaCadastro|null>{
  // Limpeza em statement separado: não segurar trabalho ao esperar lock da resposta.
  await this.pool.query("update cadastro_certificado_respostas r set estado='processado',reserva=null where r.estado='pendente' and exists(select 1 from cadastro_certificado_trabalhos t where t.id=r.trabalho_id and t.estado in ('concluido','obsoleto'))");
  await this.invalidarObsoletos();return this.transacao(async c=>{
   const r=(await c.query(`select a.*,to_jsonb(t) trabalho from cadastro_certificado_respostas a join cadastro_certificado_trabalhos t on t.id=a.trabalho_id
    where a.estado in ('pendente','analisando') and a.proxima_tentativa_em<=now() and (a.reserva is null or a.reservado_em<now()-interval '3 minutes')
    and t.estado='aguardando_confirmacao' and a.pendencia_id::text=t.dados->'pendencia'->>'id'
    and not exists(select 1 from cadastro_certificado_respostas outra where outra.trabalho_id=a.trabalho_id and outra.id<>a.id and outra.estado='analisando' and outra.reservado_em>=now()-interval '3 minutes')
    order by a.criado_em,a.id for update of t,a skip locked limit 1`)).rows[0] as RespostaCadastro|undefined;
   if(!r)return null;r.reserva=randomUUID();r.tentativas++;
   await c.query("update cadastro_certificado_respostas set estado='analisando',reserva=$2,reservado_em=now(),tentativas=$3 where id=$1",[r.id,r.reserva,r.tentativas]);return r;
  });
 }
 async aplicarConfirmacao(a:RespostaCadastro,patch:{nome?:string;crm?:string}|null):Promise<void>{
  await this.transacao(async c=>{
   const resposta=(await c.query("select id from cadastro_certificado_respostas where id=$1 and reserva=$2 and estado='analisando' for update",[a.id,a.reserva])).rows[0];if(!resposta)return;
   const t=(await c.query('select * from cadastro_certificado_trabalhos where id=$1 for update',[a.trabalho_id])).rows[0] as TrabalhoCadastro;
   const m=(await c.query('select nome_completo,crm from medicos where id=$1 for update',[t.medico_id])).rows[0];
   const ativo=(await c.query("select id from medico_certificados where medico_id=$1 and status='ativo' order by criado_em desc,id desc limit 1 for update",[t.medico_id])).rows[0];
   const p=t.dados.pendencia;
   if(t.estado==='aguardando_confirmacao'&&p?.id===a.pendencia_id&&ativo?.id===t.certificado_id&&m.nome_completo===t.snapshot.nome&&m.crm===t.snapshot.crm){
    const nome=patch?.nome,crm=patch?.crm;
    if((nome&&p.tipo!=='crm'&&nomeProfissionalValido(nome)&&(!t.dados.nomeConfirmado||t.dados.nomeConfirmado===nome)) || (crm&&p.tipo==='crm'&&normalizarCrm(crm)?.includes('/')&&!normalizarCrm(m.crm))){
     await c.query('update medicos set nome_completo=coalesce($2,nome_completo),crm=coalesce($3,crm),atualizado_em=now() where id=$1',[t.medico_id,nome??null,crm??null]);
     const dados={...t.dados};delete dados.pendencia;if(nome)dados.nomeConfirmado=nome;if(crm)dados.crmOrigem='Declarado pelo usuário';
     await c.query("update cadastro_certificado_trabalhos set estado='pendente',dados=$2,snapshot=$3,tentativas=0,proxima_tentativa_em=now() where id=$1",[t.id,JSON.stringify(dados),JSON.stringify({nome:nome??m.nome_completo,crm:crm??m.crm})]);
    }else await this.agendarAviso(c,t.id,'resposta:'+a.id,'esclarecer',p.id,a.texto);
   }else if(t.estado==='aguardando_confirmacao'&&ativo?.id===t.certificado_id){
    const dados={...t.dados};delete dados.pendencia;if(m.nome_completo!==t.snapshot.nome)delete dados.nomeConfirmado;
    await c.query("update cadastro_certificado_trabalhos set estado='pendente',dados=$2,snapshot=$3,tentativas=0,proxima_tentativa_em=now() where id=$1",[t.id,JSON.stringify(dados),JSON.stringify({nome:m.nome_completo,crm:m.crm})]);
   }
   await c.query("update cadastro_certificado_respostas set estado='processado',reserva=null where id=$1",[a.id]);
  });
 }
 async falharResposta(a:RespostaCadastro,codigo:string):Promise<void>{await this.pool.query(`update cadastro_certificado_respostas set estado=case when tentativas>=3 then 'falha' else 'pendente' end,reserva=null,diagnostico=$3,
  proxima_tentativa_em=now()+case when tentativas=1 then interval '30 seconds' else interval '120 seconds' end where id=$1 and reserva=$2`,[a.id,a.reserva,codigo]);}

}
