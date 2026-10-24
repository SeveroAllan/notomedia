import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { carregarConfig } from '../src/config.js';
import { processarMensagemWebhook } from '../src/fluxos/processar-mensagem-webhook.js';
import type { AtendimentoRepositorio } from '../src/atendimento/atendimento-repositorio.js';
import { processarComunicacaoMedico } from '../src/onboarding/processar-comunicacao-medico.js';
import { HistoricoComunicacaoEmMemoria } from '../src/onboarding/historico-comunicacao-repositorio.js';

const agora = new Date('2026-10-18T15:00:00Z');
let rede: ReturnType<typeof vi.spyOn>;
beforeEach(() => { rede = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw Error('REDE_PROIBIDA'); }); });
afterEach(() => { expect(rede).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
function cenario(ativo = true) {
  const historico = new HistoricoComunicacaoEmMemoria(); const logs: string[] = [];
  const lerEstado = vi.fn(async () => ({ nomeMedico: 'Medica Ficticia', estado: { agora,
    fiscal: { certificado: 'ok' as const, dadosFiscais: 'ok' as const }, agenda: { nome: null, conectada: false }, ultimaNota: null } }));
  return { historico, logs, lerEstado, deps: { ativo, historico, lerEstado, extratorResposta: { extrair: async (texto: string) => ({ temNota: texto === 'não' ? 'não' as const : 'incerto' as const, desde: null, confianca: 0.90 }) }, log: (_nivel: string, texto: string) => logs.push(texto) } };
}
describe('gatilho só em modo seco, com flag explícita', () => {
  it('configuração é desligada por padrão e só aceita true explícito', () => {
    expect((carregarConfig({}) as any).comunicacaoMedicoAtiva).toBe(false);
    expect((carregarConfig({ COMUNICACAO_MEDICO_ATIVA: '1' }) as any).comunicacaoMedicoAtiva).toBe(false);
    expect((carregarConfig({ COMUNICACAO_MEDICO_ATIVA: 'true' }) as any).comunicacaoMedicoAtiva).toBe(true);
  });
  it('flag desligada não lê banco, histórico ou log', async () => {
    const c = cenario(false); c.historico.ler = async () => { throw Error('HISTORICO_NAO_PODE_SER_ACESSADO'); };
    expect(await processarComunicacaoMedico({ medicoId: 'medico-ficticio', chaveProcessamento: 'evento', agora }, c.deps)).toEqual({ tipo: 'nenhuma' });
    expect(c.lerEstado).not.toHaveBeenCalled(); expect(c.logs).toEqual([]);
  });
  it('dois gatilhos de onboarding não repetem boas-vindas nem tocam histórico real', async () => {
    const c = cenario(); const entrada = { medicoId: 'medico-ficticio', chaveProcessamento: 'onboarding', agora };
    expect((await processarComunicacaoMedico(entrada, c.deps)).tipo).toBe('boas_vindas');
    expect(await processarComunicacaoMedico(entrada, c.deps)).toEqual({ tipo: 'nenhuma' });
    expect((await c.historico.ler(entrada.medicoId, 'real')).registros).toEqual([]); expect(c.logs).toEqual(['enviaria boas_vindas']);
  });
  it('sem onboarding concluído não chama o orquestrador', async () => {
    const c = cenario();
    const lerEstado = async () => null;
    expect(await processarComunicacaoMedico({ medicoId: 'medico-ficticio', chaveProcessamento: 'evento', agora }, { ...c.deps, lerEstado })).toEqual({ tipo: 'nenhuma' });
    expect(c.logs).toEqual([]); expect((await c.historico.ler('medico-ficticio', 'simulado')).registros).toEqual([]);
  });
  it('erro de leitura é sanitizado e não grava intenção', async () => {
    const c = cenario(); c.lerEstado.mockRejectedValueOnce(Error('SEGREDO_PRIVADO_FICTICIO'));
    expect(await processarComunicacaoMedico({ medicoId: 'medico-ficticio', chaveProcessamento: 'evento', agora }, c.deps)).toEqual({ tipo: 'nenhuma' });
    expect(c.logs).toEqual(['COMUNICACAO_ESTADO_FALHOU']);
  });
});
function webhook(ativo: boolean) {
  const buscarMedicoPorTelefone = vi.fn(async () => ({ id: 'medico-ficticio' }));
  const aoReceberMensagemMedico = vi.fn(async () => {});
  const repositorio = { buscarMedicoPorTelefone } as unknown as AtendimentoRepositorio;
  const deps = { repositorio, segredoConfigurado: 'segredo-ficticio', pepper: 'pepper-ficticio', instanciaAssistenteNome: 'assistente', comunicacaoMedicoAtiva: ativo, aoReceberMensagemMedico };
  const payload = { event: 'messages.upsert', instance: 'assistente', data: { key: { id: 'mensagem-ficticia', fromMe: false, remoteJid: '5511999990000@s.whatsapp.net' }, message: { conversation: 'não' } } };
  return { buscarMedicoPorTelefone, aoReceberMensagemMedico, deps, payload };
}
describe('webhook assistente', () => {
  it('desligado preserva exatamente o descarte atual sem nenhuma leitura', async () => {
    const c = webhook(false);
    expect(await processarMensagemWebhook(c.payload, 'segredo-ficticio', c.deps)).toEqual({ ok: true, acao: 'descartada', motivoDescarte: 'gatilho_nao_reconhecido' });
    expect(c.buscarMedicoPorTelefone).not.toHaveBeenCalled(); expect(c.aoReceberMensagemMedico).not.toHaveBeenCalled();
  });
  it('mensagem recebida de médico identificado aciona uma vez o ciclo sem criar paciente', async () => {
    const c = webhook(true); await processarMensagemWebhook(c.payload, 'segredo-ficticio', c.deps);
    expect(c.aoReceberMensagemMedico).toHaveBeenCalledExactlyOnceWith({ medicoId: 'medico-ficticio', texto: 'não', chaveMensagem: 'mensagem-ficticia', chaveWhatsApp: c.payload.data.key, chaveConversa: 'b37abf8e0d16b341fdbcb549ba228f479022562bd2f9074f1d1ddec4771b3e32', dataMensagem: null, enviadaEm: null });
  });
  it.each(['enviada', 'grupo', 'imagem', 'oficial', 'segredo_invalido'] as const)('%s nunca é resposta do médico', async caso => {
    const c = webhook(true); let segredo = 'segredo-ficticio';
    if (caso === 'enviada') c.payload.data.key.fromMe = true;
    if (caso === 'grupo') c.payload.data.key.remoteJid = '123@g.us';
    if (caso === 'imagem') (c.payload.data as any).message = { imageMessage: { caption: 'não' } };
    if (caso === 'oficial') c.payload.instance = 'notomed_oficial';
    if (caso === 'segredo_invalido') segredo = 'errado';
    await processarMensagemWebhook(c.payload, segredo, c.deps); expect(c.aoReceberMensagemMedico).not.toHaveBeenCalled();
  });
  it('contato não identificado não aciona', async () => {
    const c = webhook(true); c.buscarMedicoPorTelefone.mockResolvedValueOnce(null as any);
    await processarMensagemWebhook(c.payload, 'segredo-ficticio', c.deps); expect(c.aoReceberMensagemMedico).not.toHaveBeenCalled();
  });
  it('falha no ciclo não derruba o webhook nem expõe erro privado', async () => {
    const c = webhook(true); const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
    c.aoReceberMensagemMedico.mockRejectedValueOnce(Error('SEGREDO_PRIVADO_FICTICIO'));
    expect((await processarMensagemWebhook(c.payload, 'segredo-ficticio', c.deps)).ok).toBe(true);
    expect(erro.mock.calls).toEqual([['COMUNICACAO_MEDICO_CICLO_FALHOU']]);
  });
});

it('gatilhos simultâneos do mesmo médico preservam resposta clara após a ambígua', async () => {
  const c = cenario(); const entrada = { medicoId: 'medico-ficticio', chaveProcessamento: 'inicio', agora };
  await processarComunicacaoMedico(entrada, c.deps);
  await processarComunicacaoMedico({ ...entrada, chaveProcessamento: 'pergunta' }, c.deps);
  await Promise.all([
    processarComunicacaoMedico({ ...entrada, chaveProcessamento: 'm1', respostaMedico: { texto: 'talvez', dataMensagem: '2026-10-18' } }, c.deps),
    processarComunicacaoMedico({ ...entrada, chaveProcessamento: 'm2', respostaMedico: { texto: 'não', dataMensagem: '2026-10-18' } }, c.deps)
  ]);
  expect((await c.historico.ler(entrada.medicoId, 'simulado')).perguntaNota.resposta).toEqual({ temNota: false, desde: null });
  expect(c.logs.filter(l => l.startsWith('enviaria aguardar_comprovante'))).toHaveLength(1);
});

 it.each([
   [1772422200, '2026-03-02'], ['1772422200', '2026-03-02'], [1772422200000, '2026-03-02'],
   ['1772422200000', '2026-03-02'], [1772419800, '2026-03-01'], ['invalido', null], ['', null]
 ])('timestamp do webhook %s vira data civil %s, sem usar processamento', async (timestamp, dataMensagem) => {
   const c = webhook(true); (c.payload.data as any).messageTimestamp = timestamp;
   await processarMensagemWebhook(c.payload, 'segredo-ficticio', c.deps);
   expect(c.aoReceberMensagemMedico).toHaveBeenCalledExactlyOnceWith({ medicoId: 'medico-ficticio', texto: 'não', chaveMensagem: 'mensagem-ficticia', chaveWhatsApp: c.payload.data.key, chaveConversa: 'b37abf8e0d16b341fdbcb549ba228f479022562bd2f9074f1d1ddec4771b3e32', dataMensagem, enviadaEm: dataMensagem ? new Date(Number(timestamp)>1e11?Number(timestamp):Number(timestamp)*1000).toISOString() : null });
 });

it('contatos diferentes na instância assistente têm chaves de conversa distintas', async () => {
  const c = webhook(true); await processarMensagemWebhook(c.payload, 'segredo-ficticio', c.deps);
  const outro = structuredClone(c.payload); outro.data.key.remoteJid = '5511999990001@s.whatsapp.net';
  await processarMensagemWebhook(outro, 'segredo-ficticio', c.deps);
  const chamadas = c.aoReceberMensagemMedico.mock.calls as unknown as Array<[{ chaveConversa: string }]>;
  expect(chamadas[0][0].chaveConversa).not.toBe(chamadas[1][0].chaveConversa);
  expect(chamadas[0][0].chaveConversa).toMatch(/^[a-f0-9]{64}$/);
});
