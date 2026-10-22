'use strict';
// Painel do Amplimed (espelho do TribeMD, sem migration). Fala só com /api/conta/cofre/amplimed.
(() => {
  const el = id => document.getElementById(id);
  const card = el('cardCofreAmplimed');
  if (!card) return;
  const modal = el('modalCofreAmplimed'), form = el('formCofreAmplimed');
  let atual = null, timer = null, ocupado = false;
  const token = () => { try { const s = JSON.parse(localStorage.getItem('notomed_sessao') || 'null'); return typeof s?.tokenAcesso === 'string' && s.tokenAcesso ? s.tokenAcesso : null; } catch { return null; } };
  const mensagens = { SESSAO_INVALIDA: 'Sua sessão expirou. Entre novamente no Noto.', COFRE_INDISPONIVEL: 'A conexão do Amplimed está indisponível agora. Tente novamente em instantes.', ENTRADA_INVALIDA: 'Confira o e-mail e a senha.', CREDENCIAL_AUSENTE: 'Informe o acesso do Amplimed.' };
  const avisar = t => { el('cofreAmplimedMensagem').textContent = t; };
  const textos = {
    vazio: 'Conecte sua agenda para o Noto conferir suas consultas. Só leitura.',
    salvo: 'Acesso salvo. Verificando…', conectando: 'Verificando o acesso ao Amplimed…',
    conectado: 'Agenda conectada. O Noto só lê; não altera nada no Amplimed.',
    atencao: 'Não consegui validar o acesso ao Amplimed. Confira a senha ou tente de novo.',
    desconectado: 'Agenda desconectada.'
  };
  function renderizar(s) {
    atual = s;
    const tem = s?.salvo === true;
    const estado = tem && s.estado === 'salvo' ? 'conectando' : (s?.estado || 'vazio');
    el('cofreAmplimedDescricao').textContent = textos[estado] || textos.vazio;
    el('btnCofreAmplimed').textContent = estado === 'conectando' ? 'Verificando…' : tem ? 'Gerenciar' : 'Conectar';
    el('btnCofreAmplimed').disabled = ocupado || estado === 'conectando';
    el('btnCofreAmplimedReverificar').hidden = !tem || estado === 'conectado';
    el('btnCofreAmplimedExcluir').hidden = !tem;
  }
  async function api(metodo = 'GET', sufixo = '', corpo) {
    const t = token();
    if (!t) throw Error(mensagens.SESSAO_INVALIDA);
    const r = await fetch('/api/conta/cofre/amplimed' + sufixo, { method: metodo, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Bearer ' + t, ...(metodo === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Noto-Cofre': '1' }) }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    const d = await r.json();
    if (!r.ok || !d.ok) throw Error(mensagens[d.codigo] || 'Não foi possível concluir a operação.');
    return d;
  }
  function agendar() { clearTimeout(timer); timer = null; if (atual?.salvo && (atual.estado === 'salvo' || atual.estado === 'conectando')) timer = setTimeout(() => void atualizar(), 3000); }
  async function atualizar() { if (!token()) return; try { const d = await api(); avisar(''); renderizar(d.cofre); agendar(); } catch (e) { avisar(e.message); } }
  async function agir(fn) {
    if (ocupado) return; ocupado = true; avisar(''); renderizar(atual);
    try { const d = await fn(); renderizar(d.cofre); agendar(); } catch (e) { avisar(e.message); } finally { ocupado = false; renderizar(atual); }
  }
  el('btnCofreAmplimed').onclick = () => { form.reset(); el('cofreAmplimedModalMensagem').textContent = ''; modal.showModal(); };
  el('fecharModalCofreAmplimed').onclick = () => modal.close();
  el('btnCofreAmplimedReverificar').onclick = () => void agir(() => api('POST', '/reconectar', {}));
  el('btnCofreAmplimedExcluir').onclick = () => { if (confirm('Excluir o acesso do Amplimed? O e-mail e a senha salvos serão apagados.')) void agir(() => api('DELETE', '', {})); };
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (ocupado || !form.reportValidity()) return;
    const dados = { email: form.elements.email.value.trim(), senha: form.elements.senha.value, consentimento: 'amplimed-leitura-v1' };
    form.reset(); modal.close();
    try { await agir(() => api('POST', '', dados)); } finally { dados.email = ''; dados.senha = ''; }
  });
  modal.addEventListener('close', () => form.reset());
  window.NotoCofreAmplimed = { atualizar };
  void atualizar();
  setInterval(() => { if (!atual && token()) void atualizar(); }, 4000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void atualizar(); });
})();
