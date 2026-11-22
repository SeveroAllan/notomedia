/**
 * Adaptador Playwright genérico somente-leitura para agendas pré-definidas
 * adaptativas e portais descobertos online (`personalizada`). Preenche o login
 * guardado no cofre, navega como humano via `navegarComAgente` e classifica
 * sucesso, 2FA, CAPTCHA ou credencial recusada sem vazar senhas em logs.
 */

import { chromium, type Browser, type Page } from 'playwright-core';
import {
  AGENDAS_SUPORTADAS,
  dominioAprovado,
  type AgendaSuportada,
  type DefinicaoAgendaSuportada
} from '../agenda/agendas-suportadas.js';
import { navegarComAgente, type PlanejadorNavegacao } from './navegador-inteligente.js';
import { criarPlanejadorNavegacao } from './navegador-planejador.js';
import {
  extrairConsultasDeBlocosHtml,
  filtrarEstadoSessaoPorDominios,
  permitirRequisicaoPortalSomenteLeitura,
  type ConsultaPortalGenerico
} from './extrair-consultas-agenda-texto.js';
import type { EstadoNavegador } from './tribemd-perfil.js';

export type CodigoLoginPortalGenerico =
  | 'CONECTADO'
  | 'SENHA_RECUSADA'
  | 'CAPTCHA'
  | 'PRECISA_VERIFICACAO'
  | 'URL_INVALIDA'
  | 'TEMPO_ESGOTADO'
  | 'INSTABILIDADE';

const SELETORES_BLOCOS_AGENDA = [
  '#main table tr',
  'table tbody tr',
  '[role="row"]',
  '[class*="fc-event"]',
  '[class*="agenda-item"]',
  '[class*="appointment"]',
  '[class*="consulta"]',
  '[class*="agendamento"]'
].join(', ');

function hostExtraDeUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function preencherEnviarLogin(page: Page, email: string, senha: string): Promise<boolean> {
  const pass = page.locator('input[type="password"]:visible').first();
  if ((await pass.count()) === 0) return false;
  const userSel = 'input[type="email"]:visible, input[name*="email" i]:visible, input[name*="user" i]:visible, input[name*="login" i]:visible, input[type="text"]:visible';
  const user = page.locator(userSel).first();
  if ((await user.count()) === 0) return false;

  await user.fill(email, { timeout: 5_000 });
  await pass.fill(senha, { timeout: 5_000 });
  const submit = page.locator('button[type="submit"]:visible, input[type="submit"]:visible').first();
  if ((await submit.count()) > 0) {
    await submit.click({ timeout: 6_000 });
  } else {
    await pass.press('Enter');
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return true;
}

async function classificarTelaAposLogin(page: Page): Promise<CodigoLoginPortalGenerico> {
  const txt = await page.evaluate(() => (document.body?.innerText || '').slice(0, 3000)).catch(() => '');
  const norm = txt.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const temSenha = (await page.locator('input[type="password"]:visible').count().catch(() => 0)) > 0;
  if (/recaptcha|nao sou robo|cloudflare|cf-challenge/.test(norm) && temSenha) return 'CAPTCHA';
  if (/codigo de verificacao|duas etapas|2fa|token enviado/.test(norm)) return 'PRECISA_VERIFICACAO';
  if (temSenha && /(senha|usuario|e-?mail|credenciais?).{0,35}(invalid|incorret|errad)/.test(norm)) return 'SENHA_RECUSADA';
  return temSenha ? 'SENHA_RECUSADA' : 'CONECTADO';
}

export async function verificarLoginPortalGenerico(opcoes: {
  executavel: string;
  provedor: AgendaSuportada;
  urlPortal?: string | null;
  email: string;
  senha: string;
  estado?: EstadoNavegador;
  planejar?: PlanejadorNavegacao;
  aoSalvarEstado?: (estado: EstadoNavegador) => Promise<void>;
}): Promise<{ codigo: CodigoLoginPortalGenerico; consultas?: ConsultaPortalGenerico[] }> {
  const cfg = AGENDAS_SUPORTADAS[opcoes.provedor] as DefinicaoAgendaSuportada;
  const urlInicial = opcoes.urlPortal?.trim() || cfg.urlLoginPadrao;
  const hostExtra = hostExtraDeUrl(urlInicial);
  if (!urlInicial || !dominioAprovado(opcoes.provedor, urlInicial, hostExtra)) {
    return { codigo: 'URL_INVALIDA' };
  }

  const planejar = opcoes.planejar ?? criarPlanejadorNavegacao({});
  let browser: Browser | undefined;
  let envioLoginLiberado = false;

  try {
    browser = await chromium.launch({
      executablePath: opcoes.executavel,
      headless: true,
      timeout: 25_000,
      args: ['--no-first-run', '--no-default-browser-check']
    });
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 840 },
      acceptDownloads: false,
      ...(opcoes.estado ? { storageState: opcoes.estado as any } : {})
    });
    const page = await ctx.newPage();
    await page.route('**/*', route => {
      const req = route.request();
      const ok = permitirRequisicaoPortalSomenteLeitura({
        url: req.url(),
        metodo: req.method(),
        tipo: req.resourceType(),
        provedor: opcoes.provedor,
        hostExtra,
        envioLoginLiberado
      });
      return ok ? route.continue() : route.abort();
    });

    await page.goto(urlInicial, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(800);

    if ((await page.locator('input[type="password"]:visible').count()) > 0) {
      envioLoginLiberado = true;
      await preencherEnviarLogin(page, opcoes.email, opcoes.senha);
      envioLoginLiberado = false;
      const status = await classificarTelaAposLogin(page);
      if (status !== 'CONECTADO') return { codigo: status };
    }

    await navegarComAgente(page, opcoes.provedor, 'abrir_agenda', planejar, 3, hostExtra);
    if (opcoes.aoSalvarEstado) {
      const estadoAtual = await ctx.storageState().catch(() => null);
      if (estadoAtual) {
        await opcoes.aoSalvarEstado(filtrarEstadoSessaoPorDominios(estadoAtual, opcoes.provedor, hostExtra)).catch(() => {});
      }
    }
    const blocos = await page.evaluate(sel => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll(sel)).slice(0, 120)) {
        if (!(el instanceof HTMLElement) || el.getClientRects().length === 0) continue;
        const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
        if (t) out.push(t);
      }
      return out;
    }, SELETORES_BLOCOS_AGENDA).catch(() => [] as string[]);

    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const consultas = extrairConsultasDeBlocosHtml({
      blocos,
      dataPadraoIso: hoje,
      profissionalPadrao: 'Profissional',
      provedor: opcoes.provedor
    });
    return { codigo: 'CONECTADO', consultas };
  } catch (err: any) {
    return { codigo: String(err?.message || '').includes('Timeout') ? 'TEMPO_ESGOTADO' : 'INSTABILIDADE' };
  } finally {
    await browser?.close().catch(() => {});
  }
}
