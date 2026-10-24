import { chromium, type Browser, type Page } from 'playwright-core';
import { dataDoCabecalhoAmplimed, lerDetalheAmplimedTexto } from '../agenda/amplimed-leitor.js';
import { statusAmplimedPorCor } from '../agenda/amplimed-mapeamento.js';
import { dominioAprovado } from '../agenda/agendas-suportadas.js';
import type { EstadoNavegador } from './tribemd-perfil.js';

export const loginAmplimed = 'https://app.amplimed.com.br/';
export type CodigoLoginAmplimed = 'CONECTADO' | 'SENHA_RECUSADA' | 'PRECISA_VERIFICACAO' | 'CAPTCHA' | 'FORMULARIO_NAO_RECONHECIDO' | 'TEMPO_ESGOTADO' | 'NAVEGADOR_INDISPONIVEL';

const acaoNoCaminho = /(?:^|\/)(?:logout|sair|delete|remove|update|create|save|excluir|salvar|editar|novo|cancelar|deletar)(?:\/|$)/i;

/** Guarda de rede. Só HTTPS; escrita (POST) apenas uma vez, para o domínio aprovado, e só quando o envio do login foi liberado. */
export function permitirRequisicaoAmplimed(url: string, metodo: string, tipo: string, envioLoginLiberado: boolean): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (tipo === 'websocket') return false;
  // O login redireciona para http:// do próprio domínio e o servidor sobe para https: GET/HEAD sem corpo.
  const httpDoDominio = u.protocol === 'http:' && ['GET', 'HEAD'].includes(metodo.toUpperCase()) && dominioAprovado('amplimed', 'https://' + u.host + u.pathname);
  if (u.protocol !== 'https:' && !httpDoDominio) return false;
  const aprovado = u.protocol === 'https:' && dominioAprovado('amplimed', url) || httpDoDominio;
  const m = metodo.toUpperCase();
  // reCAPTCHA do formulário de login precisa trocar token; não leva credencial.
  if (m === 'POST' && u.hostname === 'www.google.com' && u.pathname.startsWith('/recaptcha/')) return true;
  // Formulário Livewire do login: sincroniza campos e envia pelo mesmo caminho. O teto de POSTs fica na rota.
  if (m === 'POST' && u.hostname === 'auth.amplimed.com.br' && u.pathname === '/livewire/update') return true;
  if (m === 'POST') return aprovado && envioLoginLiberado && !acaoNoCaminho.test(u.pathname);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(m)) return false;
  if (aprovado && acaoNoCaminho.test(u.pathname) && tipo === 'document') return false;
  return true;
}

export interface TelaAmplimed { url: string; texto: string; senhasVisiveis: number }
/** Classificação pura da tela depois do envio do login. Nunca devolve texto da página. */
/** Convite opcional para ativar 2FA (não é desafio): a conta ainda não tem 2FA. */
export function conviteDoisFatoresAmplimed(t: TelaAmplimed): boolean {
  const texto = t.texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /ativar agora|proteja sua conta/.test(texto) && !/digite o codigo|enviamos (um )?codigo|codigo de (verificacao|seguranca)/.test(texto);
}
/** Convite de 2FA que a conta não pode mais dispensar ("passa a ser obrigatória"): é impedimento real, não espera. */
export function conviteDoisFatoresObrigatorio(t: TelaAmplimed): boolean {
  const texto = t.texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return conviteDoisFatoresAmplimed(t) && /obrigat/.test(texto);
}
/** Desafio real de 2FA depois do enrollment (tela /twofactor): exige o código transitório enviado por e-mail/SMS. Não é o convite de ativação. */
export function desafioDoisFatoresAmplimed(t: TelaAmplimed): boolean {
  let caminho = '';
  try { caminho = new URL(t.url).pathname; } catch { /* sem caminho */ }
  if (/^\/twofactor(\/|$)/.test(caminho)) return true;
  const texto = t.texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /verificar codigo de autenticacao/.test(texto) || /codigo foi enviado para .+via (e-?mail|sms)/.test(texto);
}
/** Filtra o storageState para só o que pertence ao Amplimed (cookies e origens do domínio). */
export function filtrarEstadoAmplimed(estado: EstadoNavegador): EstadoNavegador {
  const dominio = (h: string) => /(^|\.)amplimed\.com\.br$/.test(h.replace(/^\./, ''));
  return { cookies: estado.cookies.filter(c => dominio(c.domain)),
    origins: estado.origins.filter(o => { try { return dominio(new URL(o.origin).hostname); } catch { return false; } }) };
}
export function classificarTelaAmplimed(t: TelaAmplimed): CodigoLoginAmplimed | 'AGUARDANDO' {
  const texto = t.texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  let caminho = '';
  try { caminho = new URL(t.url).pathname; } catch { /* sem caminho */ }
  if (/^\/2fa(\/|$)/.test(caminho)) return conviteDoisFatoresAmplimed(t) ? (conviteDoisFatoresObrigatorio(t) ? 'PRECISA_VERIFICACAO' : 'AGUARDANDO') : 'PRECISA_VERIFICACAO';
  if (desafioDoisFatoresAmplimed(t)) return 'PRECISA_VERIFICACAO';
  if (/recaptcha|nao sou (um )?robo|i'm not a robot/.test(texto) && t.senhasVisiveis > 0) return 'CAPTCHA';
  if (/codigo de (verificacao|seguranca|acesso)|verificacao em (duas|2) etapas|enviamos (um )?codigo|digite o codigo/.test(texto)) return 'PRECISA_VERIFICACAO';
  if (t.senhasVisiveis === 0 && /^\/(agenda|painel|consultas|buscapac)/.test(caminho)) return 'CONECTADO';
  if (t.senhasVisiveis > 0 && /(senha|usuario|e-?mail|login|credenciais?).{0,40}(invalid|incorret|errad|nao confere)|(invalid|incorret|errad).{0,40}(senha|usuario|e-?mail|login)/.test(texto)) return 'SENHA_RECUSADA';
  return 'AGUARDANDO';
}

/**
 * Login de observação: abre o login, envia uma vez, devolve só o estado. Não lê agenda, não grava sessão.
 * A credencial vive só nesta função e é descartada ao sair.
 */
const ultimosBloqueadosAmplimed: string[] = [];
/** Preenche o desafio de 2FA: seis caixas de um dígito (ou um campo único) e o botão "Confirmar". Nunca registra o código. */
async function preencherCodigo2fa(page: Page, codigo: string): Promise<boolean> {
  const caixas = page.locator('main input:visible, form input:visible');
  let indices: number[] = [];
  try {
    const total = await caixas.count();
    for (let i = 0; i < total; i++) {
      const el = caixas.nth(i);
      const tipo = (await el.getAttribute('type') ?? 'text').toLowerCase();
      if (['password', 'hidden', 'checkbox', 'radio', 'submit', 'button', 'file'].includes(tipo)) continue;
      indices.push(i);
    }
  } catch { return false; }
  try {
    if (indices.length >= 6) {
      for (let i = 0; i < 6; i++) await caixas.nth(indices[i]!).fill(codigo[i]!);
    } else if (indices.length === 1) {
      await caixas.nth(indices[0]!).fill(codigo);
    } else return false;
    await page.getByRole('button', { name: /^confirmar$/i }).first().click({ timeout: 5000 });
    return true;
  } catch { return false; }
}
export async function verificarLoginAmplimed(opcoes: { executavel: string; email: string; senha: string; tempoMs?: number;
  /** Sessão anterior reutilizável (cookies do domínio); evita novo login enquanto o Amplimed a aceitar. */
  estado?: EstadoNavegador;
  /** Chamado com a sessão filtrada do domínio quando o login termina CONECTADO. */
  aoSalvarEstado?: (estado: EstadoNavegador) => void | Promise<void>;
  /** Fallback assistido do desafio de 2FA: devolve UM código transitório de 6 dígitos, ou null se ninguém respondeu. */
  aoPedirCodigo2fa?: () => Promise<string | null>;
  aoConectar?: (page: Page) => Promise<void> }, signal?: AbortSignal): Promise<CodigoLoginAmplimed> {
  let browser: Browser | undefined;
  let { email, senha } = opcoes;
  try {
    try {
      browser = await chromium.launch({ executablePath: opcoes.executavel, headless: true, timeout: 20000,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-logging', '--disable-breakpad', '--disable-crash-reporter', '--disable-sync', '--password-store=basic'] });
    } catch { return 'NAVEGADOR_INDISPONIVEL'; }
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: false, serviceWorkers: 'block', ...(opcoes.estado ? { storageState: opcoes.estado } : {}) });
    await context.routeWebSocket('**/*', ws => { void ws.close(); });
    let envio = false;
    const bloqueados: string[] = ultimosBloqueadosAmplimed; bloqueados.length = 0;
    let postsLogin = 0;
    await context.route('**/*', async route => {
      const r = route.request();
      let ok = false;
      try { ok = permitirRequisicaoAmplimed(r.url(), r.method(), r.resourceType(), envio); } catch { /* bloqueia */ }
      if (ok && r.method().toUpperCase() === 'POST' && dominioAprovado('amplimed', r.url()) && ++postsLogin > 20) { envio = false; await route.abort('blockedbyclient'); return; }
      if (!ok) { if (r.method().toUpperCase() !== 'GET' || r.resourceType() === 'document') { try { const u = new URL(r.url()); bloqueados.push(r.method() + ' ' + u.host + u.pathname.slice(0, 40)); } catch { /* ignora */ } } await route.abort('blockedbyclient'); return; }
      await route.fallback();
    });
    const respostas: string[] = [];
    const page: Page = await context.newPage();
    page.on('response', r => { try { const u = new URL(r.url()); if (r.request().resourceType() === 'document' || r.request().method() !== 'GET') respostas.push(r.request().method() + ' ' + u.host + u.pathname.split('/').slice(0, 3).join('/') + ' ' + r.status()); } catch { /* ignora */ } });
    page.setDefaultTimeout(12000);
    context.on('page', p => { if (p !== page) void p.close().catch(() => {}); });
    const limite = Date.now() + (opcoes.tempoMs ?? 40000);
    signal?.throwIfAborted();
    await page.goto(loginAmplimed, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Sessão reutilizada: com cookies válidos a raiz já cai na área logada, sem formulário.
    if (opcoes.estado) {
      await page.waitForTimeout(2500);
      try {
        const tela0 = await page.evaluate(`(() => ({ url: location.href, texto: (document.body?.innerText || '').slice(0, 4000), senhasVisiveis: [...document.querySelectorAll('input[type=password]')].filter(e => e.offsetParent !== null).length }))()`) as TelaAmplimed;
        if (classificarTelaAmplimed(tela0) === 'CONECTADO') {
          console.warn('AMPLIMED_SESSAO reutilizada');
          if (opcoes.aoConectar) { try { await opcoes.aoConectar(page); } catch { console.warn('AMPLIMED_LEITURA etapa=falha'); } }
          if (opcoes.aoSalvarEstado) { try { await opcoes.aoSalvarEstado(filtrarEstadoAmplimed(await context.storageState())); } catch { console.warn('AMPLIMED_SESSAO salvar_falhou'); } }
          return 'CONECTADO';
        }
      } catch { /* navegação em andamento: segue para o login com credencial */ }
      console.warn('AMPLIMED_SESSAO nao_reutilizada');
    }
    const campoSenha = page.locator('input[type=password]:visible').first();
    try { await campoSenha.waitFor({ state: 'visible', timeout: 15000 }); } catch { console.warn('AMPLIMED_LOGIN etapa=senha_nao_apareceu'); return 'FORMULARIO_NAO_RECONHECIDO'; }
    // Formulário atual (auth.amplimed.com.br/login): um campo de texto, um de senha e o botão "Entrar".
    const campoEmail = page.locator('input:not([type=password]):not([type=hidden]):not([type=checkbox]):visible').first();
    if (!await campoEmail.count()) { console.warn('AMPLIMED_LOGIN etapa=sem_campo_email'); return 'FORMULARIO_NAO_RECONHECIDO'; }
    const botao = page.locator('button[type=submit], input[type=submit]').or(page.getByRole('button', { name: /^(entrar|acessar)$/i })).first();
    let usarEnter = false;
    try { await botao.waitFor({ state: 'visible', timeout: 4000 }); } catch { usarEnter = true; console.warn('AMPLIMED_LOGIN etapa=botao_invisivel_usa_enter'); }
    // O formulário Livewire sincroniza os campos com POSTs ao preencher: liberar durante o login, com teto.
    envio = true;
    await campoEmail.fill(email); await campoSenha.fill(senha);
    email = ''; senha = '';
    if (usarEnter) await campoSenha.press('Enter'); else await botao.click();
    let convitePulado = 0, tentativasCodigo = 0;
    while (Date.now() < limite) {
      signal?.throwIfAborted();
      await page.waitForTimeout(1500);
      let tela: TelaAmplimed;
      try {
        tela = await page.evaluate(`(() => ({ url: location.href, texto: (document.body?.innerText || '').slice(0, 4000), senhasVisiveis: [...document.querySelectorAll('input[type=password]')].filter(e => e.offsetParent !== null).length }))()`) as TelaAmplimed;
      } catch { continue; } // navegação em andamento: lê de novo na próxima volta
      if (conviteDoisFatoresObrigatorio(tela)) { console.warn('AMPLIMED_2FA_OBRIGATORIO'); return 'PRECISA_VERIFICACAO'; }
      if (convitePulado < 2 && conviteDoisFatoresAmplimed(tela)) {
        convitePulado++;
        const rotulos = await page.evaluate(`[...document.querySelectorAll('a,button')].map(e => (e.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40)).filter(Boolean).slice(0, 12)`) as string[];
        console.warn('AMPLIMED_2FA_CONVITE controles=' + JSON.stringify(rotulos));
        const saida = rotulos.find(r => /^(agora nao|agora não|depois|mais tarde|pular|lembrar depois|continuar sem)/i.test(r));
        try {
          if (saida && convitePulado === 1) await page.getByText(saida, { exact: false }).first().click({ timeout: 5000 });
          else await page.goto('https://app.amplimed.com.br/agenda', { waitUntil: 'domcontentloaded', timeout: 20000 });
        } catch { /* a próxima volta classifica */ }
        await page.waitForTimeout(5000);
        console.warn('AMPLIMED_2FA_APOS_CLIQUE posts=' + postsLogin + ' respostas=' + JSON.stringify(respostas.slice(-8)) + ' bloqueados=' + JSON.stringify(bloqueados.slice(-4)));
        continue;
      }
      if (desafioDoisFatoresAmplimed(tela)) {
        if (!opcoes.aoPedirCodigo2fa || tentativasCodigo >= 2) { console.warn('AMPLIMED_2FA_DESAFIO sem_canal_codigo'); return 'PRECISA_VERIFICACAO'; }
        tentativasCodigo++;
        console.warn('AMPLIMED_2FA_DESAFIO pedindo_codigo tentativa=' + tentativasCodigo);
        const codigo = await opcoes.aoPedirCodigo2fa().catch(() => null);
        if (!codigo || !/^\d{6}$/.test(codigo)) { console.warn('AMPLIMED_2FA_DESAFIO sem_resposta'); return 'PRECISA_VERIFICACAO'; }
        if (!await preencherCodigo2fa(page, codigo)) { console.warn('AMPLIMED_2FA_DESAFIO formulario_nao_reconhecido'); return 'FORMULARIO_NAO_RECONHECIDO'; }
        await page.waitForTimeout(3000);
        continue;
      }
      const c = classificarTelaAmplimed(tela);
      if (c === 'PRECISA_VERIFICACAO') console.warn('AMPLIMED_2FA tela=' + JSON.stringify(tela.texto.replace(/\s+/g, ' ').replace(/\d{6,}/g, '#').slice(0, 350)));
      if (c === 'CONECTADO' && opcoes.aoConectar) { try { await opcoes.aoConectar(page); } catch { console.warn('AMPLIMED_LEITURA etapa=falha'); } }
      if (c === 'CONECTADO' && opcoes.aoSalvarEstado) { try { await opcoes.aoSalvarEstado(filtrarEstadoAmplimed(await context.storageState())); } catch { console.warn('AMPLIMED_SESSAO salvar_falhou'); } }
      if (c !== 'AGUARDANDO') return c;
    }
    console.warn('AMPLIMED_LOGIN etapa=tempo_esgotado url=' + (() => { try { const u = new URL(page.url()); return u.host + u.pathname.split('/').slice(0, 2).join('/'); } catch { return '?'; } })() + ' bloqueados=' + JSON.stringify(bloqueados.filter(b => !/clarity|doubleclick|analytics|hubspot|google\.com\/(g|ccm|rmkt)/.test(b)).slice(0, 8)));
    return 'TEMPO_ESGOTADO';
  } catch (erro) { console.warn('AMPLIMED_LOGIN etapa=excecao msg=' + String((erro as Error)?.message ?? erro).split('\n')[0]!.slice(0, 160)); return 'TEMPO_ESGOTADO'; }
  finally { email = ''; senha = ''; await browser?.close().catch(() => {}); }
}

export interface EventoAgendaAmplimed { texto: string; cor: string; detalhe?: import('../agenda/amplimed-leitor.js').DetalheAmplimed | null }
export interface DiaAgendaAmplimed { data: string; eventos: EventoAgendaAmplimed[] }
/**
 * Leitura de observação da agenda (somente leitura, nada vira nota). Faz login com a credencial recebida, abre /agenda
 * e lê o dia de hoje e, se pedido, `diasAtras` dias anteriores clicando em "prev" (navegação do calendário).
 * Em cada passo confere a data do cabeçalho; se não bater, para e devolve só o que foi confirmado.
 */
export async function lerEventosAgendaAmplimed(opcoes: { executavel: string; email: string; senha: string; tempoMs?: number; diasAtras?: number; detalhes?: boolean }, signal?: AbortSignal): Promise<{ codigo: CodigoLoginAmplimed; dias: DiaAgendaAmplimed[]; profissional: string | null; completo: boolean }> {
  const dias: DiaAgendaAmplimed[] = [];
  let profissional: string | null = null;
  let completo = false;
  const cabecalho = async (page: Page) => dataDoCabecalhoAmplimed(await page.evaluate(`(document.querySelector('.fc-toolbar')?.innerText || '').slice(0, 300)`) as string);
  const eventosDaTela = async (page: Page) => await page.evaluate(`[...document.querySelectorAll('.fc-time-grid-event')].map(e => ({ texto: (e.innerText || '').trim().slice(0, 400), cor: e.style.backgroundColor || '' }))`) as EventoAgendaAmplimed[];
  // Painel "Visualizar Agendamento": só leitura (clica no compromisso, lê o texto, fecha). Só para compromissos finalizados (verde).
  const comDetalhes = async (page: Page, eventos: EventoAgendaAmplimed[]) => {
    if (!opcoes.detalhes) return eventos;
    const verdes = eventos.map((e, i) => ({ e, i })).filter(x => statusAmplimedPorCor(x.e.cor) === 'realizada');
    for (const { e, i } of verdes) {
      try {
        await page.locator('.fc-time-grid-event').nth(i).click({ timeout: 5000 });
        await page.waitForTimeout(2500);
        const painel = await page.evaluate(`(() => { const m = [...document.querySelectorAll('.modal.show,.modal.in,.popover,[role=dialog],.swal2-popup,.offcanvas.show')].find(x => /Visualizar Agendamento/.test(x.innerText || '')); return m ? m.innerText.slice(0, 1500) : ''; })()`) as string;
        const nome = (e.texto.split('\n').map(x => x.trim()).find(x => x.includes('|')) ?? '').split('|')[0]!.trim();
        e.detalhe = painel ? lerDetalheAmplimedTexto(painel, nome) : null;
        if (!e.detalhe) console.warn('AMPLIMED_DETALHE ' + (painel ? 'painel_sem_tomador valido' : 'sem_painel') + ' nome_len=' + nome.length);
        await page.keyboard.press('Escape'); await page.waitForTimeout(800);
        await page.evaluate(`(() => { const x = document.querySelector('.modal.show .close, .modal.in .close'); if (x) x.click(); })()`);
        await page.waitForTimeout(500);
      } catch { e.detalhe = null; }
    }
    return eventos;
  };
  const total = Math.max(0, Math.min(31, opcoes.diasAtras ?? 0));
  const codigo = await verificarLoginAmplimed({ ...opcoes, tempoMs: opcoes.tempoMs ?? 40000 + total * 6000, aoConectar: async page => {
    if (!/\/agenda/.test(page.url())) await page.goto('https://app.amplimed.com.br/agenda', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('.fc-event, .fc-time-grid', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    profissional = await page.evaluate(`(() => { const t = (document.querySelector('.fc-head')?.innerText || '').split('\\n').map(x => x.trim()).filter(x => x && !/\\d{4}/.test(x)); return t[0] ? t[0].slice(0, 120) : null; })()`) as string | null;
    let data: string | null = await cabecalho(page);
    if (!data) { console.warn('AMPLIMED_PERIODO cabecalho_ilegivel texto=' + JSON.stringify(await page.evaluate(`(document.querySelector('.fc-toolbar')?.innerText || '').slice(0, 120)`))); return; }
    dias.push({ data, eventos: await comDetalhes(page, await eventosDaTela(page)) });
    for (let i = 0; i < total; i++) {
      const anterior: string = data;
      await page.locator('.fc-prev-button').first().click({ timeout: 5000 });
      let atual: string = anterior;
      for (let t = 0; t < 8 && atual === anterior; t++) { await page.waitForTimeout(500); atual = await cabecalho(page) ?? anterior; }
      if (atual === anterior) { console.warn('AMPLIMED_PERIODO nao_navegou passo=' + i + ' data=' + anterior + ' bloqueados=' + JSON.stringify(ultimosBloqueadosAmplimed.slice(-4))); return; } // não navegou: não afirma o que não leu
      await page.waitForTimeout(1200);
      data = atual;
      dias.push({ data: atual, eventos: await comDetalhes(page, await eventosDaTela(page)) });
    }
    completo = true;
  } }, signal);
  return { codigo, dias, profissional, completo: completo || total === 0 && dias.length === 1 };
}
