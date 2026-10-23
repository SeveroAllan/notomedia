import { config } from '../src/config.js';
import { auditarComprovante } from '../src/atendimento/comprovante.js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { processarMensagemWebhook } from '../src/fluxos/processar-mensagem-webhook.js';
import type { AtendimentoRepositorio } from '../src/atendimento/atendimento-repositorio.js';
import { orquestrarComprovante } from '../src/fluxos/processar-comprovante.js';
import { HistoricoComunicacaoEmMemoria } from '../src/onboarding/historico-comunicacao-repositorio.js';
import { ExtratorComprovanteNvidia } from '../src/io/nvidia/extrator-comprovante.js';
import { EvolutionApiClient } from '../src/io/evolution/evolution-api-client.js';
import type { DadosMensagemEvolution } from '../src/whatsapp/payload-webhook-schema.js';
import type { EstadoPedidoComprovante, ResultadoExtracaoComprovante, ExtratorComprovante } from '../src/atendimento/comprovante.js';

const fronteiras = vi.hoisted(() => ({ completar: vi.fn(), emitir: vi.fn(() => { throw new Error('EMISSAO_REAL_PROIBIDA'); }) }));
vi.mock('../src/io/nvidia/chat-client.js', async (importOriginal) => ({ ...(await importOriginal() as object), completarOpenAi: fronteiras.completar }));
vi.mock('../src/api/nfse/processar-solicitacao-emissao-api.js', () => ({ processarSolicitacaoEmissaoApi: fronteiras.emitir }));
let rede: ReturnType<typeof vi.spyOn>, texto: ReturnType<typeof vi.spyOn>, pdf: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  rede = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('REDE_REAL_PROIBIDA'); });
  texto = vi.spyOn(EvolutionApiClient.prototype, 'enviarTexto').mockImplementation(() => { throw new Error('ENVIO_REAL_PROIBIDO'); });
  pdf = vi.spyOn(EvolutionApiClient.prototype, 'enviarPdf').mockImplementation(() => { throw new Error('PDF_REAL_PROIBIDO'); });
});

function evento() {
  return { event: 'messages.upsert', instance: 'clinica-ficticia', data: {
    key: { id: 'mensagem-ficticia', remoteJid: '5511999990000@s.whatsapp.net', fromMe: false },
    message: { imageMessage: { mimetype: 'image/jpeg', url: 'https://midia.invalid/pix.jpg' } }
  } };
}
function persistencia() {
  const salvas: unknown[] = [];
  const conversa = { id: 'conversa-ficticia', medicoId: 'medico-ficticio', pacienteId: 'paciente-ficticio' };
  const repositorio = {
    async buscarInstanciaPorNome() { return { id: 'instancia-ficticia', medicoId: 'medico-ficticio', oficial: false }; },
    async buscarMedicoPorTelefone() { return null; }, async buscarOuCriarConversa() { return conversa; },
    async criarPacienteMinimo() { return { id: 'paciente-ficticio' }; },
    async salvarMensagem(registro: unknown) { salvas.push(registro); }
  };
  return { salvas, repositorio: repositorio as unknown as AtendimentoRepositorio,
    segredoConfigurado: 'segredo-ficticio', pepper: 'pepper-ficticio' };
}
afterEach(() => {
  expect(rede).not.toHaveBeenCalled(); expect(texto).not.toHaveBeenCalled(); expect(pdf).not.toHaveBeenCalled();
  expect(fronteiras.emitir).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
function leitura(): ResultadoExtracaoComprovante & { tipo: 'extraido' } {
  return { tipo: 'extraido', campos: { valorCentavos: 35000, dataPagamento: '2026-10-18',
    nomePagador: 'Paciente Ficticio', nomeFavorecido: 'Medica Ficticia',
    confianca: { valorCentavos: 0.90, dataPagamento: 0.90, nomePagador: 0.90, nomeFavorecido: 0.90 } } };
}
function ciclo(historico = new HistoricoComunicacaoEmMemoria(), lido: ResultadoExtracaoComprovante = leitura()) {
  const banco = persistencia(); const logs: unknown[] = [];
  const estado: EstadoPedidoComprovante = { medicoId: 'medico-ficticio',
    paciente: { nome: 'Paciente Ficticio', cpf: '52998224725' }, ultimaConsulta: { valorConsultaCentavos: 35000 } };
  const lerEstado = vi.fn(async (_medico: string, _paciente: string) => structuredClone(estado));
  const extrator = { extrair: vi.fn(async (_mensagem: DadosMensagemEvolution) => structuredClone(lido)) };
  const log = (nivel: 'info' | 'erro', mensagem: string) => { logs.push([nivel, mensagem]); };
  const deps = { historico, extrator: extrator as ExtratorComprovante, lerEstado, log };
  const receber = vi.fn((contexto: { medicoId: string; pacienteId: string; mensagem: DadosMensagemEvolution }) =>
    orquestrarComprovante(contexto, deps));
  return { banco, historico, estado, extrator, lerEstado, logs, deps,
    webhook: { ...banco, aoReceberComprovante: receber }, receber };
}


describe('ciclo seco de comprovante pelo webhook', () => {
  it.each([
    [35000, 0.90, 'pedido_nota_pronto', 'pediria nota pedido_nota_pronto'],
    [70000, 0.90, 'perguntar_pacote', 'enviaria perguntar_pacote'],
    [35000, 0.8999, 'perguntar_medico', 'enviaria perguntar_medico']
  ] as const)('valor %s e confiança %s resultam em %s somente seco', async (valor, confianca, tipo, registro) => {
    const lido = leitura(); lido.campos.valorCentavos = valor; lido.campos.confianca!.valorCentavos = confianca;
    const c = ciclo(undefined, lido); const payload = evento();
    expect(await processarMensagemWebhook(payload, 'segredo-ficticio', c.webhook)).toEqual({ ok: true, acao: 'mensagem_registrada' });
    const resultado = await c.receber.mock.results[0].value;
    expect(resultado.tipo).toBe(tipo);
    expect(c.extrator.extrair).toHaveBeenCalledExactlyOnceWith(payload.data);
    expect(c.lerEstado).toHaveBeenCalledExactlyOnceWith('medico-ficticio', 'paciente-ficticio');
    expect(await c.historico.lerComprovantes('medico-ficticio')).toEqual([auditarComprovante(config.appPepper, c.estado, lido, resultado)]);
    expect(c.logs).toEqual([['info', registro]]);
    if (resultado.tipo === 'pedido_nota_pronto') expect(resultado.pedido).toEqual({ medicoId: 'medico-ficticio',
      valorCentavos: 35000, dataPagamento: '2026-10-18', paciente: { nome: 'Paciente Ficticio', cpf: '52998224725' } });
    else expect(resultado).not.toHaveProperty('pedido');
  });
  it('comprovante repetido pelo webhook retorna nenhuma e não repete registro seco', async () => {
    const c = ciclo(); const payload = evento();
    await processarMensagemWebhook(payload, 'segredo-ficticio', c.webhook);
    payload.data.key.id = 'segunda-mensagem-ficticia';
    expect(await processarMensagemWebhook(payload, 'segredo-ficticio', c.webhook)).toEqual({ ok: true, acao: 'mensagem_registrada' });
    expect(await c.receber.mock.results[1].value).toEqual({ tipo: 'nenhuma', motivo: 'COMPROVANTE_JA_PROCESSADO' });
    expect((await c.historico.lerComprovantes('medico-ficticio')).map(a => a.decisao.tipo)).toEqual(['pedido_nota_pronto', 'nenhuma']);
    expect(c.logs).toEqual([['info', 'pediria nota pedido_nota_pronto']]);
  });
  it('falha de auditoria pelo webhook não devolve pedido nem registra intenção de envio', async () => {
    class HistoricoComFalha extends HistoricoComunicacaoEmMemoria {
      override async registrarComprovante(): Promise<never> { throw new Error('erro privado ficticio'); }
    }
    const c = ciclo(new HistoricoComFalha());
    expect(await processarMensagemWebhook(evento(), 'segredo-ficticio', c.webhook)).toEqual({ ok: true, acao: 'mensagem_registrada' });
    expect(await c.receber.mock.results[0].value).toEqual({ tipo: 'nenhuma', motivo: 'AUDITORIA_FALHOU' });
    expect(c.logs).toEqual([['erro', 'AUDITORIA_COMPROVANTE_FALHOU']]);
    expect(await c.historico.lerComprovantes('medico-ficticio')).toEqual([]);
  });
  it('texto comum preserva persistência atual sem iniciar extração, estado ou auditoria', async () => {
    const c = ciclo(); const payload = { ...evento(), data: { ...evento().data, message: { conversation: 'Boa tarde' } } };
    expect(await processarMensagemWebhook(payload, 'segredo-ficticio', c.webhook)).toEqual({ ok: true, acao: 'mensagem_registrada' });
    expect(c.banco.salvas).toEqual([{ conversaId: 'conversa-ficticia', direcao: 'recebida', tipoMensagem: 'texto', conteudo: 'Boa tarde', payloadBruto: payload.data }]);
    expect(c.receber).not.toHaveBeenCalled(); expect(c.extrator.extrair).not.toHaveBeenCalled(); expect(c.lerEstado).not.toHaveBeenCalled();
    expect(await c.historico.lerComprovantes('medico-ficticio')).toEqual([]); expect(c.logs).toEqual([]);
  });
  it('falha da leitura de estado pelo ciclo real preserva recebimento e sanitiza erro', async () => {
    const c = ciclo(); c.lerEstado.mockRejectedValueOnce(new Error('DADO PRIVADO FICTICIO'));
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await processarMensagemWebhook(evento(), 'segredo-ficticio', c.webhook)).toEqual({ ok: true, acao: 'mensagem_registrada' });
    expect(c.extrator.extrair).not.toHaveBeenCalled(); expect(c.banco.salvas).toHaveLength(1);
    expect(await c.historico.lerComprovantes('medico-ficticio')).toEqual([]); expect(c.logs).toEqual([]);
    expect(erro.mock.calls).toEqual([['COMPROVANTE_CICLO_FALHOU']]);
  });
  it('falha do ciclo preserva o recebimento e só registra código sanitizado', async () => {
    const banco = persistencia(); const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
    const payload = evento();
    const resultado = await processarMensagemWebhook(payload, 'segredo-ficticio', { ...banco,
      aoReceberComprovante: async () => { throw new Error('CPF SENHA TOKEN DADOS PRIVADOS'); }
    });
    expect(resultado).toEqual({ ok: true, acao: 'mensagem_registrada' });
    expect(banco.salvas).toHaveLength(1);
    expect(erro.mock.calls).toEqual([['COMPROVANTE_CICLO_FALHOU']]);
  });
});

describe('adaptador de extração reaproveita o cliente NVIDIA existente', () => {
  it('webhook chega ao adaptador com cliente e mídia falsos; só campos extraídos chegam à regra', async () => {
    const c = ciclo(); const lido = leitura();
    const lerMidia = vi.fn(async (_mensagem: DadosMensagemEvolution) => ({ base64: 'aW1hZ2VtLWZpY3RpY2lh', mimetype: 'image/png' }));
    fronteiras.completar.mockResolvedValueOnce(JSON.stringify({ ...lido, emitir: true, cpf: '11111111111', valorNotaCentavos: 1 }));
    c.deps.extrator = new ExtratorComprovanteNvidia('chave-ficticia', 'modelo-configurado-ficticio', lerMidia);
    const payload = evento();
    expect(await processarMensagemWebhook(payload, 'segredo-ficticio', c.webhook)).toEqual({ ok: true, acao: 'mensagem_registrada' });
    expect(lerMidia).toHaveBeenCalledExactlyOnceWith(payload.data);
    expect(fronteiras.completar).toHaveBeenCalledTimes(1);
    const [chave, modelo, mensagens, opcoes] = fronteiras.completar.mock.calls[0];
    expect([chave, modelo, opcoes]).toEqual(['chave-ficticia', 'modelo-configurado-ficticio', { formatoJson: true }]);
    expect(mensagens[1]).toEqual({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2VtLWZpY3RpY2lh' } }] });
    expect(JSON.stringify(mensagens)).not.toContain('52998224725');
    const auditoria = await c.historico.lerComprovantes('medico-ficticio');
    const decisao = await c.receber.mock.results[0].value;
    expect(auditoria[0]).toEqual(auditarComprovante(config.appPepper, c.estado, lido, decisao));
    expect(JSON.stringify(auditoria)).not.toContain('52998224725');
    expect(decisao).toEqual({ tipo: 'pedido_nota_pronto', motivo: 'VALOR_IGUAL_ULTIMA_CONSULTA', pedido: {
      medicoId: 'medico-ficticio', valorCentavos: 35000, dataPagamento: '2026-10-18', paciente: c.estado.paciente } });
    expect(c.logs).toEqual([['info', 'pediria nota pedido_nota_pronto']]);
  });
  it.each(['ilegivel', 'nao_comprovante'] as const)('preserva %s declarado pelo extrator', async tipo => {
    fronteiras.completar.mockResolvedValueOnce(JSON.stringify({ tipo }));
    const extrator = new ExtratorComprovanteNvidia('chave-ficticia', 'modelo-ficticio', async () => ({ base64: 'aW1hZ2Vt', mimetype: 'image/jpeg' }));
    expect(await extrator.extrair(evento().data)).toEqual({ tipo });
  });
  it.each(['não é JSON', '{"tipo":"extraido","campos":{"valorCentavos":"inventado"}}'])('resposta inválida fica como dúvida auditada: %s', async resposta => {
    const c = ciclo(); fronteiras.completar.mockResolvedValueOnce(resposta);
    c.deps.extrator = new ExtratorComprovanteNvidia('chave-ficticia', 'modelo-ficticio', async () => ({ base64: 'aW1hZ2Vt', mimetype: 'image/jpeg' }));
    await processarMensagemWebhook(evento(), 'segredo-ficticio', c.webhook);
    expect((await c.historico.lerComprovantes('medico-ficticio'))[0]).toMatchObject({ lido: null,
      decisao: { tipo: 'perguntar_medico', motivo: 'LEITURA_INDISPONIVEL' } });
    expect(c.logs).toEqual([['info', 'enviaria perguntar_medico']]);
  });
  it.each([null, { base64: 'cGRmLWZpY3RpY2lv', mimetype: 'application/pdf' }])('mídia ausente ou sem suporte visual não chama IA nem inventa conversão', async midia => {
    const extrator = new ExtratorComprovanteNvidia('chave-ficticia', 'modelo-ficticio', async () => midia);
    await expect(extrator.extrair(evento().data)).rejects.toThrow();
    expect(fronteiras.completar).not.toHaveBeenCalled();
  });
});
