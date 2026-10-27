import { describe, expect, it, vi } from 'vitest';
import { decidirConversa, montarContexto, type ContextoAssistente } from '../src/assistente/conversa.js';
import { receberMensagemAssistente } from '../src/assistente/entrada.js';
import { executarPassoAssistente, type DependenciasWorkerAssistente } from '../src/assistente/worker.js';
import { ErroNvidiaChat } from '../src/io/nvidia/chat-client.js';

const medicoId = '11111111-1111-4111-8111-111111111111';
const contexto: ContextoAssistente = {
  memoria: { agenda: 'Amplimed', periodo: 'desde setembro', profissionais: ['Ana'] },
  mensagens: [{ papel: 'cliente', texto: 'Já informei a agenda.', criadoEm: '2026-10-26T10:00:00Z' }],
  medicos: [{ id: medicoId, nome: 'Ana' }], trabalhos: []
};

describe('conversa contextual do Noto', () => {
  it('retoma memória, mensagens e trabalhos sem transformar memória em autorização', () => {
    const mensagens = montarContexto(contexto);
    expect(mensagens[0].content).toContain('não representam autorização');
    expect(JSON.parse(String(mensagens[1].content))).toEqual(contexto);
  });

  it('preserva informações antecipadas e aceita consulta somente ao médico permitido', async () => {
    const modelo = vi.fn().mockResolvedValue(JSON.stringify({ resposta: 'Vou consultar a preparação de Ana.',
      memoria: { profissionais: ['Ana', 'Bruno'] }, consultarPreparacao: [medicoId] }));
    const decisao = await decidirConversa(contexto, modelo);
    expect(decisao.memoria).toEqual({ ...contexto.memoria, profissionais: ['Ana', 'Bruno'] });
    expect(decisao.consultarPreparacao).toEqual([medicoId]);
  });

  it('veta médico de outra conta e operações que o modelo inventar', async () => {
    const outraConta = () => Promise.resolve(JSON.stringify({ resposta: 'Ok', memoria: {},
      consultarPreparacao: ['22222222-2222-4222-8222-222222222222'] }));
    await expect(decidirConversa(contexto, outraConta)).rejects.toThrow('MEDICO_NAO_PERMITIDO');
    const emitir = () => Promise.resolve(JSON.stringify({ resposta: 'Emitida', memoria: {}, consultarPreparacao: [], emitir: true }));
    await expect(decidirConversa(contexto, emitir)).rejects.toThrow();
  });

  it('não usa resposta incompleta, memória ilimitada ou saída inválida', async () => {
    for (const saida of ['não é JSON', '{}', JSON.stringify({ resposta: 'Ok', memoria: { agenda: 'a'.repeat(501) }, consultarPreparacao: [] })]) {
      await expect(decidirConversa(contexto, async () => saida)).rejects.toThrow();
    }
  });
});

const payload = (mudancas: Record<string, unknown> = {}) => ({
  event: 'messages.upsert', instance: 'noto-assistente',
  data: { key: { id: 'msg-1', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
    message: { conversation: 'Usamos Amplimed, desde setembro.' } }, ...mudancas
});
const entrada = () => ({ segredo: 'segredo-teste', instancia: 'noto-assistente',
  registrar: vi.fn().mockResolvedValue('registrada') });

describe('entrada isolada do WhatsApp', () => {
  it('não entrega mensagens sem autenticação à persistência', async () => {
    const deps = entrada();
    expect(await receberMensagemAssistente(payload(), 'errado', deps)).toEqual({ status: 401 });
    expect(deps.registrar).not.toHaveBeenCalled();
  });

  it('ignora grupos, ecos, histórico, outras instâncias e identidade alternativa ambígua', async () => {
    const deps = entrada();
    const original = payload();
    const invalidos = [payload({ instance: 'outra' }), payload({ event: 'messages.set' }),
      { ...original, data: { ...original.data, key: { ...original.data.key, fromMe: true } } },
      { ...original, data: { ...original.data, key: { ...original.data.key, remoteJid: '123@g.us' } } },
      { ...original, data: { ...original.data, key: { ...original.data.key, remoteJidAlt: '5511888888888@s.whatsapp.net' } } }];
    for (const p of invalidos) expect((await receberMensagemAssistente(p, deps.segredo, deps)).status).toBe(202);
    expect(deps.registrar).not.toHaveBeenCalled();
  });

  it('registra texto privado com chave original para deduplicação', async () => {
    const deps = entrada();
    expect(await receberMensagemAssistente(payload(), deps.segredo, deps)).toEqual({ status: 202 });
    expect(deps.registrar).toHaveBeenCalledWith({ instancia: 'noto-assistente', mensagemId: 'msg-1',
      telefone: '5511999999999', texto: 'Usamos Amplimed, desde setembro.' });
  });

  it('aceita LID apenas acompanhado do telefone fornecido pelo webhook autenticado', async () => {
    const deps = entrada(), original = payload();
    await receberMensagemAssistente({ ...original, data: { ...original.data,
      key: { ...original.data.key, remoteJid: '123456@lid', remoteJidAlt: '5511999999999@s.whatsapp.net' } } }, deps.segredo, deps);
    expect(deps.registrar).toHaveBeenCalledWith(expect.objectContaining({ telefone: '5511999999999' }));
    deps.registrar.mockClear();
    await receberMensagemAssistente({ ...original, data: { ...original.data,
      key: { ...original.data.key, remoteJid: '123456@lid' } } }, deps.segredo, deps);
    expect(deps.registrar).not.toHaveBeenCalled();
  });
});

function dependenciasWorker(): DependenciasWorkerAssistente {
  return {
    repositorio: {
      reservar: vi.fn().mockResolvedValue({ id: 'trabalho', usuario_id: 'usuario', conta_id: 'conta',
        medico_id: medicoId, tipo: 'preparacao', chave: 'chave', token: 'token',
        conteudo: { telefone: '5511999999999', texto: 'Resultado' } }),
      contexto: vi.fn().mockResolvedValue(contexto),
      concluirConversa: vi.fn(), medicosPermitidos: vi.fn().mockResolvedValue(contexto.medicos),
      concluirPreparacao: vi.fn(), destinoPermitido: vi.fn().mockResolvedValue(true),
      confirmarEnvio: vi.fn(), falhar: vi.fn(), registrarDiagnosticoEnvio: vi.fn()
    },
    modelo: vi.fn().mockResolvedValue(JSON.stringify({ resposta: 'Olá', memoria: {}, consultarPreparacao: [] })),
    consultarPreparacao: vi.fn().mockResolvedValue({ liberadoParaEmitir: false }),
    enviar: vi.fn().mockResolvedValue({ sucesso: true, mensagemId: 'msg-enviada' }),
    registrarFalha: vi.fn()
  };
}

describe('execução dos especialistas e comunicação', () => {
  it('não executa consulta para médico fora do escopo', async () => {
    const deps = dependenciasWorker();
    vi.mocked(deps.repositorio.medicosPermitidos).mockResolvedValue([]);
    await executarPassoAssistente('preparacao', deps);
    expect(deps.consultarPreparacao).not.toHaveBeenCalled();
    expect(deps.repositorio.falhar).toHaveBeenCalledOnce();
  });

  it('não publica resultado após revogação durante o trabalho', async () => {
    const deps = dependenciasWorker();
    vi.mocked(deps.repositorio.medicosPermitidos).mockResolvedValueOnce(contexto.medicos).mockResolvedValueOnce([]);
    await executarPassoAssistente('preparacao', deps);
    expect(deps.consultarPreparacao).toHaveBeenCalledWith(medicoId);
    expect(deps.repositorio.concluirPreparacao).not.toHaveBeenCalled();
  });

  it('uma falha técnica não é publicada como conclusão', async () => {
    const deps = dependenciasWorker();
    vi.mocked(deps.consultarPreparacao).mockRejectedValue(Error('detalhe técnico restrito'));
    await executarPassoAssistente('preparacao', deps);
    expect(deps.repositorio.concluirPreparacao).not.toHaveBeenCalled();
    expect(deps.registrarFalha).toHaveBeenCalledWith('trabalho', 'preparacao',
      expect.objectContaining({ etapa: 'consultar_preparacao', mensagem: 'detalhe técnico restrito' }));
    expect(deps.enviar).not.toHaveBeenCalled();
  });

  it('saída inválida do modelo não cria ferramentas ou resposta de sucesso', async () => {
    const deps = dependenciasWorker();
    vi.mocked(deps.modelo).mockResolvedValue('inválido');
    await executarPassoAssistente('conversa', deps);
    expect(deps.repositorio.concluirConversa).not.toHaveBeenCalled();
    expect(deps.repositorio.falhar).toHaveBeenCalledOnce();
  });

  it('envio sem confirmação permanece incerto sem nova tentativa', async () => {
    const deps = dependenciasWorker();
    vi.mocked(deps.enviar).mockResolvedValue({ sucesso: false });
    await executarPassoAssistente('envio', deps);
    expect(deps.enviar).toHaveBeenCalledOnce();
    expect(deps.repositorio.confirmarEnvio).not.toHaveBeenCalled();
    expect(deps.repositorio.falhar).not.toHaveBeenCalled();
    expect(deps.repositorio.registrarDiagnosticoEnvio).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ etapa: 'enviar_mensagem', codigo: 'ENVIO_NAO_CONFIRMADO' }));
  });

  it('não envia mensagem se o destinatário perdeu o acesso', async () => {
    const deps = dependenciasWorker();
    vi.mocked(deps.repositorio.destinoPermitido).mockResolvedValue(false);
    await executarPassoAssistente('envio', deps);
    expect(deps.enviar).not.toHaveBeenCalled();
  });

  it('falha em decidir Amplimed preserva HTTP e não salva agenda nem inicia preparação', async () => {
    const deps = dependenciasWorker();
    vi.mocked(deps.repositorio.contexto).mockResolvedValue({ ...contexto,
      mensagens: [{ papel: 'cliente', texto: 'Amplimed', criadoEm: '2026-10-27T10:00:00Z' }] });
    vi.mocked(deps.modelo).mockRejectedValue(new ErroNvidiaChat('IA_HTTP_ERRO', 429));
    await executarPassoAssistente('conversa', deps);
    expect(deps.repositorio.concluirConversa).not.toHaveBeenCalled();
    expect(deps.consultarPreparacao).not.toHaveBeenCalled();
    expect(deps.repositorio.falhar).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ etapa: 'decidir_conversa', codigo: 'IA_HTTP_ERRO', statusHttp: 429 }));
  });

  it('distingue falha ao carregar contexto de falha ao chamar o modelo', async () => {
    const deps = dependenciasWorker();
    vi.mocked(deps.repositorio.contexto).mockRejectedValue(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));
    await executarPassoAssistente('conversa', deps);
    expect(deps.modelo).not.toHaveBeenCalled();
    expect(deps.registrarFalha).toHaveBeenCalledWith('trabalho', 'conversa',
      expect.objectContaining({ etapa: 'carregar_contexto', codigo: 'ECONNREFUSED' }));
  });

  it('preserva o diagnóstico original mesmo quando registrar a falha no banco também falha', async () => {
    const deps = dependenciasWorker();
    vi.mocked(deps.modelo).mockRejectedValue(new ErroNvidiaChat('IA_HTTP_ERRO', 503));
    vi.mocked(deps.repositorio.falhar).mockRejectedValue(Error('BANCO_INDISPONIVEL'));
    await executarPassoAssistente('conversa', deps);
    expect(deps.registrarFalha).toHaveBeenNthCalledWith(1, 'trabalho', 'conversa',
      expect.objectContaining({ etapa: 'decidir_conversa', statusHttp: 503 }));
    expect(deps.registrarFalha).toHaveBeenNthCalledWith(2, 'trabalho', 'conversa',
      expect.objectContaining({ etapa: 'registrar_falha', codigo: 'BANCO_INDISPONIVEL' }));
  });
});
