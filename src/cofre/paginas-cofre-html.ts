/**
 * Geração pura das páginas HTML seguras do cofre (`/c/...`): agenda adaptativa
 * ou descoberta online, cadastro de múltiplos profissionais (Nome, CRM, RQE),
 * certificado A1 individual por profissional e fallback de XML de referência.
 */

export function htmlSeguro(valor: string): string {
  return valor.replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch] ?? '');
}

const ESTILO_BASE = `<style>:root{--bg:#F4F4F5;--text:#121C22;--text-secondary:rgba(18,28,34,0.72);--primary:#000000;--primary-hover:#202020;--font-family:"Geist",sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-family);font-size:15px;line-height:22px;min-height:100dvh;display:grid;place-items:center;padding:24px}
main{width:100%;max-width:440px;text-align:center}header{font-weight:600;letter-spacing:-1px;font-size:30px;margin-bottom:32px}
.marca{width:48px;height:48px;margin:0 auto 18px;border:1px solid rgba(18,28,34,.15);border-radius:50%;display:grid;place-items:center}
h1{font-size:22px;line-height:30px;font-weight:500;margin:0 0 10px}p{color:var(--text-secondary);margin:0 0 22px}
form{text-align:left;margin-top:8px}.bloco{background:#fff;border:1px solid rgba(18,28,34,.12);border-radius:14px;padding:16px;margin-bottom:14px}
.bloco-topo{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:13px;font-weight:600}
.campo{display:block;margin-bottom:14px}.campo span{display:block;font-weight:500;margin-bottom:6px;font-size:14px}
.campo input{width:100%;padding:14px;font:inherit;font-size:16px;border:1px solid rgba(18,28,34,.2);border-radius:12px;background:#fff;color:var(--text)}
.linha-2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.autoriza{display:flex;gap:10px;align-items:flex-start;margin:16px 0 22px;color:var(--text-secondary);font-size:14px}
.autoriza input{width:18px;height:18px;margin-top:2px;flex:none;accent-color:var(--primary)}
.btn-action{display:block;text-decoration:none;background:var(--primary);color:#fff;border-radius:12px;padding:15px 18px;font:inherit;font-weight:500;border:none;width:100%;cursor:pointer}
.btn-action:hover{background:var(--primary-hover)}.btn-action:disabled{opacity:.55;cursor:not-allowed}
.btn-sec{display:block;background:#fff;color:var(--text);border:1px solid rgba(18,28,34,.22);border-radius:12px;padding:12px 16px;font:inherit;font-weight:500;width:100%;cursor:pointer;margin-bottom:14px}
.btn-remover{background:none;border:none;color:#b42318;font:inherit;font-size:13px;cursor:pointer;padding:0}
.alerta{background:#ffebeb;color:#b42318;padding:12px 14px;border-radius:12px;margin-bottom:14px;font-size:14px;display:none}
.host-pill{display:inline-block;background:#fff;border:1px solid rgba(18,28,34,.15);border-radius:999px;padding:4px 12px;font-size:13px;color:var(--text);margin-bottom:18px}
.nota{font-size:13px;margin:18px 0 0}</style>`;

const MARCA_SVG = `<div class="marca" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="m6 12 4 4 8-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;

export function envolverPaginaCofre(titulo: string, corpo: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${htmlSeguro(titulo)} | Noto</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet">${ESTILO_BASE}</head>
<body><main><header aria-label="Noto">noto</header>${MARCA_SVG}${corpo}</main></body></html>`;
}

export function renderizarPaginaAgendaAdaptativa(entrada: {
  nomeAgenda: string;
  hostPortal: string | null;
  consentimento: string;
}): string {
  const nome = htmlSeguro(entrada.nomeAgenda);
  const host = entrada.hostPortal ? `<div class="host-pill">Portal verificado: ${htmlSeguro(entrada.hostPortal)}</div>` : '';
  return envolverPaginaCofre(
    `Conectar ${entrada.nomeAgenda}`,
    `<h1>Conectar agenda ${nome}</h1>
<p>Informe o login e a senha da sua agenda. Os dados são criptografados neste cofre seguro.</p>
${host}
<form method="post" onsubmit="this.action=location.pathname+'/enviar'">
<label class="campo"><span>E-mail ou usuário</span><input name="email" type="text" maxlength="254" required autocomplete="username"></label>
<label class="campo"><span>Senha</span><input name="senha" type="password" maxlength="256" required autocomplete="current-password"></label>
<label class="autoriza"><input name="consentimento" type="checkbox" value="${htmlSeguro(entrada.consentimento)}" required><span>Autorizo o Noto a ler minha agenda ${nome} em modo somente leitura.</span></label>
<button class="btn-action" type="submit">Salvar e conectar</button>
</form>`
  );
}

export function renderizarPaginaCadastroProfissionais(existentes: readonly string[] = []): string {
  const resumo = existentes.length
    ? `<p>Profissionais já cadastrados: ${htmlSeguro(existentes.join(', '))}.</p>`
    : '';
  return envolverPaginaCofre(
    'Cadastrar profissionais',
    `<h1>Profissionais da conta</h1>
<p>Informe o nome completo, CRM com UF e RQE (se houver) de cada profissional que emitirá notas por este WhatsApp.</p>
${resumo}
<div id="alertaForm" class="alerta" role="alert"></div>
<form id="formProfissionais" method="post" onsubmit="return enviarProfissionais(event)">
  <div id="listaProfissionais">
    <div class="bloco" data-item>
      <div class="bloco-topo"><span>Profissional 1</span></div>
      <label class="campo"><span>Nome completo *</span><input name="nome" type="text" required placeholder="Ex.: Dra. Maria Souza" maxlength="150" autocomplete="name"></label>
      <div class="linha-2">
        <label class="campo"><span>CRM com UF *</span><input name="crm" type="text" required placeholder="12345/SP" maxlength="40" autocomplete="off"></label>
        <label class="campo"><span>RQE (opcional)</span><input name="rqe" type="text" placeholder="Ex.: 67890" maxlength="12" inputmode="numeric" autocomplete="off"></label>
      </div>
    </div>
  </div>
  <button type="button" class="btn-sec" id="btnAddProfissional" onclick="adicionarLinha()">+ Adicionar outro profissional</button>
  <button type="submit" class="btn-action" id="btnSalvarProfissionais">Salvar e continuar no WhatsApp</button>
</form>
<script>
function atualizarTitulos(){
  document.querySelectorAll('#listaProfissionais [data-item]').forEach(function(el,idx){
    el.querySelector('.bloco-topo span').textContent='Profissional '+(idx+1);
  });
}
function adicionarLinha(){
  var lista=document.getElementById('listaProfissionais');
  if(lista.children.length>=20)return;
  var div=document.createElement('div');
  div.className='bloco';div.setAttribute('data-item','');
  div.innerHTML='<div class="bloco-topo"><span></span><button type="button" class="btn-remover" onclick="this.closest(\\'[data-item]\\').remove();atualizarTitulos()">Remover</button></div>'
    +'<label class="campo"><span>Nome completo *</span><input name="nome" type="text" required placeholder="Ex.: Dr. João Pereira" maxlength="150"></label>'
    +'<div class="linha-2"><label class="campo"><span>CRM com UF *</span><input name="crm" type="text" required placeholder="12345/SP" maxlength="40"></label>'
    +'<label class="campo"><span>RQE (opcional)</span><input name="rqe" type="text" placeholder="Opcional" maxlength="12" inputmode="numeric"></label></div>';
  lista.appendChild(div);atualizarTitulos();
}
async function enviarProfissionais(ev){
  ev.preventDefault();
  var alerta=document.getElementById('alertaForm'),btn=document.getElementById('btnSalvarProfissionais');
  alerta.style.display='none';btn.disabled=true;btn.textContent='Salvando...';
  var itens=[];
  document.querySelectorAll('#listaProfissionais [data-item]').forEach(function(el){
    itens.push({nome:el.querySelector('[name="nome"]').value,crm:el.querySelector('[name="crm"]').value,rqe:el.querySelector('[name="rqe"]').value});
  });
  try{
    var r=await fetch(location.pathname+'/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profissionais:itens})});
    var html=await r.text();
    if(r.ok){document.open();document.write(html);document.close();return false;}
    alerta.textContent=html.indexOf('<')===-1?html:'Confira nome completo e CRM com UF (ex.: 12345/SP).';
    alerta.style.display='block';
  }catch(e){alerta.textContent='Falha de conexão. Tente novamente.';alerta.style.display='block';}
  finally{btn.disabled=false;btn.textContent='Salvar e continuar no WhatsApp';}
  return false;
}
</script>`
  );
}

export function renderizarPaginaCertificadoProfissional(entrada: {
  nomeProfissional: string;
  versaoConsentimento: string;
}): string {
  const nome = htmlSeguro(entrada.nomeProfissional);
  const versao = htmlSeguro(entrada.versaoConsentimento);
  return envolverPaginaCofre(
    `Certificado A1 — ${entrada.nomeProfissional}`,
    `<h1>Certificado Digital A1</h1>
<p>Envie o certificado A1 de <strong>${nome}</strong>. Assim que salvar, puxaremos automaticamente os dados tributários e continuaremos pelo WhatsApp.</p>
<div id="alertaCert" class="alerta" role="alert"></div>
<form id="formCert" onsubmit="return enviarCertificado(event)">
  <label class="campo"><span>Arquivo .pfx ou .p12 *</span><input id="arquivoPfx" type="file" accept=".pfx,.p12" required></label>
  <label class="campo"><span>Senha do certificado *</span><input id="senhaPfx" type="password" required autocomplete="off" maxlength="256"></label>
  <label class="autoriza"><input id="aceiteFiscal" type="checkbox" required><span>Autorizo o Noto a guardar o certificado A1 de ${nome} criptografado e consultar a última NFS-e para configurar os dados tributários.</span></label>
  <button type="submit" class="btn-action" id="btnEnviarCert">Salvar certificado A1</button>
</form>
<script>
async function enviarCertificado(ev){
  ev.preventDefault();
  var alerta=document.getElementById('alertaCert'),btn=document.getElementById('btnEnviarCert');
  var arq=document.getElementById('arquivoPfx').files[0],senha=document.getElementById('senhaPfx').value;
  if(!arq||!senha){alerta.textContent='Selecione o arquivo .pfx/.p12 e informe a senha.';alerta.style.display='block';return false;}
  alerta.style.display='none';btn.disabled=true;btn.textContent='Validando certificado...';
  try{
    var base64=await new Promise(function(res,rej){
      var rd=new FileReader();
      rd.onload=function(){res(String(rd.result||'').split(',')[1]||'');};
      rd.onerror=rej;rd.readAsDataURL(arq);
    });
    var r=await fetch(location.pathname+'/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({arquivoBase64:base64,senha:senha,consentimentoFiscal:'${versao}'})});
    var txt=await r.text();
    if(r.ok){document.open();document.write(txt);document.close();return false;}
    alerta.textContent=txt.indexOf('<')===-1?txt:'Certificado A1 ou senha inválidos. Confira e tente novamente.';
    alerta.style.display='block';
  }catch(e){alerta.textContent='Não foi possível enviar o certificado agora.';alerta.style.display='block';}
  finally{btn.disabled=false;btn.textContent='Salvar certificado A1';}
  return false;
}
</script>`
  );
}

export function renderizarPaginaXmlProfissional(nomeProfissional: string): string {
  const nome = htmlSeguro(nomeProfissional);
  return envolverPaginaCofre(
    `XML de referência — ${nomeProfissional}`,
    `<h1>XML de nota anterior</h1>
<p>Envie o arquivo XML de uma NFS-e já emitida por <strong>${nome}</strong> para extrairmos a configuração tributária.</p>
<div id="alertaXml" class="alerta" role="alert"></div>
<form onsubmit="return enviarXml(event)">
  <label class="campo"><span>Arquivo XML (.xml) *</span><input id="arquivoXml" type="file" accept=".xml,application/xml,text/xml" required></label>
  <button type="submit" class="btn-action" id="btnEnviarXml">Importar XML</button>
</form>
<script>
async function enviarXml(ev){
  ev.preventDefault();
  var alerta=document.getElementById('alertaXml'),btn=document.getElementById('btnEnviarXml');
  var arq=document.getElementById('arquivoXml').files[0];
  if(!arq){alerta.textContent='Selecione um arquivo XML válido.';alerta.style.display='block';return false;}
  alerta.style.display='none';btn.disabled=true;btn.textContent='Importando...';
  try{
    var xmlString=await arq.text();
    var r=await fetch(location.pathname+'/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({xmlString:xmlString})});
    var txt=await r.text();
    if(r.ok){document.open();document.write(txt);document.close();return false;}
    alerta.textContent=txt.indexOf('<')===-1?txt:'Não foi possível ler o XML enviado.';
    alerta.style.display='block';
  }catch(e){alerta.textContent='Falha de conexão ao importar o XML.';alerta.style.display='block';}
  finally{btn.disabled=false;btn.textContent='Importar XML';}
  return false;
}
</script>`
  );
}

export function renderizarPaginaConcluida(entrada: {
  titulo: string;
  mensagem: string;
  telefoneAssistente?: string | null;
}): string {
  const destino = entrada.telefoneAssistente && /^\d{10,15}$/.test(entrada.telefoneAssistente)
    ? `https://wa.me/${entrada.telefoneAssistente}`
    : 'whatsapp://';
  return envolverPaginaCofre(
    entrada.titulo,
    `<h1>${htmlSeguro(entrada.titulo)}</h1>
<p>${htmlSeguro(entrada.mensagem)}</p>
<a class="btn-action" href="${destino}">Voltar para o WhatsApp</a>
<p class="nota">Você pode fechar esta página. O Noto continua com você no WhatsApp.</p>`
  );
}
