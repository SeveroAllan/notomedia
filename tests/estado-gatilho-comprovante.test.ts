import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { processarMensagemWebhook } from '../src/fluxos/processar-mensagem-webhook.js';
import { orquestrarComprovante } from '../src/fluxos/processar-comprovante.js';
import { PostgresAtendimentoRepositorio } from '../src/io/postgres/postgres-atendimento-repositorio.js';
import { HistoricoComunicacaoEmMemoria } from '../src/onboarding/historico-comunicacao-repositorio.js';
import { ExtratorComprovanteNvidia } from '../src/io/nvidia/extrator-comprovante.js';
import type { AtendimentoRepositorio } from '../src/atendimento/atendimento-repositorio.js';
import type { LeitorEstadoPedidoComprovante, ResultadoExtracaoComprovante } from '../src/atendimento/comprovante.js';

afterEach(() => vi.restoreAllMocks());
function mensagem(message: Record<string, unknown>, messageType?: string) {
  return { key: { id: 'mensagem-ficticia', remoteJid: '5511999990000@s.whatsapp.net', fromMe: false }, message, messageType };
}
function bancoWebhook() {
  const salvas: unknown[] = [];
  const repositorio = {
    async buscarInstanciaPorNome() { return { id: 'instancia-ficticia', medicoId: 'medico-ficticio', oficial: false }; },
    async buscarMedicoPorTelefone() { return null; },
    async buscarOuCriarConversa() { return { id: 'conversa-ficticia', medicoId: 'medico-ficticio', pacienteId: 'paciente-ficticio' }; },
    async criarPacienteMinimo() { return { id: 'paciente-ficticio' }; },
    async salvarMensagem(registro: unknown) { salvas.push(registro); }
  };
  return { salvas, repositorio: repositorio as unknown as AtendimentoRepositorio };
}
const leitura = (): ResultadoExtracaoComprovante => ({ tipo: 'extraido', campos: {
  valorCentavos: 35000, dataPagamento: '2026-10-18', nomePagador: 'Paciente Ficticio', nomeFavorecido: 'Medica Ficticia',
  confianca: { valorCentavos: 0.90, dataPagamento: 0.90, nomePagador: 0.90, nomeFavorecido: 0.90 }
} });

describe('gatilho do comprovante só aceita imagem e PDF', () => {
  it.each([
    ['imagem', { imageMessage: { mimetype: 'image/jpeg' } }, 'imageMessage', 1],
    ['PDF', { documentMessage: { mimetype: 'application/pdf' } }, 'documentMessage', 1],
    ['áudio', { audioMessage: { mimetype: 'audio/ogg' } }, 'audioMessage', 0],
    ['figurinha', { stickerMessage: { mimetype: 'image/webp' } }, 'stickerMessage', 0],
    ['vídeo', { videoMessage: { mimetype: 'video/mp4' } }, 'videoMessage', 0],
    ['texto', { conversation: 'Boa tarde' }, 'conversation', 0],
    ['documento não PDF', { documentMessage: { mimetype: 'text/plain' } }, 'documentMessage', 0],
    ['tipo imagem sem conteúdo de imagem', { audioMessage: {} }, 'imageMessage', 0]
  ] as const)('%s aciona o ciclo %s', async (_nome, message, messageType, chamadas) => {
    const banco = bancoWebhook(); const ciclo = vi.fn(async () => {});
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resultado = await processarMensagemWebhook({ event: 'messages.upsert', instance: 'clinica-ficticia', data: mensagem(message, messageType) },
      'segredo-ficticio', { ...banco, segredoConfigurado: 'segredo-ficticio', pepper: 'pepper-ficticio', aoReceberComprovante: ciclo });
    expect(resultado.ok).toBe(true); expect(ciclo).toHaveBeenCalledTimes(chamadas); expect(log).not.toHaveBeenCalled();
  });
});

describe('leitor de estado usa dados existentes sem inventar', () => {
  it.each([
    [{ nome: 'Paciente Ficticio', cpf: '52998224725', consulta_id: 'consulta-ficticia', valor_consulta_centavos: 35000 }, 'pedido_nota_pronto'],
    [{ nome: 'Paciente Ficticio', cpf: null, consulta_id: 'consulta-ficticia', valor_consulta_centavos: 35000 }, 'perguntar_medico'],
    [{ nome: 'Paciente Ficticio', cpf: '52998224725', consulta_id: null, valor_consulta_centavos: null }, 'perguntar_medico'],
    [{ nome: 'Paciente Ficticio', cpf: '52998224725', consulta_id: 'consulta-ficticia', valor_consulta_centavos: null }, 'perguntar_medico'],
    [null, 'perguntar_medico']
  ] as const)('linha %j gera %s', async (linha, tipo) => {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: linha ? [{ nome: linha.nome, cpf: linha.cpf }] : [] }));
    const leitor: LeitorEstadoPedidoComprovante = new PostgresAtendimentoRepositorio({ query } as unknown as pg.Pool, 'chave-ficticia');
    const estado = await leitor.lerEstado('medico-ficticio', 'paciente-ficticio');
    expect(estado).toEqual({ medicoId: 'medico-ficticio', paciente: { nome: linha?.nome ?? null, cpf: linha?.cpf ?? null },
      ultimaConsulta: null });
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(['medico-ficticio', 'paciente-ficticio', 'chave-ficticia']);
    expect(sql).toMatch(/pgp_sym_decrypt/); expect(sql).toMatch(/p\.medico_id\s*=\s*\$1/);
    expect(sql).toMatch(/p\.id\s*=\s*\$2/); expect(sql).not.toContain('noto_consultas_sincronizadas');
    const historico = new HistoricoComunicacaoEmMemoria(); const logs: string[] = [];
    const decisao = await orquestrarComprovante({ medicoId: 'medico-ficticio', pacienteId: 'paciente-ficticio', mensagem: mensagem({ imageMessage: {} }) }, {
      fonteAgenda: { consultar: async () => ({ tipo: 'consultas', fonte: 'falsa', consultas: linha?.consulta_id ? [{ pacienteId: 'paciente-agenda', telefonePaciente: '11999990000', idExterno: linha.consulta_id, dataHora: '2026-10-18', status: 'realizada', valorConsultaCentavos: linha.valor_consulta_centavos }] : [] }) },
      lerEstado: leitor.lerEstado.bind(leitor), historico, extrator: { extrair: async () => leitura() }, log: (_nivel, texto) => logs.push(texto)
    });
    expect(decisao.tipo).toBe(tipo);
    if (tipo === 'perguntar_medico') expect(decisao).not.toHaveProperty('pedido');
  });
  it('falha de leitura propaga ao limite do ciclo, sem extrair, auditar ou registrar intenção', async () => {
    const leitor: LeitorEstadoPedidoComprovante = new PostgresAtendimentoRepositorio({ query: async () => { throw new Error('falha-ficticia'); } } as unknown as pg.Pool, 'chave-ficticia');
    const historico = new HistoricoComunicacaoEmMemoria(); const extrair = vi.fn(); const log = vi.fn();
    await expect(orquestrarComprovante({ medicoId: 'medico-ficticio', pacienteId: 'paciente-ficticio', mensagem: mensagem({ imageMessage: {} }) }, {
      lerEstado: leitor.lerEstado.bind(leitor), historico, extrator: { extrair }, log
    })).rejects.toThrow('falha-ficticia');
    expect(extrair).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled(); expect(await historico.lerComprovantes('medico-ficticio')).toEqual([]);
  });
});

describe('PDF é lido de forma determinística, sem IA', () => {
  it('PDF sem mídia disponível vira leitura indisponível, sem chamar IA, e mantém o webhook normal', async () => {
    const banco = bancoWebhook(); const historico = new HistoricoComunicacaoEmMemoria(); const lerMidia = vi.fn();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('REDE_PROIBIDA'); });
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {}); const logs: string[] = [];
    const leitor: LeitorEstadoPedidoComprovante = { lerEstado: async () => ({ medicoId: 'medico-ficticio', paciente: { nome: null, cpf: null }, ultimaConsulta: null }) };
    const extrator = new ExtratorComprovanteNvidia('chave-ficticia', 'modelo-ficticio', lerMidia);
    const resultado = await processarMensagemWebhook({ event: 'messages.upsert', instance: 'clinica-ficticia', data: mensagem({ documentMessage: { mimetype: 'application/pdf' } }) },
      'segredo-ficticio', { ...banco, segredoConfigurado: 'segredo-ficticio', pepper: 'pepper-ficticio', aoReceberComprovante: contexto =>
        orquestrarComprovante(contexto, { lerEstado: leitor.lerEstado, historico, extrator, log: (_nivel, texto) => logs.push(texto) }) });
    expect(resultado).toEqual({ ok: true, acao: 'mensagem_registrada' });
    expect((await historico.lerComprovantes('medico-ficticio'))[0].decisao).toEqual({ tipo: 'perguntar_medico', motivo: 'LEITURA_INDISPONIVEL' });
    expect(logs).toEqual(['enviaria perguntar_medico']); expect(erro).not.toHaveBeenCalled();
    expect(lerMidia).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
});
