import { detalharConsultasTribemd, ErroDetalhesTribemd, type ResumoDetalhesTribemd } from './tribemd-detalhes.js';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { TelaVirtualTribemd } from './tribemd-display.js';
import { ObservadorRedeLoginTribemd, type DiagnosticoRedeLoginTribemd } from './tribemd-rede.js';
import { agendaTribemd, loginTribemd, origemTribemd, permitirRequisicaoTribemd, recursoPublicoTribemd, headersRecursoPublicoTribemd, lerConsultas, type ConsultaTribemd, type TabelaConsulta } from './tribemd-leitura.js';
import { LeitorAgendaTribemd, ErroAgendaTribemd, type RecorteAgendaTribemd } from './tribemd-agenda.js';
import { codigoEstadoLoginTribemd, type EstadoTelaLoginTribemd } from './tribemd-login-estado.js';
import type { EstadoNavegador } from './tribemd-perfil.js';
export class ErroTribemd extends Error {
 constructor(public codigo:string,public diagnostico?:{etapa:string;statusHttp?:number;rede?:DiagnosticoRedeLoginTribemd;tela?:EstadoTelaLoginTribemd}){super(codigo);}
}
export interface ResultadoLeituraTribemd {
 consultas:ConsultaTribemd[]; cobertura:'somente_linhas_visiveis'|'intervalo_carregado_pelo_portal'; pagina:'agenda'|'pacientes';
 historicoCompleto:false; detalhe:string; detalhes?:ResumoDetalhesTribemd; agenda?:Omit<RecorteAgendaTribemd,'consultas'>;
}
export class NavegadorTribemd {
 private page?:Page; private autenticando=true; private autenticado=false; private fechado=false;
 private fechamento?:Promise<void>; private observador?:ObservadorRedeLoginTribemd;
 private diagnostico?:DiagnosticoRedeLoginTribemd; private etapa='abrindo_login'; private statusHttp?:number;
 private agenda?:LeitorAgendaTribemd;private leituraFalhou=false;
 private envioLogin=false;private ultimaTela?:EstadoTelaLoginTribemd;
 private constructor(private context:BrowserContext,private browser:Browser,private display:TelaVirtualTribemd){}
 static async criar(opcoes:{executavel:string;xvfb?:string;estado?:EstadoNavegador;proxy?:string},signal:AbortSignal) {
  signal.throwIfAborted();let display:TelaVirtualTribemd;
  try{display=await TelaVirtualTribemd.iniciar(signal,opcoes.xvfb);}catch{throw new ErroTribemd('TELA_VIRTUAL_INDISPONIVEL');}
  let browser:Browser|undefined;
  try {
   browser=await chromium.launch({executablePath:opcoes.executavel,headless:false,env:{...process.env,DISPLAY:display.display},
    proxy:opcoes.proxy?{server:opcoes.proxy}:undefined,
    args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-logging','--disable-breakpad','--disable-crash-reporter','--disable-sync','--password-store=basic'],timeout:20000});
   const context=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:false,serviceWorkers:'block',storageState:opcoes.estado});
   // Sem trace/HAR/video. Não anexar listeners console/pageerror/request de conteúdo.
   await context.routeWebSocket('**/*',ws=>ws.close());
   const n=new NavegadorTribemd(context,browser,display);
   signal.addEventListener('abort',()=>{void n.encerrar();},{once:true});
   if(signal.aborted){await n.encerrar();signal.throwIfAborted();}
   return n;
  }catch(e){await browser?.close().catch(()=>{});await display.encerrar();if(e instanceof ErroTribemd)throw e;throw new ErroTribemd('NAVEGADOR_INDISPONIVEL');}
 }
 async abrir() {
  this.page=await this.context.newPage();const page=this.page;page.setDefaultTimeout(12000);
  this.context.on('page',p=>{if(p!==page)void p.close().catch(()=>{});});
  await this.context.route('**/*',async route=>{
   const r=route.request();let permitido=false;
   try{permitido=permitirRequisicaoTribemd(r.url(),r.method(),r.resourceType(),this.autenticando);}catch{}
   if(permitido&&r.method()==='POST'){
    // Um único envio, iniciado somente pelo botão explícito do painel.
    permitido=this.envioLogin&&new URL(r.url()).pathname==='/api/usuarios/login';
    this.envioLogin=false;
   }
   if(permitido&&recursoPublicoTribemd(r.url())){
    // O único recurso externo é JSON público; nunca enviar sessão ou chaves a ele.
    const headers=headersRecursoPublicoTribemd(await r.allHeaders());
    if(!headers)permitido=false;
    else{await route.fallback({headers});return;}
   }
   if(!permitido){this.observador?.marcarBloqueio(r);await route.abort('blockedbyclient');return;}
   await route.fallback();
  });
  this.observador=new ObservadorRedeLoginTribemd(page);
  this.agenda=new LeitorAgendaTribemd(page);
  try{
   this.statusHttp=(await page.goto(loginTribemd,{waitUntil:'domcontentloaded',timeout:30000}))?.status();
   if(this.statusHttp&&this.statusHttp>=400)throw new ErroTribemd('LOGIN_HTTP_ERRO');
   this.etapa='aguardando_formulario';
   // A hidratação pode redirecionar imediatamente se o perfil já está autenticado.
   await page.waitForFunction(`(() => { const s=${codigoEstadoLoginTribemd}; return s.senhasVisiveis>0||s.confirmado; })()`,undefined,{timeout:18000,polling:100});
   if(await this.confirmado()){await this.finalizarLogin();return 'perfil_reutilizado' as const;}
   return 'aguardando_credenciais' as const;
  }catch(e){throw await this.erroSeguro(e,'LOGIN_CARREGAMENTO_FALHOU');}
 }
 private async observarTela(){
  if(!this.page||this.page.isClosed()||this.fechado)return undefined;
  try{this.ultimaTela=await this.page.evaluate<EstadoTelaLoginTribemd>(codigoEstadoLoginTribemd);return this.ultimaTela;}catch{return undefined;}
 }
 private async confirmado(){return !!(await this.observarTela())?.confirmado;}
 private async finalizarLogin(){this.autenticando=false;this.autenticado=true;this.etapa='login_confirmado';this.diagnostico=await this.observador?.concluir();}
 async entrar(email:string,senha:string) {
  const p=this.page;if(!p||this.fechado)throw new ErroTribemd('SESSAO_ENCERRADA');
  if(this.autenticado)return;
  try {
   this.etapa='preenchendo_login';
   // O bundle público atual rotula o identificador como “E-mail ou CPF”.
   let e=p.getByLabel(/e-?mail(?: ou cpf)?/i);
   if(await e.count()!==1)e=p.locator('input[type=email]:visible,input[autocomplete=username]:visible,input[placeholder*="mail" i]:visible');
   const s=p.locator('input[type=password]:visible');
   const b=p.getByRole('button',{name:/^entrar$/i});
   if(await e.count()!==1||await s.count()!==1||await b.count()!==1)throw new ErroTribemd('LOGIN_LAYOUT_NAO_RECONHECIDO');
   await e.fill(email);await s.fill(senha);this.etapa='envio_login';this.observador?.marcarEnvioLogin();this.envioLogin=true;
   await b.click();this.etapa='confirmando_login';
   // SPA: a rota pode mudar antes de menus aparecerem; inputs antigos podem ficar ocultos.
   // Esperar a condição visual completa, sem aguardar todas as chamadas da agenda.
   await p.waitForFunction(`(${codigoEstadoLoginTribemd}).confirmado`,undefined,{timeout:20000,polling:100});
   if(!await this.confirmado())throw new ErroTribemd('LOGIN_NAO_CONFIRMADO');
   await this.finalizarLogin();
  }catch(e){throw await this.erroSeguro(e,'LOGIN_NAO_CONFIRMADO');}
  finally{this.envioLogin=false;email='';senha='';}
 }
 async confirmar(){if(!await this.confirmado())throw await this.erroSeguro(new ErroTribemd('LOGIN_NAO_CONFIRMADO'),'LOGIN_NAO_CONFIRMADO');await this.finalizarLogin();}
 async controle(c:{tipo:'clicar';x:number;y:number}|{tipo:'tecla';tecla:'Tab'|'Enter'|'Backspace'|'Escape'}|{tipo:'rolar';deltaY:number}) {
  const p=this.page;if(!p||this.autenticado||!['/login'].includes(new URL(p.url()).pathname))throw new ErroTribemd('CONTROLE_LOGIN_INDISPONIVEL');
  // Somente concluir verificação humana; Enter não reenvia o formulário de senha.
  if(c.tipo==='clicar')await p.mouse.click(c.x,c.y);
  else if(c.tipo==='rolar')await p.mouse.wheel(0,c.deltaY);
  else if(c.tecla!=='Enter')await p.keyboard.press(c.tecla);
 }
 estaAutenticado(){return this.autenticado&&!this.fechado&&this.browser.isConnected();}
 async ler(pagina:'agenda'|'pacientes',detalhar=false,janela?:{janelaDias:number;agora:Date}):Promise<ResultadoLeituraTribemd> {
  if(!this.autenticado||!this.page)throw new ErroTribemd('LOGIN_NAO_CONFIRMADO');
  const p=this.page;this.etapa='leitura_'+pagina;
  await this.observador?.concluir();this.diagnostico=undefined;
  this.observador=new ObservadorRedeLoginTribemd(p,pagina==='agenda'?'leitura_agenda':'leitura_pacientes');
  try{
   const destino=pagina==='agenda'?agendaTribemd:'/pacientes';
   if(this.leituraFalhou||new URL(p.url()).pathname!==destino){
    const r=await p.goto(origemTribemd+destino,{waitUntil:'domcontentloaded',timeout:25000});
    this.statusHttp=r?.status();if(this.statusHttp&&this.statusHttp>=400)throw new ErroTribemd('LEITURA_HTTP_ERRO');
   }
   if(new URL(p.url()).pathname==='/login'){this.autenticado=false;throw new ErroTribemd('SESSAO_EXPIRADA');}
   const hoje=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(janela?.agora??new Date());
   if(pagina==='agenda'&&(this.agenda?.temRequisicao()||!await p.locator('table:visible,[role=table]:visible').count())){
    this.agenda?.observarExistente(this.observador);
    let detalhes:ResumoDetalhesTribemd|undefined;
    const processar=async(recorte:RecorteAgendaTribemd)=>{
     if(!detalhar)return recorte.consultas;
     const headers=await this.agenda!.cabecalhosLeitura(recorte);
     try{
      const leitura=await detalharConsultasTribemd(p,recorte.consultas,headers,true);
      if(!detalhes)detalhes=leitura.resumo;
      else for(const campo of ['selecionadas','processadas','pendentes','comPendencias'] as const)detalhes[campo]+=leitura.resumo[campo];
      return leitura.consultas;
     }finally{for(const nome of Object.keys(headers))delete headers[nome];}
    };
    const recorte=janela?await this.agenda!.lerJanela(hoje,janela.janelaDias,processar):await this.agenda!.ler(hoje);
    const consultas=janela?recorte.consultas:await processar(recorte);
    const {consultas:_consultas,...agenda}=recorte;
    this.leituraFalhou=false;this.diagnostico=await this.observador.concluir();await this.observarTela();
    return {consultas,agenda,detalhes,cobertura:'intervalo_carregado_pelo_portal',pagina,historicoCompleto:false,
     detalhe:detalhes?`Consultas atendidas e finalizadas: ${detalhes.processadas} de ${detalhes.selecionadas} processadas; ${detalhes.comPendencias} com pendências. Valores não comprovam pagamento. Leitura restrita ao intervalo da agenda.`:`Calendário carregado: ${agenda.totalAtendimentos} atendimentos no intervalo consultado pelo portal. ${consultas.length} consultas concluídas com nome e data reconhecidos no recorte. Não comprova a última consulta do histórico.`};
   }
   if(detalhar)throw new ErroTribemd('DETALHES_EXIGEM_AGENDA_RECONHECIDA');
   await p.locator('table:visible,[role=table]:visible').first().waitFor({timeout:12000});
   // Extrair somente colunas necessárias; não carregar fichas, CPF, telefone ou prontuário.
   const tabelas=await p.evaluate<TabelaConsulta[]>(String.raw`(() => {
    const norm=(s)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[:*]/g,'').trim();
    const permitidos=['nome','nome completo','paciente','cliente','ultima consulta','data da ultima consulta','ultimo atendimento','ultima consulta realizada','data','data da consulta','data do atendimento','status','situacao'];
    return Array.from(document.querySelectorAll('table,[role=table]')).filter(e=>e.getClientRects().length>0).slice(0,5).map(t=>{
     const cab=Array.from(t.querySelectorAll('th,[role=columnheader]')).map(e=>e.textContent?.trim()||'');
     const indices=cab.map((v,i)=>permitidos.includes(norm(v))?i:-1).filter(i=>i>=0);
     const linhas=Array.from(t.querySelectorAll('tr,[role=row]')).filter(r=>r.querySelector('td,[role=cell]')&&r.getClientRects().length>0).slice(0,100).map(r=>{
      const cells=Array.from(r.querySelectorAll('td,[role=cell]'));return indices.map(i=>(cells[i]?.textContent||'').trim().slice(0,200));
     });return {colunas:indices.map(i=>cab[i]),linhas};
    });
   })()`);
   const consultas=lerConsultas(tabelas,hoje);
   this.leituraFalhou=false;this.diagnostico=await this.observador.concluir();await this.observarTela();
   return {consultas,cobertura:'somente_linhas_visiveis',pagina,historicoCompleto:false,detalhe:consultas.length?'Leitura parcial. Consulta realizada observada não comprova que seja a última do histórico.':'Nenhuma data comprovada nas colunas reconhecidas. Isso não significa ausência de consultas; o layout precisa ser confirmado.'};
  }catch(e){this.leituraFalhou=true;if(new URL(p.url()).pathname==='/login'){this.autenticado=false;e=new ErroTribemd('SESSAO_EXPIRADA');}if(e instanceof ErroAgendaTribemd||e instanceof ErroDetalhesTribemd){if(e.codigo==='SESSAO_EXPIRADA')this.autenticado=false;e=new ErroTribemd(e.codigo);}throw await this.erroSeguro(e,'LEITURA_LAYOUT_NAO_RECONHECIDO');}
 }
 async perfil():Promise<EstadoNavegador|undefined>{
  if(!this.autenticado)return undefined;
  const estado=await this.context.storageState();
  // Chaves de autenticação confirmadas no bundle público; não persistir caches de pacientes.
  return {cookies:estado.cookies.filter(c=>c.domain.replace(/^\./,'')==='app.tribemd.com'||c.domain.replace(/^\./,'')==='tribemd.com'),
   origins:estado.origins.filter(o=>o.origin===origemTribemd).map(o=>({origin:o.origin,localStorage:o.localStorage.filter(v=>['bipp-user-token','bipp-instituicao'].includes(v.name))}))};
 }
 async tela():Promise<Buffer|null>{
  if(!this.page||this.fechado)return null;
  try{return await this.page.screenshot({type:'png',timeout:3000,mask:[this.page.locator('input,textarea,[contenteditable=true]')]});}catch{return null;}
 }
 private async erroSeguro(e:unknown,codigo:string) {
  await this.observarTela();
  this.diagnostico=await this.observador?.concluir()||this.diagnostico;
  const httpErro=this.diagnostico?.chamadas.some(c=>c.statusHttp&&c.statusHttp>=400);
  return new ErroTribemd(e instanceof ErroTribemd?e.codigo:httpErro?(this.etapa.startsWith('leitura_')?'LEITURA_HTTP_ERRO':'LOGIN_HTTP_ERRO'):codigo,{etapa:this.etapa,statusHttp:this.statusHttp,rede:this.diagnostico,tela:this.ultimaTela});
 }
 diagnosticar(){return {etapa:this.etapa,statusHttp:this.statusHttp,rede:this.diagnostico,tela:this.ultimaTela};}
 async encerrar(){
  if(!this.fechamento){this.fechado=true;this.agenda?.encerrar();this.fechamento=(async()=>{try{await this.observador?.concluir();await this.browser.close();}finally{await this.display.encerrar();}})();}
  return this.fechamento;
 }
}
