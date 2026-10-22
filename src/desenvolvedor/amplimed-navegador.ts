import { chromium, type Browser, type Page } from 'playwright-core';
import { dominioAprovado } from '../agenda/agendas-suportadas.js';

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
export function classificarTelaAmplimed(t: TelaAmplimed): CodigoLoginAmplimed | 'AGUARDANDO' {
  const texto = t.texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  let caminho = '';
  try { caminho = new URL(t.url).pathname; } catch { /* sem caminho */ }
  if (/^\/2fa(\/|$)/.test(caminho)) return conviteDoisFatoresAmplimed(t) ? 'AGUARDANDO' : 'PRECISA_VERIFICACAO';
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
export async function verificarLoginAmplimed(opcoes: { executavel: string; email: string; senha: string; tempoMs?: number }, signal?: AbortSignal): Promise<CodigoLoginAmplimed> {
  let browser: Browser | undefined;
  let { email, senha } = opcoes;
  try {
    try {
      browser = await chromium.launch({ executablePath: opcoes.executavel, headless: true, timeout: 20000,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-logging', '--disable-breakpad', '--disable-crash-reporter', '--disable-sync', '--password-store=basic'] });
    } catch { return 'NAVEGADOR_INDISPONIVEL'; }
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: false, serviceWorkers: 'block' });
    await context.routeWebSocket('**/*', ws => { void ws.close(); });
    let envio = false;
    const bloqueados: string[] = [];
    let postsLogin = 0;
    await context.route('**/*', async route => {
      const r = route.request();
      let ok = false;
      try { ok = permitirRequisicaoAmplimed(r.url(), r.method(), r.resourceType(), envio); } catch { /* bloqueia */ }
      if (ok && r.method().toUpperCase() === 'POST' && dominioAprovado('amplimed', r.url()) && ++postsLogin > 10) { envio = false; await route.abort('blockedbyclient'); return; }
      if (!ok) { if (r.method().toUpperCase() !== 'GET' || r.resourceType() === 'document') { try { const u = new URL(r.url()); bloqueados.push(r.method() + ' ' + u.host + u.pathname.slice(0, 40)); } catch { /* ignora */ } } await route.abort('blockedbyclient'); return; }
      await route.fallback();
    });
    const page: Page = await context.newPage();
    page.setDefaultTimeout(12000);
    context.on('page', p => { if (p !== page) void p.close().catch(() => {}); });
    const limite = Date.now() + (opcoes.tempoMs ?? 40000);
    signal?.throwIfAborted();
    await page.goto(loginAmplimed, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
    let convitePulado = false;
    while (Date.now() < limite) {
      signal?.throwIfAborted();
      await page.waitForTimeout(1500);
      const tela: TelaAmplimed = await page.evaluate(`(() => ({ url: location.href, texto: (document.body?.innerText || '').slice(0, 4000), senhasVisiveis: [...document.querySelectorAll('input[type=password]')].filter(e => e.offsetParent !== null).length }))()`) as TelaAmplimed;
      if (!convitePulado && conviteDoisFatoresAmplimed(tela)) {
        convitePulado = true;
        const rotulos = await page.evaluate(`[...document.querySelectorAll('a,button')].map(e => (e.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40)).filter(Boolean).slice(0, 12)`) as string[];
        console.warn('AMPLIMED_2FA_CONVITE controles=' + JSON.stringify(rotulos));
        const saida = rotulos.find(r => /^(agora nao|agora não|depois|mais tarde|pular|lembrar depois|continuar sem)/i.test(r));
        try {
          if (saida) await page.getByText(saida, { exact: false }).first().click({ timeout: 5000 });
          else await page.goto('https://app.amplimed.com.br/agenda', { waitUntil: 'domcontentloaded', timeout: 20000 });
        } catch { /* a próxima volta classifica */ }
        continue;
      }
      const c = classificarTelaAmplimed(tela);
      if (c === 'PRECISA_VERIFICACAO') console.warn('AMPLIMED_2FA tela=' + JSON.stringify(tela.texto.replace(/\s+/g, ' ').replace(/\d{6,}/g, '#').slice(0, 350)));
      if (c !== 'AGUARDANDO') return c;
    }
    console.warn('AMPLIMED_LOGIN etapa=tempo_esgotado url=' + (() => { try { const u = new URL(page.url()); return u.host + u.pathname; } catch { return '?'; } })() + ' bloqueados=' + JSON.stringify(bloqueados.filter(b => !/clarity|doubleclick|analytics|hubspot|google\.com\/(g|ccm|rmkt)/.test(b)).slice(0, 8)));
    return 'TEMPO_ESGOTADO';
  } catch { return 'TEMPO_ESGOTADO'; }
  finally { email = ''; senha = ''; await browser?.close().catch(() => {}); }
}
