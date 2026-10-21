import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoriaConversaMedico } from '../src/onboarding/contexto-conversa-medico.js';
import { processarComunicacaoMedico } from '../src/onboarding/processar-comunicacao-medico.js';
import { HistoricoComunicacaoEmMemoria } from '../src/onboarding/historico-comunicacao-repositorio.js';
const pergunta = 'Desde quando você não emite notas?';
let rede: ReturnType<typeof vi.spyOn>;
beforeEach(() => { rede = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw Error('REDE_PROIBIDA'); }); });
afterEach(() => { expect(rede).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
async function cenario(ativo = true) {
  const memoriaConversa = new MemoriaConversaMedico(); const historico = new HistoricoComunicacaoEmMemoria(); const logs: string[] = [];
  const agora = new Date('2026-03-02T15:00:00Z');
  const extrair = vi.fn(async (..._argumentos: unknown[]) => ({ temNota: 'fora_do_assunto' as const, desde: null, confianca: 0.95 }));
  const lerEstado = vi.fn(async () => ({ nomeMedico: 'Medica Ficticia', estado: { agora, fiscal: { certificado: 'ok' as const, dadosFiscais: 'ok' as const }, ultimaNota: null, agenda: { nome: null, conectada: false } } }));
  const deps = { ativo, memoriaConversa, historico, extratorResposta: { extrair }, lerEstado, log: (_nivel: string, texto: string) => logs.push(texto) };
  const entrada = { medicoId: 'medico-a', chaveConversa: 'conversa-a', chaveProcessamento: 'inicio', agora };
  if (ativo) {
    await processarComunicacaoMedico(entrada, deps);
    await processarComunicacaoMedico({ ...entrada, chaveProcessamento: 'pergunta', respostaMedico: { texto: 'Bom dia', dataMensagem: '2026-03-02' } }, deps);
  }
  return { memoriaConversa, historico, extrair, lerEstado, logs, deps, entrada };
}
it('extrator recebe as mensagens anteriores da conversa e memória registra resposta fora do assunto', async () => {
  const c = await cenario();
  await processarComunicacaoMedico({ ...c.entrada, chaveProcessamento: 'm1', respostaMedico: { texto: 'Como funciona?', dataMensagem: '2026-03-02' } }, c.deps);
  expect(c.extrair).toHaveBeenCalledExactlyOnceWith('Como funciona?', '2026-03-02', { acaoPendente: 'perguntar_nota_pendente', pergunta, mensagens: ['Bom dia', pergunta] });
  expect(c.memoriaConversa.ler('medico-a', 'conversa-a')).toEqual(['Bom dia', pergunta, 'Como funciona?']);
  expect((await c.historico.ler('medico-a', 'simulado')).perguntaNota.resposta).toBeNull();
});
it('apenas quatro mensagens anteriores chegam à próxima extração', async () => {
  const c = await cenario();
  for (let i = 1; i <= 6; i++) await processarComunicacaoMedico({ ...c.entrada, chaveProcessamento: `m${i}`, respostaMedico: { texto: `assunto ${i}`, dataMensagem: '2026-03-02' } }, c.deps);
  expect(c.extrair.mock.calls[5][2]).toEqual({ acaoPendente: 'perguntar_nota_pendente', pergunta, mensagens: ['assunto 2', 'assunto 3', 'assunto 4', 'assunto 5'] });
  expect(c.memoriaConversa.ler('medico-a', 'conversa-a')).toEqual(['assunto 3', 'assunto 4', 'assunto 5', 'assunto 6']);
});
it('outro contato do mesmo médico não lê o contexto da conversa anterior', async () => {
  const c = await cenario();
  await processarComunicacaoMedico({ ...c.entrada, chaveConversa: 'conversa-b', chaveProcessamento: 'outro', respostaMedico: { texto: 'Outro assunto', dataMensagem: '2026-03-02' } }, c.deps);
  expect(c.extrair.mock.calls[0][2]).toEqual({ acaoPendente: 'perguntar_nota_pendente', pergunta, mensagens: [] });
  expect(c.memoriaConversa.ler('medico-a', 'conversa-a')).toEqual(['Bom dia', pergunta]);
});
it('outro médico não lê o contexto mesmo com a mesma chave de conversa', async () => {
  const c = await cenario();
  await processarComunicacaoMedico({ ...c.entrada, medicoId: 'medico-b', chaveProcessamento: 'inicio-b' }, c.deps);
  await processarComunicacaoMedico({ ...c.entrada, medicoId: 'medico-b', chaveProcessamento: 'pergunta-b' }, c.deps);
  await processarComunicacaoMedico({ ...c.entrada, medicoId: 'medico-b', chaveProcessamento: 'resposta-b', respostaMedico: { texto: 'Outro assunto', dataMensagem: '2026-03-02' } }, c.deps);
  expect(c.extrair.mock.calls[0][2]).toEqual({ acaoPendente: 'perguntar_nota_pendente', pergunta, mensagens: [pergunta] });
});
it('texto bruto não entra na memória, no extrator falso, no histórico ou no log', async () => {
  const c = await cenario(); const info = vi.spyOn(console, 'info').mockImplementation(() => {}); const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
  await processarComunicacaoMedico({ ...c.entrada, chaveProcessamento: 'privado', respostaMedico: { texto: 'CPF 529.982.247-25 e contato medico@example.invalid', dataMensagem: '2026-03-02' } }, c.deps);
  expect(c.extrair.mock.calls[0][0]).toBe('CPF [OCULTO] e contato [OCULTO]');
  expect(c.memoriaConversa.ler('medico-a', 'conversa-a').at(-1)).toBe('CPF [OCULTO] e contato [OCULTO]');
  expect(JSON.stringify(await c.historico.ler('medico-a', 'simulado'))).not.toMatch(/529\.982|medico@example/);
  expect(c.logs.join()).not.toMatch(/529\.982|medico@example|CPF \[OCULTO\]/); expect(info).not.toHaveBeenCalled(); expect(erro).not.toHaveBeenCalled();
});
it('flag desligada não lê nem altera a memória ou chama a IA', async () => {
  const c = await cenario(false); const ler = vi.spyOn(c.memoriaConversa, 'ler'); const registrar = vi.spyOn(c.memoriaConversa, 'registrar');
  await processarComunicacaoMedico({ ...c.entrada, respostaMedico: { texto: 'CPF 529.982.247-25', dataMensagem: '2026-03-02' } }, c.deps);
  expect(ler).not.toHaveBeenCalled(); expect(registrar).not.toHaveBeenCalled(); expect(c.extrair).not.toHaveBeenCalled(); expect(c.lerEstado).not.toHaveBeenCalled(); expect(c.logs).toEqual([]);
});
