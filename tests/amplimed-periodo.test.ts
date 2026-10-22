import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CofreAmplimed } from '../src/cofre/amplimed-cofre.js';
import { dataDoCabecalhoAmplimed, diasAtrasAmplimed } from '../src/agenda/amplimed-leitor.js';

const chave = Buffer.alloc(32, 7).toString('base64');
const id = '22222222-2222-4222-8222-222222222222';
const ev = (h: string, cor: string, valor = 'R$ 180,00') => ({ texto: `${h} - 08:30\nPaciente Passado | Avaliação | Particular | ${valor} | 51990000009`, cor });
const prof = 'Allan Severo (teste Noto)';

describe('cabeçalho e janela de dias', () => {
  it('lê a data do cabeçalho do Amplimed', () => {
    expect(dataDoCabecalhoAmplimed('Hoje Dia Semana Mês Compromissos quarta-feira, 21 de out de 2026')).toBe('2026-10-21');
    expect(dataDoCabecalhoAmplimed('sábado, 3 de mar de 2026')).toBe('2026-03-03');
    expect(dataDoCabecalhoAmplimed('sem data')).toBeNull();
  });
  it('janela: hoje até desde, teto 31 dias', () => {
    expect(diasAtrasAmplimed('2026-10-22', '2026-10-22')).toBe(0);
    expect(diasAtrasAmplimed('2026-10-22', '2026-10-19')).toBe(3);
    expect(diasAtrasAmplimed('2026-10-22', '2026-08-01')).toBeNull();
    expect(diasAtrasAmplimed('2026-10-22', '2026-10-30')).toBeNull();
  });
});

describe('leitura de período do Amplimed (observação)', () => {
  const criar = async (lerEventos: ConstructorParameters<typeof CofreAmplimed>[0]['lerEventos']) => {
    const c = new CofreAmplimed({ diretorio: await mkdtemp(join(tmpdir(), 'ampl-')), chave, lerEventos });
    await c.iniciar(id, { email: 'a@b.co', senha: 'x' });
    return c;
  };
  it('junta os dias, só finalizado (verde) + particular com valor, e devolve em ordem de leitura', async () => {
    const c = await criar(async (_cred, dias) => ({ codigo: 'CONECTADO', profissional: prof, completo: true, dias: [
      { data: '2026-10-22', eventos: [ev('08:00', 'green', 'R$ 250,00')] },
      { data: '2026-10-21', eventos: [ev('09:00', 'green')] },
      { data: '2026-10-20', eventos: [ev('09:00', 'rgb(215, 83, 83)', 'R$ 200,00')] }, // cancelado: fora
    ].slice(0, dias + 1) }));
    const r = await c.lerAgendaPeriodo(id, '2026-10-20', '2026-10-22');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dias.map(d => [d.data, d.elegiveis.length])).toEqual([['2026-10-22', 1], ['2026-10-21', 1], ['2026-10-20', 0]]);
  });
  it('não navegou até o fim: leitura incompleta, nada é afirmado', async () => {
    const c = await criar(async () => ({ codigo: 'CONECTADO', profissional: prof, completo: false, dias: [{ data: '2026-10-22', eventos: [] }] }));
    expect(await c.lerAgendaPeriodo(id, '2026-10-20', '2026-10-22')).toMatchObject({ ok: false, motivo: 'LEITURA_INCOMPLETA' });
  });
  it('cor fora da legenda num dia derruba a leitura inteira (nunca presume)', async () => {
    const c = await criar(async () => ({ codigo: 'CONECTADO', profissional: prof, completo: true, dias: [{ data: '2026-10-22', eventos: [ev('08:00', 'orange')] }] }));
    expect(await c.lerAgendaPeriodo(id, '2026-10-22', '2026-10-22')).toMatchObject({ ok: false, motivo: 'LEITURA_NAO_CONFIAVEL', data: '2026-10-22' });
  });
  it('período acima do teto é recusado sem abrir navegador', async () => {
    let abriu = false;
    const c = await criar(async () => { abriu = true; return { codigo: 'CONECTADO', profissional: prof, completo: true, dias: [] }; });
    expect(await c.lerAgendaPeriodo(id, '2026-01-01', '2026-10-22')).toMatchObject({ ok: false, motivo: 'PERIODO_FORA_DO_LIMITE' });
    expect(abriu).toBe(false);
  });
});
