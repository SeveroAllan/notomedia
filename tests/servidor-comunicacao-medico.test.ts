import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BancoHistoricoFalso } from './fakes/banco-historico.js';
import { criarAppExpress } from '../src/server.js';
import { config } from '../src/config.js';
import { EvolutionApiClient } from '../src/io/evolution/evolution-api-client.js';
const fronteiras = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), agenda: vi.fn(), completar: vi.fn(), sincronizar: vi.fn(), emitir: vi.fn() }));
vi.mock('../src/io/nvidia/chat-client.js', async (importOriginal) => ({ ...(await importOriginal() as object), completarOpenAi: fronteiras.completar }));
vi.mock('../src/io/postgres/pool.js', () => ({ pool: { query: fronteiras.query, connect: fronteiras.connect } }));
vi.mock('../src/cofre/router.js', async () => { const express = await import('express'); return { criarCofreContas: () => ({ app: express.default(), statusAgenda: fronteiras.agenda, encerrar: async () => {} }) }; });
vi.mock('../src/onboarding/io/sincronizar-historico-evolution.js', () => ({ sincronizarHistoricoEvolutionUmaVez: fronteiras.sincronizar }));
vi.mock('../src/api/nfse/processar-solicitacao-emissao-api.js', () => ({ processarSolicitacaoEmissaoApi: fronteiras.emitir }));
const medico = '00000000-0000-4000-8000-000000000001';
let banco: BancoHistoricoFalso; let logs: ReturnType<typeof vi.spyOn>, erros: ReturnType<typeof vi.spyOn>;
let rede: ReturnType<typeof vi.spyOn>, enviar: ReturnType<typeof vi.spyOn>, pdf: ReturnType<typeof vi.spyOn>;
const anterior = { ativo: config.comunicacaoMedicoAtiva, segredo: config.evolutionWebhookSecret, apiKey: config.openaiApiKey, modelo: config.openaiTextoModel };
beforeEach(() => {
  vi.clearAllMocks(); banco = new BancoHistoricoFalso(); config.comunicacaoMedicoAtiva = true; config.evolutionWebhookSecret = 'segredo-ficticio'; config.openaiApiKey = 'credencial-ficticia'; config.openaiTextoModel = 'modelo-ficticio';
  fronteiras.completar.mockResolvedValue(JSON.stringify({ temNota: 'não', desde: null, confianca: 0.90 }));
  fronteiras.connect.mockImplementation(() => banco.connect()); fronteiras.agenda.mockResolvedValue({ nome: null, conectada: false });
  fronteiras.sincronizar.mockResolvedValue({});
  const entradas = new Set<string>();
  fronteiras.query.mockImplementation(async (sql: string, parametros: unknown[] = []) => {
    if (sql.includes("values ($1, 'mensagem_recebida'")) {
      const chave = JSON.stringify(parametros); if (entradas.has(chave)) return { rows: [] };
      entradas.add(chave); return { rows: [{ id: 'entrada' }] };
    }
    if (sql.includes('as cert_ativos')) return { rows: [{ medico_id: medico, medico_nome: 'Medica Ficticia', crm: '12345/SC', rqe: null, confirmado_pelo_medico: true,
      cert_ativos: '1', whats_conectados: '1', whatsapp_vinculado: true,
      revisao_profissional: { estado: 'concluido', dados: { aprovacaoPainel: { confirmadoEm: '2026-10-17T15:00:00Z', nome: 'Medica Ficticia', crm: '12345/SC', rqe: null } } } }] };
    if (sql.includes('from notas_fiscais')) return { rows: [] };
    if (sql.includes('regexp_replace(u.telefone')) return { rows: [{ id: medico, nome_completo: 'Medica Ficticia', crm: '12345/SC', telefone: '5511999990000' }] };
    if (sql.includes('update whatsapp_instancias')) return { rows: [{ medico_id: medico }] };
    throw Error('SQL_FORA_DO_TESTE');
  });
  rede = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw Error('REDE_PROIBIDA'); });
  enviar = vi.spyOn(EvolutionApiClient.prototype, 'enviarTexto').mockImplementation(() => { throw Error('ENVIO_PROIBIDO'); });
  pdf = vi.spyOn(EvolutionApiClient.prototype, 'enviarPdf').mockImplementation(() => { throw Error('PDF_PROIBIDO'); });
  logs = vi.spyOn(console, 'info').mockImplementation(() => {}); erros = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(rede).not.toHaveBeenCalled(); expect(enviar).not.toHaveBeenCalled(); expect(pdf).not.toHaveBeenCalled(); expect(fronteiras.emitir).not.toHaveBeenCalled();
  config.comunicacaoMedicoAtiva = anterior.ativo; config.evolutionWebhookSecret = anterior.segredo; config.openaiApiKey = anterior.apiKey; config.openaiTextoModel = anterior.modelo; vi.restoreAllMocks();
});
function mensagem(id: string, texto = 'Olá') { return { event: 'messages.upsert', instance: config.evolutionAssistantInstanceName, data: {
  messageTimestamp: 1772422200, key: { id, remoteJid: '5511999990000@s.whatsapp.net', fromMe: false }, message: { conversation: texto }
} }; }
async function receber(body: unknown, app = criarAppExpress()) {
  const handler = (app as any).router.stack.find((c: any) => c.route?.path === '/webhook/evolution').route.stack[0].handle;
  let status = 200; let corpo: any;
  const res = { status(n: number) { status = n; return res; }, json(c: unknown) { corpo = c; return res; } };
  await handler({ body, headers: { apikey: 'segredo-ficticio' }, query: {} }, res);
  return { app, status, corpo };
}
const intencoes = () => logs.mock.calls.filter((args: unknown[]) => typeof args[0] === 'string' && /^enviaria /.test(args[0]));
it('flag desligada no app preserva descarte e não toca banco/cofre/histórico', async () => {
  config.comunicacaoMedicoAtiva = false;
  expect((await receber(mensagem('m1'))).corpo).toEqual({ ok: true, acao: 'descartada', motivoDescarte: 'gatilho_nao_reconhecido' });
  expect(fronteiras.completar).not.toHaveBeenCalled(); expect(fronteiras.query).not.toHaveBeenCalled(); expect(fronteiras.connect).not.toHaveBeenCalled(); expect(fronteiras.agenda).not.toHaveBeenCalled(); expect(intencoes()).toEqual([]);
});
it('assistente liga banco real do estado e histórico Postgres em ciclo seco com resposta registrada', async () => {
  const { app } = await receber(mensagem('m1'));
  await receber(mensagem('m2'), app);
  await receber(mensagem('m3', 'não'), app);
  expect(intencoes()).toEqual([['enviaria boas_vindas'], ['enviaria perguntar_nota_pendente: Desde quando você não emite notas?'], ['enviaria aguardar_comprovante']]);
  expect(banco.historicos.get(JSON.stringify([medico, 'simulado']))!.resposta_nota).toEqual({ temNota: false, desde: null });
  expect([...banco.historicos.values()].map(h => h.modo).sort()).toEqual(['real', 'simulado']);
  expect(banco.historicos.get(JSON.stringify([medico, 'real']))).toMatchObject({ boas_vindas_em: null, pergunta_nota_em: null, resposta_nota: null });
  expect([...banco.tentativas.values()].every(t => t.modo === 'simulado')).toBe(true);
  expect(banco.envios.size).toBe(0);
  await receber(mensagem('m3', 'não'), app); expect(intencoes()).toHaveLength(3); expect(erros).not.toHaveBeenCalled();
});
it('conexão autenticada do consultório aciona boas-vindas uma vez após onboarding', async () => {
  const evento = { event: 'connection.update', instance: 'clinica-ficticia', data: { state: 'open' } };
  const { app, corpo } = await receber(evento); expect(corpo).toEqual({ ok: true, acao: 'conexao_atualizada' });
  await receber(evento, app); expect(intencoes()).toEqual([['enviaria boas_vindas']]);
});
it('falha do status do cofre não inventa agenda desconectada nem derruba webhook', async () => {
  fronteiras.agenda.mockRejectedValueOnce(Error('erro privado ficticio'));
  expect((await receber(mensagem('m1'))).status).toBe(200);
  expect(intencoes()).toEqual([]); expect(erros.mock.calls).toEqual([['COMUNICACAO_ESTADO_FALHOU']]); expect(banco.tentativas.size).toBe(0);
});
it('flag desligada no evento de conexão não acrescenta consultas de comunicação', async () => {
  config.comunicacaoMedicoAtiva = false;
  await receber({ event: 'connection.update', instance: 'clinica-ficticia', data: { state: 'open' } });
  expect(fronteiras.query).toHaveBeenCalledTimes(1); expect(fronteiras.connect).not.toHaveBeenCalled(); expect(fronteiras.agenda).not.toHaveBeenCalled(); expect(intencoes()).toEqual([]);
});

it('mensagem atrasada calcula hoje pelo timestamp recebido, nunca pelo relógio do servidor', async () => {
  fronteiras.completar.mockResolvedValue(JSON.stringify({ temNota: 'sim', desde: '2026-10-18', confianca: 0.90 }));
  const { app } = await receber(mensagem('m1')); await receber(mensagem('m2'), app);
  await receber(mensagem('m3', 'tenho sim desde hoje'), app);
  expect(banco.historicos.get(JSON.stringify([medico, 'simulado']))!.resposta_nota).toEqual({ temNota: true, desde: '2026-03-02' });
  expect(fronteiras.completar).toHaveBeenCalledTimes(1);
  expect(fronteiras.completar.mock.calls[0][2][1]).toEqual({ role: 'user', content: JSON.stringify({ texto: 'tenho sim desde hoje', dataMensagem: '2026-03-02', contexto: { acaoPendente: 'perguntar_nota_pendente', pergunta: 'Desde quando você não emite notas?', mensagens: ['Olá', 'Olá', 'Desde quando você não emite notas?'] } }) });
});
it('timestamp ausente não é substituído pelo processamento e repergunta sem chamar IA', async () => {
  const { app } = await receber(mensagem('m1')); await receber(mensagem('m2'), app);
  const payload = mensagem('m3', 'sim'); delete (payload.data as any).messageTimestamp;
  await receber(payload, app);
  expect(fronteiras.completar).not.toHaveBeenCalled();
  expect(banco.historicos.get(JSON.stringify([medico, 'simulado']))!.resposta_nota).toBeNull();
  expect(intencoes().at(-1)).toEqual(['enviaria reperguntar: Desde quando você não emite notas?']);
});

it('contexto real do app usa só quatro textos mascarados e não os persiste nem loga', async () => {
  fronteiras.completar.mockResolvedValue(JSON.stringify({ temNota: 'fora_do_assunto', desde: null, confianca: 0.95 }));
  const { app } = await receber(mensagem('m1')); await receber(mensagem('m2'), app);
  const textos = ['CPF 529.982.247-25', 'CNPJ 12.345.678/0001-90', 'e-mail medico@example.invalid', 'telefone +55 (11) 99999-0000', 'protocolo 98765432101234567890'];
  for (let i = 0; i < textos.length; i++) await receber(mensagem(`p${i}`, textos[i]), app);
  const ultimo = JSON.parse(fronteiras.completar.mock.calls.at(-1)![2][1].content);
  expect(ultimo.texto).toBe('protocolo [OCULTO]');
  expect(ultimo.contexto.mensagens).toEqual(['CPF [OCULTO]', 'CNPJ [OCULTO]', 'e-mail [OCULTO]', 'telefone [OCULTO]']);
  const gravado = JSON.stringify([[...banco.historicos.values()], [...banco.tentativas.values()], [...banco.reservas.values()]]);
  const logado = JSON.stringify([logs.mock.calls, erros.mock.calls]);
  for (const texto of textos) { expect(gravado).not.toContain(texto); expect(logado).not.toContain(texto); }
  expect(gravado).not.toContain('[OCULTO]'); expect(logado).not.toContain('[OCULTO]');
});
it('nova instância do app não recupera textos da instância anterior', async () => {
  fronteiras.completar.mockResolvedValue(JSON.stringify({ temNota: 'fora_do_assunto', desde: null, confianca: 0.95 }));
  const { app } = await receber(mensagem('m1')); await receber(mensagem('m2'), app);
  await receber(mensagem('m3', 'Como funciona?'), app);
  expect(JSON.parse(fronteiras.completar.mock.calls.at(-1)![2][1].content).contexto.mensagens).not.toEqual([]);
  await receber(mensagem('m4', 'E a mensalidade?'), criarAppExpress());
  expect(JSON.parse(fronteiras.completar.mock.calls.at(-1)![2][1].content).contexto.mensagens).toEqual([]);
});
