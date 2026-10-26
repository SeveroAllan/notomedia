import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExtratorRespostaMedicoNvidia } from '../src/io/nvidia/extrator-resposta-medico.js';
import { HistoricoComunicacaoEmMemoria } from '../src/onboarding/historico-comunicacao-repositorio.js';
import { orquestrarComunicacao } from '../src/onboarding/orquestrar-comunicacao.js';
const cliente = vi.hoisted(() => vi.fn());
vi.mock('../src/io/nvidia/chat-client.js', async (importOriginal) => ({ ...(await importOriginal() as object), completarOpenAi: cliente }));
const pergunta = 'Desde quando você não emite notas?';
const perguntaAgenda = 'Para eu achar suas consultas, preciso da sua agenda. Posso te mandar o link?';
const contexto = { acaoPendente: 'perguntar_nota_pendente' as const, pergunta, mensagens: ['Bom dia', pergunta] };
const dia = '2026-03-02';
let rede: ReturnType<typeof vi.spyOn>;
beforeEach(() => { cliente.mockReset(); rede = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw Error('REDE_PROIBIDA'); }); });
afterEach(() => { expect(rede).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

it.each([
  ['sim', contexto, { temNota: 'sim', desde: null, confianca: 0.95 }],
  ['pode ser', { acaoPendente: 'pedir_agenda', pergunta: perguntaAgenda, mensagens: [perguntaAgenda] }, { temNota: 'fora_do_assunto', desde: null, confianca: 0.95 }],
  ['Qual o seu horário?', contexto, { temNota: 'fora_do_assunto', desde: null, confianca: 0.95 }],
  ['nada ainda', contexto, { temNota: 'não', desde: null, confianca: 0.95 }],
  ['só a de ontem', contexto, { temNota: 'sim', desde: '2026-03-01', confianca: 0.95 }],
  ['tem sim, desde segunda', contexto, { temNota: 'sim', desde: dia, confianca: 0.95 }]
])('cliente falso extrai %s à luz da pergunta exata', async (texto, recebido, campos) => {
  cliente.mockResolvedValue(JSON.stringify(campos));
  const extrator = new ExtratorRespostaMedicoNvidia('credencial-ficticia', 'modelo-ficticio');
  expect(await (extrator.extrair as any)(texto, dia, recebido)).toEqual(campos);
  expect(cliente.mock.calls[0][2][1]).toEqual({ role: 'user', content: JSON.stringify({ texto, dataMensagem: dia, contexto: recebido }) });
});
it('a mesma palavra sim recebe a pergunta correta, sem confundir nota e agenda', async () => {
  cliente.mockImplementation(async (_chave, _modelo, mensagens) => {
    const { contexto: c } = JSON.parse(mensagens[1].content);
    return JSON.stringify({ temNota: c.acaoPendente === 'perguntar_nota_pendente' ? 'sim' : 'fora_do_assunto', desde: null, confianca: 0.95 });
  });
  const extrator = new ExtratorRespostaMedicoNvidia('credencial-ficticia', 'modelo-ficticio');
  expect(await (extrator.extrair as any)('sim', dia, contexto)).toMatchObject({ temNota: 'sim' });
  expect(await (extrator.extrair as any)('sim', dia, { acaoPendente: 'pedir_agenda', pergunta: perguntaAgenda, mensagens: [perguntaAgenda] })).toMatchObject({ temNota: 'fora_do_assunto' });
});
it('limita o contexto a quatro textos e não serializa campos extras do chamador', async () => {
  cliente.mockResolvedValue(JSON.stringify({ temNota: 'sim', desde: null, confianca: 0.95 }));
  const mensagens = ['Bom dia', 'Olá', 'Tudo bem?', 'Tudo certo', pergunta, 'Pode explicar?'];
  const extrator = new ExtratorRespostaMedicoNvidia('credencial-ficticia', 'modelo-ficticio');
  await (extrator.extrair as any)('sim', dia, { ...contexto, mensagens, campoExtra: 'NAO_SERIALIZAR' });
  const conteudo = JSON.parse(cliente.mock.calls[0][2][1].content);
  expect(conteudo.contexto).toEqual({ ...contexto, mensagens: mensagens.slice(-4) });
  expect(JSON.stringify(conteudo)).not.toContain('NAO_SERIALIZAR');
});

async function cenario() {
  const historico = new HistoricoComunicacaoEmMemoria(); const logs: string[] = [];
  void historico.semearPerguntaAgendaFeita('medico-ficticio', 'real', '2026-01-01T00:00:00.000Z'); void historico.semearPerguntaAgendaFeita('medico-ficticio', 'simulado', '2026-01-01T00:00:00.000Z'); 
  const extrair = vi.fn(async (..._args: unknown[]) => ({ temNota: 'sim' as 'sim' | 'fora_do_assunto' | 'incerto', desde: null as string | null, confianca: 0.95 }));
  const entrada = { medicoId: 'medico-ficticio', chaveProcessamento: 'inicio', estado: { agora: new Date('2026-03-02T15:00:00Z'),
    fiscal: { certificado: 'ok' as const, dadosFiscais: 'ok' as const }, agenda: { nome: null, conectada: false }, ultimaNota: null } };
  const deps = { historico, envioRealAtivo: false, extratorResposta: { extrair }, log: (_nivel: string, texto: string) => logs.push(texto) };
  await orquestrarComunicacao(entrada, deps); await orquestrarComunicacao({ ...entrada, chaveProcessamento: 'pergunta' }, deps); logs.length = 0;
  return { historico, logs, extrair, entrada, deps };
}
it('orquestrador fornece pergunta do histórico e mensagens elegíveis explicitamente injetadas', async () => {
  const c = await cenario();
  await orquestrarComunicacao({ ...c.entrada, chaveProcessamento: 'resposta', respostaMedico: { texto: 'sim', dataMensagem: dia, mensagensSeguras: ['Bom dia', pergunta] } } as any, c.deps as any);
  expect(c.extrair).toHaveBeenCalledExactlyOnceWith('sim', dia, contexto);
  expect((await c.historico.ler('medico-ficticio', 'simulado')).perguntaNota.resposta).toEqual({ temNota: true, desde: null });
});
it('fora do assunto não grava resposta nem ação e não força repergunta', async () => {
  const c = await cenario(); c.extrair.mockResolvedValue({ temNota: 'fora_do_assunto', desde: null, confianca: 0.95 });
  const antes = await c.historico.ler('medico-ficticio', 'simulado');
  expect(await orquestrarComunicacao({ ...c.entrada, chaveProcessamento: 'outro-assunto', respostaMedico: { texto: 'Como funciona seu serviço?', dataMensagem: dia } }, c.deps as any)).toEqual({ tipo: 'nenhuma' });
  const depois = await c.historico.ler('medico-ficticio', 'simulado');
  expect(depois).toEqual(antes); expect(c.logs).toEqual([]);
});
it('trocar de assunto não consome a resposta futura à pergunta pendente', async () => {
  const c = await cenario(); c.extrair.mockResolvedValueOnce({ temNota: 'fora_do_assunto', desde: null, confianca: 0.95 });
  await orquestrarComunicacao({ ...c.entrada, chaveProcessamento: 'fora', respostaMedico: { texto: 'E a mensalidade?', dataMensagem: dia } }, c.deps as any);
  expect((await c.historico.ler('medico-ficticio', 'simulado')).perguntaNota.resposta).toBeNull();
  await orquestrarComunicacao({ ...c.entrada, chaveProcessamento: 'resposta', respostaMedico: { texto: 'sim', dataMensagem: dia } }, c.deps as any);
  expect((await c.historico.ler('medico-ficticio', 'simulado')).perguntaNota.resposta).toEqual({ temNota: true, desde: null });
});
it('confiança baixa continua incerta e permite só a repergunta existente', async () => {
  const c = await cenario(); c.extrair.mockResolvedValue({ temNota: 'incerto', desde: null, confianca: 0.40 });
  const entrada = { ...c.entrada, chaveProcessamento: 'incerto', respostaMedico: { texto: 'pode ser', dataMensagem: dia } };
  expect(await orquestrarComunicacao(entrada, c.deps as any)).toEqual({ tipo: 'reperguntar', pergunta: 'nota_pendente' });
  expect(await orquestrarComunicacao({ ...entrada, chaveProcessamento: 'outro' }, c.deps as any)).toEqual({ tipo: 'nenhuma' });
});

it('contexto não aceita objetos no lugar de texto e não os envia ao cliente', async () => {
  cliente.mockResolvedValue(JSON.stringify({ temNota: 'sim', desde: null, confianca: 0.95 }));
  const extrator = new ExtratorRespostaMedicoNvidia('credencial-ficticia', 'modelo-ficticio');
  await expect((extrator.extrair as any)('sim', dia, { ...contexto, mensagens: [{ campoPrivado: 'NAO_ENVIAR' }] })).rejects.toThrow();
  expect(cliente).not.toHaveBeenCalled();
});

it('fora do assunto abaixo de 0,90 continua incerto, sem dispensar a validação do 9b', async () => {
  const c = await cenario(); c.extrair.mockResolvedValue({ temNota: 'fora_do_assunto', desde: null, confianca: 0.40 });
  const entrada = { ...c.entrada, chaveProcessamento: 'baixa', respostaMedico: { texto: 'pode ser', dataMensagem: dia } };
  expect(await orquestrarComunicacao(entrada, c.deps as any)).toEqual({ tipo: 'reperguntar', pergunta: 'nota_pendente' });
  expect((await c.historico.ler('medico-ficticio', 'simulado')).perguntaNota.resposta).toBeNull();
});

it('o cliente de IA recebe texto atual e contexto mascarados, sem dados identificadores', async () => {
  cliente.mockResolvedValue(JSON.stringify({ temNota: 'sim', desde: null, confianca: 0.95 }));
  const extrator = new ExtratorRespostaMedicoNvidia('credencial-ficticia', 'modelo-ficticio');
  await extrator.extrair('sim, CPF 529.982.247-25', dia, { ...contexto, mensagens: ['CNPJ 12.345.678/0001-90', 'e-mail medico@example.invalid', 'telefone +55 (11) 99999-0000', 'protocolo 98765432101234567890'] });
  const conteudo = JSON.parse(cliente.mock.calls[0][2][1].content);
  expect(conteudo.texto).toBe('sim, CPF [OCULTO]');
  expect(conteudo.contexto.mensagens).toEqual(['CNPJ [OCULTO]', 'e-mail [OCULTO]', 'telefone [OCULTO]', 'protocolo [OCULTO]']);
});
