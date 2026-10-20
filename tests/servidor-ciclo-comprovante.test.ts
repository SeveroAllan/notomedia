import { auditarComprovante } from '../src/atendimento/comprovante.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BancoHistoricoFalso } from './fakes/banco-historico.js';
import { criarAppExpress } from '../src/server.js';
import { config } from '../src/config.js';
import { PostgresAtendimentoRepositorio } from '../src/io/postgres/postgres-atendimento-repositorio.js';
import { EvolutionApiClient } from '../src/io/evolution/evolution-api-client.js';

const fronteiras = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), completar: vi.fn(), emitir: vi.fn(() => { throw new Error('EMISSAO_PROIBIDA'); }) }));
vi.mock('../src/io/postgres/pool.js', () => ({ pool: { query: fronteiras.query, connect: fronteiras.connect } }));
vi.mock('../src/io/nvidia/chat-client.js', () => ({ completarOpenAi: fronteiras.completar }));
vi.mock('../src/api/nfse/processar-solicitacao-emissao-api.js', () => ({ processarSolicitacaoEmissaoApi: fronteiras.emitir }));
const medico = '00000000-0000-4000-8000-000000000001', paciente = '00000000-0000-4000-8000-000000000002';
let banco: BancoHistoricoFalso, enviar: ReturnType<typeof vi.spyOn>, pdf: ReturnType<typeof vi.spyOn>, rede: ReturnType<typeof vi.spyOn>, midia: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>, erro: ReturnType<typeof vi.spyOn>;
const apiKeyAnterior = config.openaiApiKey, modeloAnterior = config.openaiVisaoModel, segredoAnterior = config.evolutionWebhookSecret;
beforeEach(() => {
  vi.clearAllMocks(); banco = new BancoHistoricoFalso(); fronteiras.connect.mockImplementation(() => banco.connect());
  fronteiras.query.mockResolvedValue({ rows: [{ nome: 'Paciente Ficticio', cpf: '52998224725', consulta_id: 'consulta-ficticia', valor_consulta_centavos: 35000 }] });
  fronteiras.completar.mockResolvedValue(JSON.stringify({ tipo: 'extraido', campos: { valorCentavos: 35000, dataPagamento: '2026-10-18', nomePagador: 'Paciente Ficticio', nomeFavorecido: 'Medica Ficticia',
    confianca: { valorCentavos: 0.90, dataPagamento: 0.90, nomePagador: 0.90, nomeFavorecido: 0.90 } } }));
  config.openaiApiKey = 'chave-ficticia'; config.openaiVisaoModel = 'modelo-ficticio'; config.evolutionWebhookSecret = 'segredo-ficticio';
  vi.spyOn(PostgresAtendimentoRepositorio.prototype, 'buscarInstanciaPorNome').mockResolvedValue({ id: 'instancia-ficticia', medicoId: medico, nomeInstancia: 'clinica-ficticia', oficial: false });
  vi.spyOn(PostgresAtendimentoRepositorio.prototype, 'buscarMedicoPorTelefone').mockResolvedValue(null);
  vi.spyOn(PostgresAtendimentoRepositorio.prototype, 'buscarOuCriarConversa').mockResolvedValue({ id: 'conversa-ficticia', medicoId: medico, pacienteId: paciente, instanciaId: 'instancia-ficticia', contatoTelefone: '5511999990000', aguardandoCpfDesde: null });
  vi.spyOn(PostgresAtendimentoRepositorio.prototype, 'criarPacienteMinimo').mockResolvedValue({ id: paciente, medicoId: medico, nome: 'Paciente Ficticio', telefone: '5511999990000', cpfHash: null });
  vi.spyOn(PostgresAtendimentoRepositorio.prototype, 'salvarMensagem').mockResolvedValue(undefined);
  midia = vi.spyOn(EvolutionApiClient.prototype, 'obterBase64MensagemMidia').mockResolvedValue({ mimetype: 'image/jpeg', base64: 'aW1hZ2VtLWZpY3RpY2lh' });
  enviar = vi.spyOn(EvolutionApiClient.prototype, 'enviarTexto').mockImplementation(() => { throw new Error('ENVIO_PROIBIDO'); });
  pdf = vi.spyOn(EvolutionApiClient.prototype, 'enviarPdf').mockImplementation(() => { throw new Error('ENVIO_PDF_PROIBIDO'); });
  rede = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('REDE_PROIBIDA'); });
  info = vi.spyOn(console, 'info').mockImplementation(() => {}); erro = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(enviar).not.toHaveBeenCalled(); expect(pdf).not.toHaveBeenCalled(); expect(rede).not.toHaveBeenCalled(); expect(fronteiras.emitir).not.toHaveBeenCalled();
  config.openaiApiKey = apiKeyAnterior; config.openaiVisaoModel = modeloAnterior; config.evolutionWebhookSecret = segredoAnterior;
  vi.restoreAllMocks();
});
async function receber(message: Record<string, unknown>, app = criarAppExpress()) {
  // Invoca o handler realmente montado no Express, sem socket ou HTTP de rede.
  const handler = (app as any).router.stack.find((layer: any) => layer.route?.path === '/webhook/evolution').route.stack[0].handle;
  let status = 200, corpo: unknown;
  const res = { status(valor: number) { status = valor; return res; }, json(valor: unknown) { corpo = valor; return res; } };
  await handler({ headers: { apikey: 'segredo-ficticio' }, query: {}, body: { event: 'messages.upsert', instance: 'clinica-ficticia', data: {
    key: { id: 'mensagem-ficticia', fromMe: false, remoteJid: '5511999990000@s.whatsapp.net' }, message
  } } }, res);
  return { app, status, corpo };
}
const imagem = { imageMessage: { mimetype: 'image/jpeg' } };
const intencoes = () => info.mock.calls.filter((args: unknown[]) => typeof args[0] === 'string' && /^(enviaria|pediria nota) /.test(args[0]));

describe('injeção real do ciclo no servidor com fronteiras falsas', () => {
  it('handler sem agenda usa cadastro e auditoria sem inventar consulta; repete sem duplicar', async () => {
    const primeira = await receber(imagem);
    expect({ status: primeira.status, corpo: primeira.corpo }).toEqual({ status: 200, corpo: { ok: true, acao: 'mensagem_registrada' } });
    expect(fronteiras.query).toHaveBeenCalledTimes(1);
    expect(fronteiras.query.mock.calls[0][1]).toEqual([medico, paciente, config.encryptionKey]);
    expect(midia).toHaveBeenCalledExactlyOnceWith('clinica-ficticia', 'mensagem-ficticia');
    expect(fronteiras.completar.mock.calls[0].slice(0, 2)).toEqual(['chave-ficticia', 'modelo-ficticio']);
    expect(banco.comprovantes).toHaveLength(1);
    expect(banco.comprovantes[0].decisao).toEqual({ tipo: 'perguntar_medico', motivo: 'CADASTRO_INCOMPLETO' });
    expect(intencoes()).toEqual([['enviaria perguntar_medico']]);
    await receber(imagem, primeira.app);
    expect(banco.comprovantes.map(a => a.decisao.tipo)).toEqual(['perguntar_medico', 'nenhuma']);
    expect(intencoes()).toHaveLength(1);
  });
  it('PDF no servidor é lido de forma determinística; mídia ilegível vira dúvida própria, sem IA', async () => {
    expect((await receber({ documentMessage: { mimetype: 'application/pdf' } })).status).toBe(200);
    expect(banco.comprovantes).toHaveLength(1);
    expect(banco.comprovantes[0].decisao).toEqual({ tipo: 'perguntar_medico', motivo: 'COMPROVANTE_ILEGIVEL' });
    expect(intencoes()).toEqual([['enviaria perguntar_medico']]); expect(erro).not.toHaveBeenCalled();
    expect(midia).toHaveBeenCalledTimes(1); expect(fronteiras.completar).not.toHaveBeenCalled();
  });
  it('cadastro ausente não ganha CPF ou consulta inventados', async () => {
    fronteiras.query.mockResolvedValue({ rows: [] }); await receber(imagem);
    expect(banco.comprovantes).toHaveLength(1);
    expect(banco.comprovantes[0].estado).toEqual(auditarComprovante(config.appPepper, { medicoId: medico, paciente: { nome: null, cpf: null }, ultimaConsulta: null }, null, { tipo: 'perguntar_medico', motivo: 'CADASTRO_INCOMPLETO' }).estado);
    expect(JSON.stringify(banco.comprovantes)).not.toContain('52998224725');
    expect(banco.comprovantes).toHaveLength(1);
    expect(banco.comprovantes[0].decisao.tipo).toBe('perguntar_medico');
    expect(intencoes()).toEqual([['enviaria perguntar_medico']]);
  });
  it('falha de leitura mantém HTTP 200, sem pedido, IA ou intenção, com erro sanitizado', async () => {
    fronteiras.query.mockRejectedValueOnce(new Error('CPF SENHA TOKEN FICTICIOS PRIVADOS'));
    expect((await receber(imagem)).status).toBe(200); expect(banco.comprovantes).toEqual([]);
    expect(fronteiras.completar).not.toHaveBeenCalled(); expect(intencoes()).toEqual([]);
    expect(erro.mock.calls).toEqual([['COMPROVANTE_CICLO_FALHOU']]);
  });
  it('falha de gravação mantém HTTP 200 e não registra intenção', async () => {
    banco.falhar = /^insert into public.noto_auditoria_comprovantes/;
    expect((await receber(imagem)).status).toBe(200); expect(banco.comprovantes).toEqual([]); expect(intencoes()).toEqual([]);
    expect(erro.mock.calls).toEqual([['AUDITORIA_COMPROVANTE_FALHOU']]);
  });
  it('ausência de credencial IA vira dúvida sem rede ou download e sem default', async () => {
    config.openaiApiKey = undefined; await receber(imagem);
    expect(banco.comprovantes).toHaveLength(1);
    expect(banco.comprovantes[0].decisao).toEqual({ tipo: 'perguntar_medico', motivo: 'LEITURA_INDISPONIVEL' });
    expect(midia).not.toHaveBeenCalled(); expect(fronteiras.completar).not.toHaveBeenCalled();
  });
});
