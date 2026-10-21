import { afterEach, expect, it, vi } from 'vitest';
import { BancoHistoricoFalso } from './fakes/banco-historico.js';
import { config } from '../src/config.js';
import { criarAppExpress } from '../src/server.js';
import { PostgresAtendimentoRepositorio } from '../src/io/postgres/postgres-atendimento-repositorio.js';
import { PostgresEmissaoComprovante } from '../src/io/postgres/postgres-emissao-comprovante.js';
import { EvolutionApiClient } from '../src/io/evolution/evolution-api-client.js';

const portas = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), extrair: vi.fn(), agenda: vi.fn() }));
vi.mock('../src/io/postgres/pool.js', () => ({ pool: portas }));
vi.mock('../src/io/nvidia/chat-client.js', () => ({ completarOpenAi: portas.extrair }));
vi.mock('../src/cofre/router.js', async () => {
  const { default: express } = await import('express');
  return { criarCofreContas: () => ({ app: express(), encerrar: async () => {}, statusAgenda: async () => ({ nome: 'falsa', conectada: true }), fonteAgenda: { consultar: portas.agenda } }) };
});
const anterior = { ...config };
afterEach(() => { Object.assign(config, anterior); vi.restoreAllMocks(); });

it('handler montado usa agenda falsa após extração, passa consulta transitória e grava só hashes', async () => {
  const banco = new BancoHistoricoFalso(); const eventos: string[] = [];
  portas.connect.mockImplementation(() => banco.connect());
  portas.query.mockImplementation(async (sql: string) => {
    if (sql.includes('consulta_chave')) return { rows: [] };
    if (sql.includes('from pacientes p')) return { rows: [{ nome: 'Ana Ficticia', cpf: '52998224725' }] };
    throw Error(`SQL não modelado: ${sql}`);
  });
  portas.extrair.mockImplementation(async () => { eventos.push('extracao'); return JSON.stringify({ tipo: 'extraido', campos: { valorCentavos: 20000, dataPagamento: '2026-10-19', nomePagador: 'Ana Ficticia', nomeFavorecido: 'Medica Ficticia', confianca: { valorCentavos: .9, dataPagamento: .9, nomePagador: .9, nomeFavorecido: .9 } } }); });
  portas.agenda.mockImplementation(async () => { eventos.push('agenda'); return { tipo: 'consultas', fonte: 'agenda-falsa', consultas: [{ pacienteId: 'outro-id-na-agenda', telefonePaciente: '1199990000', idExterno: 'consulta-ficticia', dataHora: '2026-10-18', status: 'realizada', valorConsultaCentavos: 20000 }] }; });
  config.emissaoComprovanteHomologacaoAtiva = true; config.envioMedicoRealAtivo = false; config.envioPacienteRealAtivo = false;
  config.openaiApiKey = 'chave-falsa'; config.evolutionWebhookSecret = 'segredo-falso';
  const enfileirar = vi.spyOn(PostgresEmissaoComprovante.prototype, 'enfileirar').mockResolvedValue({ tipo: 'enfileirada', solicitacaoId: 's' });
  vi.spyOn(PostgresAtendimentoRepositorio.prototype, 'buscarInstanciaPorNome').mockResolvedValue({ id: 'i', medicoId: 'm', nomeInstancia: 'medica', oficial: false });
  vi.spyOn(PostgresAtendimentoRepositorio.prototype, 'buscarMedicoPorTelefone').mockResolvedValue(null);
  vi.spyOn(PostgresAtendimentoRepositorio.prototype, 'buscarOuCriarConversa').mockResolvedValue({ id: 'c', instanciaId: 'i', medicoId: 'm', pacienteId: 'p', contatoTelefone: '5511999990000', aguardandoCpfDesde: null });
  vi.spyOn(PostgresAtendimentoRepositorio.prototype, 'criarPacienteMinimo').mockResolvedValue({ id: 'p', medicoId: 'm', telefone: '5511999990000', nome: 'Ana Ficticia', cpfHash: null });
  vi.spyOn(PostgresAtendimentoRepositorio.prototype, 'salvarMensagem').mockResolvedValue(undefined);
  vi.spyOn(EvolutionApiClient.prototype, 'obterBase64MensagemMidia').mockResolvedValue({ mimetype: 'image/jpeg', base64: 'ZmljdGljaW8=' });
  const texto = vi.spyOn(EvolutionApiClient.prototype, 'enviarTexto').mockRejectedValue(Error('ENVIO_REAL_PROIBIDO'));
  const pdf = vi.spyOn(EvolutionApiClient.prototype, 'enviarPdf').mockRejectedValue(Error('ENVIO_REAL_PROIBIDO'));
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const app = criarAppExpress();
  const handler = (app as any).router.stack.find((l: any) => l.route?.path === '/webhook/evolution').route.stack[0].handle;
  const json = vi.fn(); const res = { status: vi.fn().mockReturnThis(), json };
  await handler({ headers: { apikey: 'segredo-falso' }, query: {}, body: { event: 'messages.upsert', instance: 'medica', data: { key: { id: 'msg', remoteJid: '123456789@lid', remoteJidAlt: '5511999990000@s.whatsapp.net', fromMe: false }, message: { imageMessage: { mimetype: 'image/jpeg' } } } } }, res);
  expect(json).toHaveBeenCalledWith({ ok: true, acao: 'mensagem_registrada' });
  expect(eventos).toEqual(['extracao', 'agenda']);
  expect(enfileirar).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ medicoId: 'm', pacienteId: 'p', consulta: { fonte: 'agenda-falsa', idExterno: 'consulta-ficticia', dataHora: '2026-10-18', valorConsultaCentavos: 20000 }, decisao: expect.objectContaining({ tipo: 'pedido_nota_pronto' }) }));
  expect(banco.comprovantes).toHaveLength(1);
  for (const proibido of ['Ana Ficticia', 'Medica Ficticia', '52998224725', '11999990000', 'consulta-ficticia']) expect(JSON.stringify(banco.comprovantes)).not.toContain(proibido);
  expect(texto).not.toHaveBeenCalled(); expect(pdf).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('Solicitação de comprovante aguardando confirmação do médico.');
});
