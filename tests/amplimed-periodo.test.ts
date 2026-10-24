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
    if (r.ok) {
      expect(r.dias.map(d => [d.data, d.elegiveis.length])).toEqual([['2026-10-22', 1], ['2026-10-21', 1], ['2026-10-20', 0]]);
      expect(r.dias[2]!.consultas).toEqual([expect.objectContaining({paciente:'Paciente Passado',status:'cancelada'})]);
    }
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

import { readFileSync } from 'node:fs';
describe('painel Amplimed', () => {
  const html = readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../src/assets/cofre-amplimed.js', import.meta.url), 'utf8');
  it('card, modal e script existem; o consentimento é o do Amplimed e só fala com a rota do Amplimed', () => {
    expect(html).toContain('id="cardCofreAmplimed"'); expect(html).toContain('id="modalCofreAmplimed"'); expect(html).toContain('/assets/cofre-amplimed.js');
    expect(js).toContain("'amplimed-leitura-v1'"); expect(js).toContain('/api/conta/cofre/amplimed'); expect(js).not.toContain('/tribemd');
  });
  it('excluir apaga a credencial', async () => {
    const c = await (async () => { const x = new CofreAmplimed({ diretorio: await mkdtemp(join(tmpdir(), 'ampl-')), chave }); await x.iniciar(id, { email: 'a@b.co', senha: 'x' }); return x; })();
    expect((await c.status(id)).salvo).toBe(true);
    expect((await c.excluir(id)).salvo).toBe(false);
  });
});

import { statusAmplimedPorCor } from '../src/agenda/amplimed-mapeamento.js';
describe('cor vermelha do cancelado na conta teste', () => {
  it('red não é atendimento e verde continua sendo', () => {
    expect(statusAmplimedPorCor('red')).not.toBe('realizada'); expect(statusAmplimedPorCor('red')).not.toBe('desconhecido');
    expect(statusAmplimedPorCor('rgb(255, 0, 0)')).toBe(statusAmplimedPorCor('red')); expect(statusAmplimedPorCor('green')).toBe('realizada');
  });
});

import { lerDetalheAmplimedTexto, montarLeituraAmplimed as montar } from '../src/agenda/amplimed-leitor.js';
describe('detalhe do atendimento (tomador)', () => {
  const painel = '× Visualizar Agendamento 22/10/2026 Cadastro paciente Whatsapp Teleatendimento Prontuário rápido A RECEBER 2 - Paciente Teste Um Data nasc. : 01/01/1990 36a 9m 21d CPF : 100.000.000-19 Endereço : , - Contato : 51993527271 E-mail : Convênio : Particular Plano : Nro cart. :';
  it('lê nome, CPF e celular do painel', () => {
    expect(lerDetalheAmplimedTexto(painel, 'Paciente Teste Um')).toEqual({ nome: 'Paciente Teste Um', cpf: '10000000019', celular: '51993527271' });
  });
  it('nome diferente do compromisso, CPF inválido ou ausente: nenhum tomador', () => {
    expect(lerDetalheAmplimedTexto(painel, 'Paciente Teste Dois')).toBeNull();
    expect(lerDetalheAmplimedTexto(painel.replace('100.000.000-19', '100.000.000-18'), 'Paciente Teste Um')).toBeNull();
    expect(lerDetalheAmplimedTexto(painel.replace(/CPF : [\d.-]+/, 'CPF :'), 'Paciente Teste Um')).toBeNull();
  });
  it('o detalhe só acompanha o compromisso quando o nome do painel bate com o da agenda', () => {
    const ev = (nome: string) => ({ texto: `08:00 - 08:30\n${'Paciente Teste Um'} | Avaliação | Particular |  R$ 250,00 | 51993527271`, cor: 'green', detalhe: { nome, cpf: '10000000019', celular: null } });
    expect(montar([ev('Paciente Teste Um')], { data: '2026-10-22', profissional: 'X' }).detalhes.size).toBe(1);
    expect(montar([ev('Outra Pessoa')], { data: '2026-10-22', profissional: 'X' }).detalhes.size).toBe(0);
  });
});
