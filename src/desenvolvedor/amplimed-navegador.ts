import { chromium, type Browser, type Page } from 'playwright-core';
import { dataDoCabecalhoAmplimed, dataEsperadaAtras, lerDetalheAmplimedTexto } from '../agenda/amplimed-leitor.js';
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
  const caixas = page.locator('input:visible');
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
    } else {
      const rotulos = await page.evaluate(`[...document.querySelectorAll('button')].map(e => (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 30)).filter(Boolean).slice(0, 8)`) as string[];
      console.warn('AMPLIMED_2FA_DESAFIO caixas=' + indices.length + ' botoes=' + JSON.stringify(rotulos));
      return false;
    }
    await page.getByRole('button', { name: /confirmar/i }).first().click({ timeout: 5000 });
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
    let limite = Date.now() + (opcoes.tempoMs ?? 40000);
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
        // A espera humana/assistida pelo código tem janela própria; o teto do login não pode expirar durante ela.
        limite = Math.max(limite, Date.now() + 300_000);
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

export interface EventoAgendaAmplimed { texto: string; cor: string; codigoProfissional?: string | null; detalhe?: import('../agenda/amplimed-leitor.js').DetalheAmplimed | null }
export interface DiaAgendaAmplimed { data: string; eventos: EventoAgendaAmplimed[] }
export interface EventoFeedAmplimed { titulo: string; inicio: string; fim: string | null; cor: string; recurso?: string | null }
export interface ProfissionalFiltroAmplimed { codigo: string; nome: string }
export function navegacaoPulouDataAmplimed(anterior:string,atual:string,alvo:string):boolean {
  return (anterior<alvo&&atual>alvo)||(anterior>alvo&&atual<alvo);
}
/** Converte um evento do feed mensal para o mesmo contrato textual da visão Dia; falha fechado se faltar identificação temporal/textual. */
export function eventoAgendaAmplimedDoFeed(e: EventoFeedAmplimed): EventoAgendaAmplimed | null {
  const inicio=(e.inicio??'').trim(), fim=(e.fim??'').trim(), titulo=(e.titulo??'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
  if(!inicio||!fim||!/^\d{2}:\d{2}$/.test(inicio)||!/^\d{2}:\d{2}$/.test(fim)||!titulo)return null;
  return {texto:`${inicio} - ${fim}\n${titulo}`,cor:e.cor??''};
}
/**
 * Filtra eventos pelo código do profissional vinculado. Fail-closed: evento sem código de
 * profissional atribuído pela própria página (resourceId do FullCalendar) torna a leitura
 * incompleta em vez de ser atribuído por suposição.
 */
export function filtrarEventosPorCodigoProfissional<T extends { codigoProfissional?: string | null }>(
  eventos: readonly T[], codigo: string
): { ok: true; eventos: T[] } | { ok: false; motivo: 'PROFISSIONAL_NAO_IDENTIFICADO' } {
  if (!codigo.trim()) return { ok: true, eventos: [...eventos] };
  if (eventos.some(e => !e.codigoProfissional?.trim())) return { ok: false, motivo: 'PROFISSIONAL_NAO_IDENTIFICADO' };
  return { ok: true, eventos: eventos.filter(e => e.codigoProfissional === codigo) };
}

/** Lista os profissionais do filtro da agenda (checkboxes .select_profs): código do filtro + nome exibido. */
export async function listarProfissionaisAgendaAmplimed(opcoes: { executavel: string; email: string; senha: string; tempoMs?: number }, signal?: AbortSignal): Promise<{ codigo: CodigoLoginAmplimed; profissionais: ProfissionalFiltroAmplimed[] }> {
  let profissionais: ProfissionalFiltroAmplimed[] = [];
  const codigo = await verificarLoginAmplimed({ ...opcoes, aoConectar: async page => {
    if (!/\/agenda/.test(page.url())) await page.goto('https://app.amplimed.com.br/agenda', { waitUntil: 'domcontentloaded', timeout: 20000 });
    // O contêiner aparece antes dos checkboxes (carga assíncrona do filtro): esperar o primeiro .select_profs,
    // não só o #seletor_profissional, senão a leitura vê zero entradas em página ainda populando.
    const apareceuSeletor = await page.waitForSelector('#seletor_profissional', { timeout: 15000 }).then(() => true).catch(() => false);
    const apareceuCheckbox = apareceuSeletor ? await page.waitForSelector('.select_profs', { timeout: 15000 }).then(() => true).catch(() => false) : false;
    profissionais = await page.evaluate(`[...document.querySelectorAll('.select_profs')].map(c => ({ codigo: String(c.getAttribute('valor') || ''), nome: String(c.getAttribute('prof') || (c.closest('label')?.textContent || '')).trim() })).filter(p => p.codigo && p.nome)`) as ProfissionalFiltroAmplimed[];
    console.warn('AMPLIMED_LISTA_PROFS seletor=' + apareceuSeletor + ' checkbox=' + apareceuCheckbox + ' total=' + profissionais.length);
  } }, signal);
  return { codigo, profissionais };
}

/**
 * Leitura de observação da agenda (somente leitura, nada vira nota). Faz login com a credencial recebida, abre /agenda
 * e cobre hoje + `diasAtras` datas anteriores. Usa a visão Dia quando a data é exibível e o feed mensal quando
 * hiddenDays oculta a data; só devolve completo quando cada data do período foi confirmada.
 */
export async function lerEventosAgendaAmplimed(opcoes: { executavel: string; email: string; senha: string; tempoMs?: number; diasAtras?: number; detalhes?: boolean; codigoProfissional?: string }, signal?: AbortSignal): Promise<{ codigo: CodigoLoginAmplimed; dias: DiaAgendaAmplimed[]; profissional: string | null; completo: boolean; motivo?: string }> {
  const dias: DiaAgendaAmplimed[] = [];
  let profissional: string | null = null;
  let completo = false;
  let motivo: string | undefined;
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
    const codigoProfissional = opcoes.codigoProfissional?.trim();
    if (codigoProfissional) {
      // Fixa a seleção do profissional no filtro da própria página (checkbox .select_profs + selectedprofs)
      // e só prossegue quando a página confirma a seleção. Sem confirmação: leitura fail-closed.
      const fixacao = await page.evaluate(`(() => {
        const alvo = ${JSON.stringify('__CODIGO__')};
        const sel = document.querySelector('#seletor_profissional');
        if (!sel) return 'seletor_ausente';
        if (String(sel.getAttribute('selectedprofs') || '0') === alvo) return 'ok';
        const chk = document.querySelector('.select_profs[valor="' + alvo + '"]');
        if (!chk) return 'profissional_ausente_no_filtro';
        if (!chk.checked) chk.click();
        try { if (typeof window.updateAgendaByProfissional === 'function') window.updateAgendaByProfissional(); } catch { /* verificação abaixo decide */ }
        return 'pendente';
      })()`.replace('__CODIGO__', codigoProfissional.replace(/["\\]/g, ''))) as string;
      if (fixacao !== 'ok') {
        if (fixacao === 'pendente') await page.waitForTimeout(3000);
        const atual = await page.evaluate(`String(document.querySelector('#seletor_profissional')?.getAttribute('selectedprofs') || '0')`) as string;
        if (atual !== codigoProfissional) { motivo = 'SELECAO_PROFISSIONAL_FALHOU'; console.warn('AMPLIMED_PROFISSIONAL fixacao_falhou motivo=' + fixacao); return; }
      }
    }
    profissional = await page.evaluate(`(() => { const t = (document.querySelector('.fc-head')?.innerText || '').split('\\n').map(x => x.trim()).filter(x => x && !/\\d{4}/.test(x)); return t[0] ? t[0].slice(0, 120) : null; })()`) as string | null;
    // A agenda pode ocultar dias na visão Dia (observado: domingo). Cobertura é por DATA, não por cabeçalho visível.
    // Para cada data do período, tenta a visão diária; se a navegação pular o alvo, confirma o dia pelo feed mensal.
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    let data: string | null = await cabecalho(page);
    if (!data) { console.warn('AMPLIMED_PERIODO cabecalho_ilegivel texto=' + JSON.stringify(await page.evaluate(`(document.querySelector('.fc-toolbar')?.innerText || '').slice(0, 120)`))); return; }

    // Navega sem oscilar ao redor de hiddenDays: cruzar o alvo prova que a visão diária o pulou.
    const ancorarEm = async (alvo: string): Promise<string | null> => {
      let d = await cabecalho(page);
      let passos = 0;
      while (d && d !== alvo && passos < 62) {
        const anterior = d;
        const botao = d < alvo ? '.fc-next-button' : '.fc-prev-button';
        try { await page.evaluate('window.scrollTo(0, 0)'); await page.locator(botao).first().click({ timeout: 5000 }); } catch { /* conferência abaixo decide */ }
        for (let t = 0; t < 12 && d === anterior; t++) { await page.waitForTimeout(400); d = await cabecalho(page) ?? anterior; }
        if (d === anterior) break;
        if (navegacaoPulouDataAmplimed(anterior,d,alvo)) {
          console.warn('AMPLIMED_PERIODO dia_oculto alvo=' + alvo + ' entre=' + anterior + ',' + d);
          return null;
        }
        passos++;
      }
      return d === alvo ? d : null;
    };

    // Pular um dia NÃO significa vazio. A visão mensal baixa os eventos do mês; consultamos o alvo exato.
    // Se houver eventos, reconstrói o mesmo texto/cor usado pela visão Dia para preservar paciente, valor, telefone e id derivado.
    const eventosDoFeedMensal = async (alvo: string): Promise<EventoAgendaAmplimed[] | null> => {
      try {
        await page.evaluate('window.scrollTo(0, 0)');
        await page.locator('.fc-month-button').first().click({ timeout: 5000 });
        await page.waitForTimeout(1200);
        const crus = await page.evaluate(`(async () => {
          const jq = window.jQuery || window.$; const el = document.querySelector('.fc');
          if (!jq || !el) return null;
          jq(el).fullCalendar('gotoDate', '${alvo}');
          await new Promise(r => setTimeout(r, 2500));
          const v = jq(el).fullCalendar('getView');
          if (!v || v.name !== 'month') return null;
          return jq(el).fullCalendar('clientEvents', e => e.start && e.start.format('YYYY-MM-DD') === '${alvo}').map(e => ({
            titulo: String(e.title || ''),
            inicio: e.start ? e.start.format('HH:mm') : '',
            fim: e.end ? e.end.format('HH:mm') : null,
            cor: String(e.backgroundColor || e.color || (e.source && (e.source.backgroundColor || e.source.color)) || ''),
            recurso: e.resourceId ? String(e.resourceId) : null
          }));
        })()`) as EventoFeedAmplimed[] | null;
        if (!Array.isArray(crus)) return null;
        const eventos = crus.map(eventoAgendaAmplimedDoFeed);
        if (eventos.some(e => e === null)) {
          console.warn('AMPLIMED_PERIODO feed_evento_incompleto data=' + alvo + ' total=' + crus.length);
          return null;
        }
        const conv = eventos as EventoAgendaAmplimed[];
        crus.forEach((c, i) => { conv[i]!.codigoProfissional = c.recurso ?? null; });
        if (codigoProfissional) {
          const filtro = filtrarEventosPorCodigoProfissional(conv, codigoProfissional);
          if (!filtro.ok) { console.warn('AMPLIMED_PROFISSIONAL feed_sem_resource_id data=' + alvo); return null; }
          return filtro.eventos;
        }
        return conv;
      } catch { return null; }
      finally {
        try { await page.evaluate('window.scrollTo(0, 0)'); await page.locator('.fc-agendaDay-button').first().click({ timeout: 5000 }); } catch { /* próxima âncora decide */ }
        await page.waitForTimeout(1000);
      }
    };

    for (let deslocamento = 0; deslocamento <= total; deslocamento++) {
      const esperado = dataEsperadaAtras(hoje, deslocamento);
      const visivel = await ancorarEm(esperado);
      if (visivel) {
        await page.waitForTimeout(1000);
        if (codigoProfissional) {
          const confere = await page.evaluate(`(() => {
            const jq = window.jQuery || window.$; const el = document.querySelector('.fc');
            if (!jq || !el) return null;
            const evs = jq(el).fullCalendar('clientEvents', e => e.start && e.start.format('YYYY-MM-DD') === ${JSON.stringify('__DIA__')});
            return Array.isArray(evs) && evs.every(e => String(e.resourceId || '') === ${JSON.stringify('__COD__')});
          })()`.replace('__DIA__', esperado).replace('__COD__', codigoProfissional)) as boolean | null;
          if (confere !== true) { motivo = 'PROFISSIONAL_NAO_IDENTIFICADO'; console.warn('AMPLIMED_PROFISSIONAL resource_id_inconsistente data=' + esperado); return; }
        }
        dias.push({ data: esperado, eventos: await comDetalhes(page, await eventosDaTela(page)) });
        continue;
      }
      const eventos = await eventosDoFeedMensal(esperado);
      if (eventos === null) {
        console.warn('AMPLIMED_PERIODO dia_nao_lido data=' + esperado + ' motivo=verificacao_feed_falhou');
        return;
      }
      console.warn('AMPLIMED_PERIODO dia_oculto_confirmado data=' + esperado + ' eventos=' + eventos.length + ' via=feed_mensal');
      dias.push({ data: esperado, eventos });
    }
    completo = true;
  } }, signal);
  return { codigo, dias, profissional, completo: completo || total === 0 && dias.length === 1, motivo };
}
