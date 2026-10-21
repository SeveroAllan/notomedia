import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as regras from '../src/onboarding/regras/decidir-proxima-acao.js';
import { CONFIANCA_MINIMA_COMPROVANTE } from '../src/atendimento/comprovante.js';
import { ExtratorRespostaMedicoNvidia } from '../src/io/nvidia/extrator-resposta-medico.js';
import { orquestrarComunicacao } from '../src/onboarding/orquestrar-comunicacao.js';
import { HistoricoComunicacaoEmMemoria } from '../src/onboarding/historico-comunicacao-repositorio.js';
const cliente = vi.hoisted(() => vi.fn());
vi.mock('../src/io/nvidia/chat-client.js', () => ({ completarOpenAi: cliente }));
const contexto = { acaoPendente: 'perguntar_nota_pendente' as const, pergunta: 'Desde quando você não emite notas?', mensagens: [] };
const data = '2026-03-02'; const agora = new Date('2026-10-18T15:00:00Z');
let rede: ReturnType<typeof vi.spyOn>;
beforeEach(() => { cliente.mockReset(); rede = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw Error('REDE_PROIBIDA'); }); });
afterEach(() => { expect(rede).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
const validar = (campos: unknown, texto = 'tenho sim', dia: string | null = data) => (regras as any).validarRespostaNotaExtraida(campos, texto, dia);
const campos = { temNota: 'sim' as 'sim' | 'não' | 'incerto', desde: null as string | null, confianca: CONFIANCA_MINIMA_COMPROVANTE };
describe('extração da resposta usa o mesmo cliente, com IA falsa', () => {
  it('cliente recebe só texto e data civil, devolve apenas campos sem decidir ação', async () => {
    cliente.mockResolvedValue(JSON.stringify(campos));
    const extrator = new ExtratorRespostaMedicoNvidia('credencial-ficticia', 'modelo-ficticio');
    expect(await extrator.extrair('tenho sim', data, contexto)).toEqual(campos);
    expect(cliente).toHaveBeenCalledTimes(1); const args = cliente.mock.calls[0];
    expect(args.slice(0, 2)).toEqual(['credencial-ficticia', 'modelo-ficticio']); expect(args[3]).toEqual({ formatoJson: true });
    expect(args[2][1]).toEqual({ role: 'user', content: JSON.stringify({ texto: 'tenho sim', dataMensagem: data, contexto }) });
    expect(JSON.stringify(args[2])).not.toContain('credencial-ficticia');
  });
  it.each(['{}', '{"temNota":"sim","desde":null,"confianca":0.95,"emitir":true}', 'texto sem JSON'])('saída fora do contrato é rejeitada: %s', async resposta => {
    cliente.mockResolvedValue(resposta);
    await expect(new ExtratorRespostaMedicoNvidia('credencial-ficticia', 'modelo-ficticio').extrair('sim', data, contexto)).rejects.toThrow();
  });
  it('sem configuração não chama o provedor', async () => {
    await expect(new ExtratorRespostaMedicoNvidia(undefined, undefined).extrair('sim', data, contexto)).rejects.toThrow(); expect(cliente).not.toHaveBeenCalled();
  });
});
describe('decisão posterior à IA é determinística', () => {
  it.each([
    ['sim', { ...campos }, { temNota: true, desde: null }], ['tenho sim', { ...campos }, { temNota: true, desde: null }],
    ['nada por enquanto', { ...campos, temNota: 'não' }, { temNota: false, desde: null }],
    ['desde segunda', { ...campos, desde: '2026-03-02' }, { temNota: true, desde: '2026-03-02' }]
  ])('%s aceita extração validada em 0,90', (texto, leitura, resposta) => { expect(validar(leitura, texto)).toEqual(resposta); });
  it.each([0.89, -1, 1.01, NaN, undefined])('confiança %s não permite gravar', confianca => {
    expect(validar({ ...campos, confianca })).toBeNull();
  });
  it.each(['2026-03-03', '2026-02-30', '02/03/2026', 'amanhã', ''])('data %s é inválida ou futura em relação à mensagem', desde => {
    expect(validar({ ...campos, desde })).toBeNull();
  });
  it('incerto não vira resposta; negativa com data também é ambígua', () => {
    expect(validar({ ...campos, temNota: 'incerto' })).toBeNull(); expect(validar({ ...campos, temNota: 'não', desde: data })).toBeNull();
  });
  it('data civil ausente não é substituída pelo processamento', () => { expect(validar(campos, 'sim', null)).toBeNull(); });
  it.each([
    ['tenho sim desde hoje', '2026-03-02'], ['sim, desde ontem', '2026-03-01'], ['sim, desde dia 10', '2026-02-10'],
    ['sim, desde dia 31', null]
  ])('%s é calculado pelo código, mesmo se IA devolver data diferente', (texto, desde) => {
    expect(validar({ ...campos, desde: '2026-01-01' }, texto)).toEqual(desde ? { temNota: true, desde } : null);
  });
  it('dia N maior que hoje atravessa ano e usa mês anterior sem normalizar dia impossível', () => {
    expect(validar(campos, 'sim, desde dia 20', '2026-01-05')).toEqual({ temNota: true, desde: '2025-12-20' });
  });
});
async function cenario() {
  const historico = new HistoricoComunicacaoEmMemoria(); const logs: string[] = [];
  const extrair = vi.fn(async () => campos);
  const entrada = { medicoId: 'medico-ficticio', chaveProcessamento: 'inicio', estado: { agora,
    fiscal: { certificado: 'ok' as const, dadosFiscais: 'ok' as const }, agenda: { nome: null, conectada: false }, ultimaNota: null } };
  const deps = { historico, envioRealAtivo: false, extratorResposta: { extrair }, log: (_nivel: string, texto: string) => logs.push(texto) };
  await orquestrarComunicacao(entrada, deps); await orquestrarComunicacao({ ...entrada, chaveProcessamento: 'pergunta' }, deps);
  return { historico, logs, extrair, entrada, deps };
}
it('sim livre sem data é gravado apenas no histórico simulado depois da extração', async () => {
  const c = await cenario();
  expect(await orquestrarComunicacao({ ...c.entrada, chaveProcessamento: 'resposta', respostaMedico: { texto: 'tenho sim', dataMensagem: data } }, c.deps)).toEqual({ tipo: 'pedir_agenda', agendaInformada: null });
  expect(c.extrair).toHaveBeenCalledExactlyOnceWith('tenho sim', data, contexto);
  expect((await c.historico.ler('medico-ficticio', 'simulado')).perguntaNota.resposta).toEqual({ temNota: true, desde: null });
  expect((await c.historico.ler('medico-ficticio', 'real')).perguntaNota.resposta).toBeNull();
});
it.each(['incerto', 'baixa_confianca', 'falha_ia'] as const)('%s não grava e repergunta uma vez com o mesmo texto', async caso => {
  const c = await cenario();
  if (caso === 'incerto') c.extrair.mockResolvedValue({ ...campos, temNota: 'incerto' });
  if (caso === 'baixa_confianca') c.extrair.mockResolvedValue({ ...campos, confianca: 0.89 });
  if (caso === 'falha_ia') c.extrair.mockRejectedValue(Error('RESPOSTA_PRIVADA_FICTICIA'));
  const entrada = { ...c.entrada, chaveProcessamento: 'resposta', respostaMedico: { texto: 'talvez', dataMensagem: data } };
  expect(await orquestrarComunicacao(entrada, c.deps)).toEqual({ tipo: 'reperguntar', pergunta: 'nota_pendente' });
  expect(await orquestrarComunicacao({ ...entrada, chaveProcessamento: 'outra' }, c.deps)).toEqual({ tipo: 'nenhuma' });
  expect((await c.historico.ler('medico-ficticio', 'simulado')).perguntaNota.resposta).toBeNull();
  expect(c.logs.filter(l => l.startsWith('enviaria reperguntar'))).toEqual(['enviaria reperguntar: Desde quando você não emite notas?']);
  expect(c.logs.join()).not.toContain('RESPOSTA_PRIVADA_FICTICIA');
});

it.each(['tenho sim desde dia 10 de janeiro', 'sim desde dia 10/01/2026', 'sim desde dia 10.01.2026'])('data explícita não é truncada para mês anterior: %s', texto => {
  expect(validar({ ...campos, desde: '2026-01-10' }, texto)).toEqual({ temNota: true, desde: '2026-01-10' });
});
it('dia numérico impossível não escapa da regra relativa por ter três dígitos', () => {
  expect(validar({ ...campos, desde: '2026-01-01' }, 'tenho sim desde dia 100')).toBeNull();
});
