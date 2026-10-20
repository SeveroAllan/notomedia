import { EventEmitter } from 'node:events';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { LeitorAgendaTribemd } from '../src/desenvolvedor/tribemd-agenda.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] }); });
afterAll(async () => { await browser?.close(); });
it.each(['normal', 'sem botão', 'não retrocede'])('Chromium observa GETs e navega até a semana anterior: %s', async caso => {
  const page = await browser.newPage(); const leitor = new LeitorAgendaTribemd(page); const chamadas: string[] = [];
  await page.route('**/*', async route => {
    const r = route.request(), url = new URL(r.url());
    expect(r.method()).toBe('GET'); expect(url.origin).toBe('https://app.tribemd.com');
    if (url.pathname === '/api/atendimentos/agenda') {
      chamadas.push(url.search); const inicio = url.searchParams.get('inicio')!;
      await route.fulfill({ json: { atendimentos: inicio === '2026-10-12' ? [{ id: 123, paciente_id: 456, status: 10, pacientes: { nome: 'Nome apenas transitório' }, datahora_atendimento: '2026-10-13T12:00:00-03:00' }] : [] } }); return;
    }
    expect(url.pathname).toBe('/atendimentos/agenda');
    await route.fulfill({ contentType: 'text/html', body: `<button ${caso === 'sem botão' ? 'hidden' : ''} onclick="${caso === 'não retrocede' ? '' : 'semana--;' }carregar()">Semana anterior</button><script>
      let semana=0; async function carregar(){const inicio=new Date(Date.UTC(2026,9,19+semana*7));const fim=new Date(inicio);fim.setUTCDate(fim.getUTCDate()+6); await fetch('/api/atendimentos/agenda?inicio='+inicio.toISOString().slice(0,10)+'&fim='+fim.toISOString().slice(0,10));} carregar();</script>` });
  });
  try {
    await page.goto('https://app.tribemd.com/atendimentos/agenda');
    if (caso !== 'normal') await expect(leitor.lerJanela('2026-10-20', 8)).rejects.toMatchObject({ codigo: caso === 'sem botão' ? 'PAGINACAO_AGENDA_NAO_RECONHECIDA' : 'JANELA_AGENDA_NAO_CONFIRMADA' });
    else {
      const resultado = await leitor.lerJanela('2026-10-20', 8);
      expect(resultado.intervalo.inicio! <= '2026-10-12').toBe(true); expect(resultado.intervalo.fim).toBe('2026-10-25');
      expect(resultado.consultas).toHaveLength(1); expect(resultado.consultas[0]).toMatchObject({ atendimentoId: '123', pacienteId: '456', dataConsultaObservada: '2026-10-13' });
      expect(chamadas).toHaveLength(2); expect(chamadas[1]).toContain('inicio=2026-10-12');
    }
  } finally { leitor.encerrar(); await page.close(); }
});

it('90 dias percorrem 14 GETs contíguos, incluem semana passada e descartam datas fora da janela', async () => {
  const pagina = new EventEmitter(); let semana = 0; let requisicoes = 0; const quadro = {};
  let aguardar: ((r: any) => void) | undefined; let predicado: ((r: any) => boolean) | undefined;
  const carregar = () => {
    const inicio = new Date(Date.UTC(2026, 9, 19 + semana * 7)), fim = new Date(inicio); fim.setUTCDate(fim.getUTCDate() + 6);
    const consulta = { id: 123, paciente_id: 456, status: 10, pacientes: { nome: 'Transitório' }, datahora_atendimento: '2026-10-13' };
    const r = { url: () => `https://app.tribemd.com/api/atendimentos/agenda?inicio=${inicio.toISOString().slice(0, 10)}&fim=${fim.toISOString().slice(0, 10)}`, method: () => 'GET', isNavigationRequest: () => false, frame: () => quadro };
    requisicoes++; pagina.emit('request', r);
    pagina.emit('response', { request: () => r, status: () => 200, headerValue: async () => null, body: async () => Buffer.from(JSON.stringify({ atendimentos: semana === -1 ? [consulta, { ...consulta, id: 124, datahora_atendimento: '2026-01-01' }] : [] })) });
    if (aguardar) { expect(predicado!(r)).toBe(true); aguardar(r); aguardar = undefined; }
  };
  const botao: any = { or: () => botao, count: async () => 1, isVisible: async () => true, isEnabled: async () => true, click: async () => { semana--; carregar(); } };
  Object.assign(pagina, { mainFrame: () => quadro, getByRole: () => botao, locator: () => botao,
    waitForRequest: (p: (r: any) => boolean) => { predicado = p; return new Promise(r => { aguardar = r; }); } });
  const leitor = new LeitorAgendaTribemd(pagina as unknown as Page); carregar();
  try {
    const resultado = await leitor.lerJanela('2026-10-20');
    expect(resultado.intervalo).toEqual({ inicio: '2026-07-20', fim: '2026-10-25' }); expect(requisicoes).toBe(14);
    expect(resultado.consultas).toEqual([expect.objectContaining({ atendimentoId: '123', dataConsultaObservada: '2026-10-13' })]);
  } finally { leitor.encerrar(); }
});
