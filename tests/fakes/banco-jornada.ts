import { randomUUID, createHash } from 'node:crypto';
import { BancoHistoricoFalso } from './banco-historico.js';

/** Estado só é criado por SQL dos adaptadores reais; SQL desconhecido sempre falha. */
export class BancoJornada {
  usuario: any = null;
  medico: any = null;
  perfil: any = null;
  servico: any = null;
  otp: any = null;
  certificados: any[] = [];
  trabalhos: any[] = [];
  auditoria: any[] = [];
  whatsapp: any = null;
  segredos = new Map<string, string>();
  historico = new BancoHistoricoFalso();
  consultas: string[] = [];
  desconhecidas: string[] = [];
  private versao() { return createHash('md5').update(JSON.stringify([this.trabalho(), this.medico])).digest('hex'); }
  private trabalho() { const c = this.certificados.find(c => c.status === 'ativo'); return this.trabalhos.find(t => t.certificado_id === c?.id) ?? null; }
  async connect() {
    const historico = await this.historico.connect();
    let snapshot: any;
    return { release: () => historico.release(), query: async (sql: string, p: any[] = []) => {
      if (sql === 'begin') snapshot = structuredClone([this.usuario,this.medico,this.perfil,this.servico,this.otp,this.certificados,this.trabalhos,this.auditoria,this.whatsapp,this.segredos]);
      if (sql === 'rollback' && snapshot) [this.usuario,this.medico,this.perfil,this.servico,this.otp,this.certificados,this.trabalhos,this.auditoria,this.whatsapp,this.segredos] = snapshot;
      if (['begin','commit','rollback'].includes(sql)) await historico.query(sql,p);
      if (/public\.noto_|pg_advisory/.test(sql)) return historico.query(sql,p);
      return this.query(sql,p);
    } };
  }
  async query(texto: string, p: any[] = []): Promise<{rows:any[];rowCount:number}> {
    const s = texto.replace(/\s+/g,' ').trim().toLowerCase(); this.consultas.push(s);
    const ret = (rows:any[] = []) => ({ rows: structuredClone(rows), rowCount: rows.length });
    if (['begin','commit','rollback'].includes(s)) return ret();
    if (s.startsWith('insert into otp_verificacoes')) { this.otp={id:randomUUID(),telefone:p[0],codigo_hash:p[1],expira_em:p[2],criado_em:p[3]??new Date(),tentativas:0,verificado_em:null};return ret([this.otp]); }
    if (s.includes('from otp_verificacoes')) return ret(this.otp?.telefone===p[0]?[this.otp]:[]);
    if (s.startsWith('update otp_verificacoes')) { if(s.includes('verificado_em'))this.otp.verificado_em=p[1]; else this.otp.tentativas++;return ret(); }
    if (s.startsWith('select u.id as usuario_id')) return ret(this.usuario?[{...this.usuario,usuario_id:this.usuario.id,medico_id:this.medico?.id}]:[]);
    if (s.startsWith('insert into contas')) return ret([{id:randomUUID()}]);
    if (s.startsWith('insert into usuarios')) { this.usuario={id:randomUUID(),auth_user_id:p[0],conta_id:p[1],papel:'medico',nome:p[2],email:p[3],telefone:p[4],ativo:true};return ret([this.usuario]); }
    if (s.startsWith('insert into medicos')) { this.medico={id:randomUUID(),usuario_id:p[0],conta_id:p[1],nome_completo:p[2],crm:null,rqe:null,especialidade:null};return ret([this.medico]); }
    if (s.startsWith('select id from medicos where id')) return ret(this.medico?.id===p[0]?[{id:this.medico.id}]:[]);
    if (s.startsWith('select m.id from medicos m join usuarios')) { const vinculado=p.length===2?this.medico?.id===p[0]&&this.usuario?.auth_user_id===p[1]:this.usuario?.auth_user_id===p[0];return ret(vinculado?[{id:this.medico.id}]:[]); }
    if (s.startsWith('select m.id from usuarios u join medicos m on m.conta_id=u.conta_id')) {
      const alvo=p[1]??null,vinculado=this.usuario?.auth_user_id===p[0]&&this.usuario?.ativo&&this.medico?.conta_id===this.usuario?.conta_id&&(!alvo||this.medico?.id===alvo);
      return ret(vinculado?[{id:this.medico.id}]:[]);
    }
    if (s.startsWith('select 1 from usuarios u join medicos m on m.conta_id=u.conta_id')) return ret(this.usuario?.auth_user_id===p[1]&&this.usuario?.ativo&&this.medico?.id===p[0]&&this.medico?.conta_id===this.usuario?.conta_id?[{'?column?':1}]:[]);
    if (s.startsWith('update usuarios set nome')) {this.usuario.nome=p[1];return ret();}
    if (s.startsWith('update medicos set nome_completo=$2')) { Object.assign(this.medico,{nome_completo:p[1],crm:p[2],rqe:p[3]});return ret(); }
    if (s.startsWith('update medicos set nome_completo = $2')) {this.medico.nome_completo=p[1];return ret();}
    if (s.startsWith('update medicos')&&s.includes("coalesce(nullif(nome_completo, '')")) {this.medico.nome_completo ||= p[1];return ret();}
    if (s.startsWith('update medicos')&&s.includes('especialidade = coalesce(nullif')) {this.medico.especialidade ||= p[1];return ret();}
    if (s.startsWith('select vault.create_secret')) {const id=randomUUID();this.segredos.set(id,p[0]);return ret([{id}]);}
    if (s.includes('from vault.decrypted_secrets')) return ret([{secret:this.segredos.get(p[0])}]);
    if (s.startsWith('update medico_certificados set status')) {this.certificados.forEach(c=>{if(c.medico_id===p[0]&&c.status==='ativo')c.status='vencido';});return ret();}
    if (s.startsWith('insert into medico_certificados')) {const c={id:p[0],medico_id:p[1],arquivo_storage_path:p[2],senha_secret_id:p[3],valido_de:p[4],valido_ate:p[5],status:'ativo'};this.certificados.unshift(c);return ret([c]);}
    if (s.startsWith('select id, medico_id, arquivo_storage_path')||s.startsWith('select id from medico_certificados')) return ret(this.certificados.filter(c=>c.status==='ativo').slice(0,1));
    if (s.startsWith('select confirmado_pelo_medico from medico_perfil_fiscal')) return ret(this.perfil?[this.perfil]:[]);
    if (s.startsWith('update medico_perfil_fiscal set dados_reforma_tributaria')) {this.perfil.dados_reforma_tributaria=JSON.parse(p[1]);this.perfil.xml_nota_referencia_url??=p[2];return ret();}
    if (s.startsWith('insert into medico_perfil_fiscal')) {this.perfil={medico_id:p[0],razao_social:p[5],inscricao_municipal:p[7],uf:p[8],cod_municipio_ibge:p[9],serie_dps:p[10],opcao_simples_nacional:p[11],regime_apuracao_sn:p[12],regime_especial_tributacao:p[13],ambiente:p[14],proximo_numero_dps:p[16],dados_reforma_tributaria:JSON.parse(p[19]),xml_nota_referencia_url:p[20],extraido_automaticamente:true,confirmado_pelo_medico:false};return ret();}
    if (s.startsWith('update medico_servicos_fiscais set padrao')) return ret();
    if (s.startsWith('insert into medico_servicos_fiscais')) {this.servico={id:randomUUID(),medico_id:p[0],nome_servico:p[1],ctrib_nac:p[2],ctrib_mun:p[3],cnbs:p[4],xdesc_serv:p[5],valor_padrao_centavos:p[6],aliquota_iss:p[7],parametros_emissao:null};return ret();}
    if (s.startsWith('select cod_municipio_ibge, serie_dps')) return ret(this.perfil?[this.perfil]:[]);
    if (s.startsWith('select id, ctrib_nac')) return ret(this.servico?[this.servico]:[]);
    if (s.startsWith('update medico_perfil_fiscal set confirmado_pelo_medico = true,')) {Object.assign(this.perfil,{confirmado_pelo_medico:true,serie_dps:p[1],proximo_numero_dps:p[2]??this.perfil.proximo_numero_dps,opcao_simples_nacional:p[3],regime_apuracao_sn:p[4],regime_especial_tributacao:p[5],ambiente:p[7]});return ret();}
    if (s.startsWith('update medico_servicos_fiscais set parametros_emissao')) {this.servico.parametros_emissao=JSON.parse(p[2]);return ret();}
    if (s.startsWith('update medico_perfil_fiscal set razao_social')) {this.perfil.razao_social=p[1];return ret();}
    if (s.startsWith('update medico_servicos_fiscais set aliquota_iss')) {this.servico.aliquota_iss=p[1];return ret();}
    if (s.startsWith('insert into auditoria')) {this.auditoria.push({sql:s,params:p});return ret();}
    if (s.startsWith('select true as permitido from auditoria')) return ret(this.auditoria.some(a=>a.sql.includes('consentimento_parametros_fiscais')&&JSON.parse(a.params[1]).certificadoId===this.certificados.find(c=>c.status==='ativo')?.id)?[{permitido:true}]:[]);
    if (s.startsWith('insert into cadastro_certificado_trabalhos')) {for(const c of this.certificados.filter(c=>c.status==='ativo'))if(!this.trabalhos.some(t=>t.certificado_id===c.id))this.trabalhos.push({id:randomUUID(),medico_id:c.medico_id,certificado_id:c.id,documento_titular:p[2]??null,snapshot:{nome:this.medico.nome_completo,crm:this.medico.crm},dados:{},estado:'pendente',tentativas:0,reserva:null});return ret();}
    if (s.startsWith('update cadastro_certificado_trabalhos t set estado=')&&s.includes('where t.estado not in')) {for(const t of this.trabalhos)if(!['obsoleto','concluido'].includes(t.estado)&&!this.certificados.some(c=>c.id===t.certificado_id&&c.status==='ativo'))t.estado='obsoleto';return ret();}
    if (s.startsWith('update cadastro_certificado_trabalhos t set estado=')&&s.includes("t.estado='aguardando_confirmacao'")) return ret();
    if (s === 'select * from cadastro_certificado_trabalhos where medico_id=$1 order by criado_em desc,id desc for update') return ret(this.trabalhos.filter(t=>t.medico_id===p[0]).slice().reverse());
    if (s.startsWith('select * from cadastro_certificado_trabalhos where estado in')) return ret(this.trabalhos.filter(t=>t.estado==='pendente'&&!t.reserva).slice(0,1));
    if (s.startsWith('select * from cadastro_certificado_trabalhos where id=')) return ret(this.trabalhos.filter(t=>t.id===p[0]&&(s.includes('reserva=$2')?t.reserva===p[1]:s.includes('medico_id=$2')?t.medico_id===p[1]:true)));
    if (s.startsWith('select nome_completo,crm,rqe from medicos')) return ret([this.medico]);
    if (s.startsWith('select id from cadastro_certificado_trabalhos where medico_id=')) return ret(this.trabalhos.filter(t=>t.medico_id===p[0]&&t.dados.nomeConfirmado===p[1]));
    if (s.startsWith("update cadastro_certificado_trabalhos set estado='consultando'")) {Object.assign(this.trabalhos.find(t=>t.id===p[0]),{estado:'consultando',reserva:p[1],tentativas:p[2]});return ret();}
    if (s.startsWith('update cadastro_certificado_trabalhos set documento_titular=')) {this.trabalhos.find(t=>t.id===p[0]).documento_titular=p[2];return ret();}
    if (s.startsWith('update cadastro_certificado_trabalhos set estado=$2')) {Object.assign(this.trabalhos.find(t=>t.id===p[0]),{estado:p[1],dados:JSON.parse(p[2]),reserva:null,diagnostico:p[3],snapshot:JSON.parse(p[5])});return ret();}
    if (s.startsWith("update cadastro_certificado_trabalhos set estado='concluido',dados=$2,documento_titular=$3")) {Object.assign(this.trabalhos.find(t=>t.id===p[0]),{estado:'concluido',dados:JSON.parse(p[1]),documento_titular:p[2],snapshot:JSON.parse(p[3]),reserva:null});return ret();}
    if (s.startsWith("update cadastro_certificado_trabalhos set estado='concluido',dados=$2")) {Object.assign(this.trabalhos.find(t=>t.id===p[0]),{estado:'concluido',dados:JSON.parse(p[1]),snapshot:JSON.parse(p[2]),reserva:null});return ret();}
    if (s.startsWith('insert into cadastro_certificado_avisos')||s.startsWith('update cadastro_certificado_avisos')) return ret();
    if (s.startsWith('select u.ativo from usuarios')) return ret([{ativo:this.usuario.ativo}]);
    if (s.startsWith('select exists(select 1 from usuarios u where u.conta_id=m.conta_id')) return ret([{ativo:!!this.usuario?.ativo&&this.medico?.conta_id===this.usuario?.conta_id}]);
    if (s.startsWith('select md5(')) return ret([{versao:this.versao()}]);
    if (s.startsWith('select m.nome_completo as nome,m.crm,m.rqe,to_jsonb(t)')) return ret([{nome:this.medico.nome_completo,crm:this.medico.crm,rqe:this.medico.rqe,trabalho:this.trabalho(),versao:this.versao(),whatsapp_conectado:this.whatsapp?.status==='conectado'}]);
    if (s.includes('as cert_ativos')) return ret([{...this.perfil,...this.medico,medico_id:this.medico.id,usuario_id:this.usuario.id,medico_nome:this.medico.nome_completo,usuario_nome:this.usuario.nome,telefone:this.usuario.telefone,email:this.usuario.email,parametros_emissao:this.servico?.parametros_emissao,aliquota_iss:this.servico?.aliquota_iss,revisao_profissional:this.trabalho(),cert_ativos:this.certificados.filter(c=>c.status==='ativo').length,whats_conectados:this.whatsapp?.status==='conectado'?1:0,whatsapp_vinculado:!!this.whatsapp?.conectado_em}]);
    if (s.startsWith('select m.conta_id,')&&s.includes('from medicos m where m.id=$1')) return ret(this.medico?.id===p[0]?[{conta_id:this.medico.conta_id,nome_instancia:this.whatsapp?.nome_instancia??null,telefone_conta:this.usuario?.telefone??null}]:[]);
    if (s.startsWith('select w.nome_instancia from medicos m join whatsapp_instancias w')) return ret(this.medico?.id===p[0]&&this.whatsapp?[{nome_instancia:this.whatsapp.nome_instancia}]:[]);
    if (s.startsWith('select u.telefone from medicos')) return ret([{telefone:this.usuario.telefone}]);
    if (s.startsWith('insert into whatsapp_instancias')) {this.whatsapp={id:randomUUID(),medico_id:p[0],conta_id:this.medico?.conta_id,nome_instancia:p[1],status:p[2],conectado_em:p[3],webhook_configurado:p[4]};return ret([this.whatsapp]);}
    if (s.startsWith('update whatsapp_instancias set status')) {if(this.whatsapp){this.whatsapp.status='conectado';this.whatsapp.conectado_em??=new Date();}return ret();}
    if (s.startsWith('select id, medico_id, nome_instancia, oficial from whatsapp_instancias')) return ret(this.whatsapp?.nome_instancia===p[0]?[{...this.whatsapp,oficial:false}]:[]);
    if (s.startsWith('select nome_instancia from whatsapp_instancias')) return ret(this.whatsapp?.status==='conectado'?[this.whatsapp]:[]);
    if (s.includes('from notas_fiscais')) return ret();
    this.desconhecidas.push(s);throw Error(`SQL_JORNADA_DESCONHECIDO: ${s}`);
  }
}
