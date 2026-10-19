import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import forge from 'node-forge';
import { gunzipSync } from 'node:zlib';
import type pg from 'pg';
import { BancoEmissaoComprovante } from './fakes/banco-emissao-comprovante.js';
import { criarAppExpress } from '../src/server.js';
import { config } from '../src/config.js';
import { PostgresAtendimentoRepositorio } from '../src/io/postgres/postgres-atendimento-repositorio.js';
import { PostgresFilaRepositorio } from '../src/io/postgres/postgres-fila-repositorio.js';
import { PostgresEmissorDpsService } from '../src/io/fiscal/postgres-emissor-dps-service.js';
import { SefinNacionalClient, type HttpMtlsTransmissor } from '../src/io/fiscal/sefin-nacional-client.js';
import type { EnviarPdfDanfse } from '../src/whatsapp/enviar-pdf-danfse.js';
import type { NotificadorAlertas } from '../src/worker/notificar-erro-medico.js';
import { EvolutionApiClient } from '../src/io/evolution/evolution-api-client.js';
import { processarItemFila } from '../src/worker/processar-item-fila.js';
import * as danfse from '../src/fiscal/danfse/gerar-danfse-pdf.js';

const borda = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), extrair: vi.fn(), agenda: vi.fn() }));
vi.mock('../src/io/postgres/pool.js', () => ({ pool: borda }));
vi.mock('../src/io/nvidia/chat-client.js', () => ({ completarNvidia: borda.extrair }));
vi.mock('../src/cofre/router.js', async () => {
  const { default: express } = await import('express');
  return { criarCofreContas: () => ({ app: express(), encerrar: async () => {}, statusAgenda: async () => ({ nome: 'agenda-falsa', conectada: true }), fonteAgenda: { consultar: borda.agenda } }) };
});

const senha = 'senha-exclusiva-fixture', nome = 'Ana Oliveira Ficticia';
const chaves = forge.pki.rsa.generateKeyPair(1024), cert = forge.pki.createCertificate();
cert.publicKey = chaves.publicKey; cert.serialNumber = '01';
cert.validity.notBefore = new Date('2020-01-01'); cert.validity.notAfter = new Date('2040-01-01');
cert.setSubject([{ name: 'commonName', value: 'CLINICA FICTICIA 11222333000181' }]); cert.setIssuer(cert.subject.attributes); cert.sign(chaves.privateKey);
const pfx = Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(chaves.privateKey, [cert], senha, { algorithm: '3des' })).getBytes(), 'binary');
const parametros = { ambiente: 'homologacao', vigenciaInicio: '2026-01-01', municipioPrestacao: '4205407', opcaoSimplesNacional: 'me_epp',
  regimeApuracaoSn: 'regime_1', regimeEspecialTributacao: 0, tribISSQN: 1, tpRetISSQN: 1, cstPisCofins: '08', percentualTotTribSN: 6 };
const perfil = { ambiente: 'homologacao', opcao: 'me_epp', regime: 'regime_1', especial: 0, municipio: '4205407', serie: '1', referencia: 'xml-ficticio' };

let banco: BancoEmissaoComprovante, notas: any[], app: ReturnType<typeof criarAppExpress>;
let info: ReturnType<typeof vi.spyOn>, erro: ReturnType<typeof vi.spyOn>, rede: ReturnType<typeof vi.spyOn>;
let transmitir: Mock<HttpMtlsTransmissor>, enviarPdf: Mock<EnviarPdfDanfse['enviarPdf']>, perguntar: Mock<NotificadorAlertas['notificarMedicoWhatsApp']>;
const anterior = { ...config };

// SQL falso na borda; decisão, auditoria, enfileiramento, worker, assinatura e cliente SEFIN são reais.
function sqlServidor(sql: string, valores: any[], base?: { query: (s: string, p?: any[]) => Promise<any> }): Promise<any> | any {
  const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  const resultado = (rows: any[] = [], rowCount = rows.length) => ({ rows: structuredClone(rows), rowCount });
  if (banco.falhar?.test(s)) throw Error('falha com SENHA_PRIVADA');
  if (s.startsWith('insert into public.noto_auditoria_comprovantes')) {
    banco.auditorias.push({ id: `auditoria-${banco.auditorias.length}`, medico_id: valores[0], lido: JSON.parse(valores[1]), estado: JSON.parse(valores[2]), decisao: JSON.parse(valores[3]) });
    return resultado();
  }
  if (s.startsWith('select lido, estado, decisao from public.noto_auditoria_comprovantes')) return resultado(banco.auditorias.filter(a => a.medico_id === valores[0]));
  if (s.includes('from pacientes p')) return resultado([{ ...banco.paciente }]);
  if (s.startsWith('select 1 from public.noto_emissoes_comprovantes')) return resultado(banco.emissoes.filter(e => e.medico_id === valores[0] && e.consulta_chave === valores[1] && e.estado === 'nota_gerada'));
  if (s.includes('from medicos m') && s.includes('cclass_trib_padrao')) return resultado([{ medico_id: 'medico', nome_completo: 'Clara Almeida Ficticia', crm: '12345/SC', confirmado_pelo_medico: true, ctrib_nac: '040101', cnbs: '122051000' }]);
  if (s.startsWith('with proximo as')) {
    const sol = banco.solicitacoes.find(sol => !sol.bloqueada && banco.emissoes.some(e => e.solicitacao_id === sol.id && e.estado === 'enfileirada'));
    if (!sol) return resultado(); sol.bloqueada = true;
    return resultado([{ id: sol.id, medico_id: sol.medico_id, paciente_id: sol.paciente_id, xdesc_serv: sol.descricao, valor_servico_centavos: sol.valor, ctrib_nac: '040101', cnbs: '122051000', tentativas: 0, emissao_comprovante: true }]);
  }
  if (s.startsWith('select ec.estado')) return resultado(banco.emissoes.filter(e => e.solicitacao_id === valores[0]).map(e => ({ estado: e.estado, ambiente: banco.ambiente })));
  if (s.includes('update public.noto_emissoes_comprovantes') && !s.includes('set solicitacao_id')) {
    const e = banco.emissoes.find(e => e.solicitacao_id === valores[0]);
    if (!e) return resultado();
    if (s.includes("set estado = 'nota_gerada'")) {
      if (e.estado !== 'emitindo' || e.nota_fiscal_id) return resultado();
      Object.assign(e, { estado: 'nota_gerada', nota_fiscal_id: valores[1], erro_codigo: null });
    } else if (s.includes("set estado = 'emitindo'")) {
      if (e.estado !== 'enfileirada') return resultado(); e.estado = 'emitindo';
    } else if (s.includes("set estado = 'erro'")) {
      if (e.estado !== 'emitindo') return resultado(); Object.assign(e, { estado: 'erro', erro_codigo: valores[1] });
    } else if (s.includes("set estado = 'bloqueada'")) Object.assign(e, { estado: 'bloqueada', erro_codigo: 'AMBIENTE_FISCAL_BLOQUEADO' });
    else throw Error('Atualização não modelada');
    return resultado([], 1);
  }
  if (s.startsWith('insert into notas_fiscais')) {
    if (notas.some(n => n.solicitacao_id === valores[1])) throw Error('UNIQUE_NOTA_SOLICITACAO');
    const nota = { id: 'nota-ficticia', solicitacao_id: valores[1], chave: valores[2], pdf_storage_path: valores[9] }; notas.push(nota); return resultado([nota]);
  }
  if (s.startsWith('update solicitacoes_nota set status') || s.startsWith('update medico_perfil_fiscal')) return resultado([], 1);
  if (s.includes('from medicos m join solicitacoes_nota')) return resultado([{ nome_completo: 'Clara Almeida Ficticia', crm: '12345/SC' }]);
  if (s.includes('from medico_perfil_fiscal pf')) return resultado([{ nome_completo: 'Clara Almeida Ficticia', razao_social: 'Consultorio Ficticio', documento_limpo: '11222333000181', uf: 'SC', cod_municipio_ibge: '4205407', serie_dps: '1', proximo_numero_dps: 1, ambiente: banco.ambiente, opcao_simples_nacional: 'me_epp', regime_apuracao_sn: 'regime_1', regime_especial_tributacao: 0, percentual_tot_trib_sn: 6 }]);
  if (s.includes('from solicitacoes_nota s join medico_perfil_fiscal')) return resultado([{ ...perfil, confirmado: true,
    servicos: [{ id: 'servico', ctribNac: '040101', cnbs: '122051000', ctribMun: null, politica: { parametros, confirmadoEm: '2026-10-18T12:00:00Z', origem: 'revisao_onboarding', perfil, ctribNac: '040101', cnbs: '122051000', ctribMun: null } }], datas: [] }]);
  if (s.includes('from pacientes') && !s.includes('from pacientes p')) return resultado([{ cpf_limpo: '52998224725', nome, nome_validado: true }]);
  if (s.includes('max(ndps)')) return resultado([{ proximo: 1 }]);
  if (s.includes('from medico_certificados')) return resultado([{ id: 'cert', medico_id: 'medico', arquivo_storage_path: 'fixture.pfx', senha_secret_id: 'vault', valido_ate: '2040-01-01' }]);
  if (s.includes('from vault.decrypted_secrets')) return resultado([{ secret: senha }]);
  if (base) return base.query(sql, valores);
  throw Error('SQL não modelado na integração: ' + s);
}

beforeEach(() => {
  vi.clearAllMocks(); banco = new BancoEmissaoComprovante(); banco.paciente = { nome, cpf: '52998224725' }; notas = [];
  config.emissaoComprovanteHomologacaoAtiva = true; config.comunicacaoMedicoAtiva = false; config.evolutionWebhookSecret = 'webhook-ficticio'; config.nvidiaApiKey = 'chave-ficticia';
  borda.agenda.mockResolvedValue({ tipo: 'consultas', fonte: 'agenda', consultas: [{ pacienteId: 'id-externo-na-agenda', telefonePaciente: '11999990000', idExterno: 'consulta', dataHora: '2026-10-18T10:00:00Z', status: 'realizada', valorConsultaCentavos: 20000 }] });
  borda.query.mockImplementation((s, p = []) => sqlServidor(s, p));
  borda.connect.mockImplementation(async () => {
    const client = await banco.connect(); let antes: any[] = [];
    return { release: client.release, query: async (s: string, p: any[] = []) => {
      if (s === 'begin') antes = structuredClone(notas);
      if (s === 'rollback') notas = antes;
      return sqlServidor(s, p, client);
    } };
  });
  borda.extrair.mockResolvedValue(JSON.stringify({ tipo: 'extraido', campos: { valorCentavos: 20000, dataPagamento: '2026-10-18', nomePagador: nome, nomeFavorecido: 'Clara Almeida Ficticia', confianca: { valorCentavos: 1, dataPagamento: 1, nomePagador: 1, nomeFavorecido: 1 } } }));
  vi.spyOn(PostgresAtendimentoRepositorio.prototype, 'buscarInstanciaPorNome').mockResolvedValue({ id: 'inst', medicoId: 'medico', nomeInstancia: 'clinica', oficial: false });
  vi.spyOn(PostgresAtendimentoRepositorio.prototype, 'buscarMedicoPorTelefone').mockResolvedValue(null);
  vi.spyOn(PostgresAtendimentoRepositorio.prototype, 'buscarOuCriarConversa').mockResolvedValue({ id: 'conversa', medicoId: 'medico', pacienteId: 'paciente', instanciaId: 'inst', contatoTelefone: '5511999990000', aguardandoCpfDesde: null });
  vi.spyOn(PostgresAtendimentoRepositorio.prototype, 'criarPacienteMinimo').mockResolvedValue({ id: 'paciente', medicoId: 'medico', nome, telefone: '5511999990000', cpfHash: null });
  vi.spyOn(PostgresAtendimentoRepositorio.prototype, 'salvarMensagem').mockResolvedValue();
  vi.spyOn(EvolutionApiClient.prototype, 'obterBase64MensagemMidia').mockResolvedValue({ mimetype: 'image/jpeg', base64: 'aW1hZ2Vt' });
  vi.spyOn(EvolutionApiClient.prototype, 'enviarTexto').mockImplementation(() => { throw Error('ENVIO_REAL_PROIBIDO'); });
  vi.spyOn(EvolutionApiClient.prototype, 'enviarPdf').mockImplementation(() => { throw Error('PDF_REAL_PROIBIDO'); });
  rede = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw Error('REDE_REAL_PROIBIDA'); });
  info = vi.spyOn(console, 'info').mockImplementation(() => {}); erro = vi.spyOn(console, 'error').mockImplementation(() => {});
  transmitir = vi.fn<HttpMtlsTransmissor>(async () => ({ status: 201, corpo: JSON.stringify({ chNFSe: '1'.repeat(50) }) }));
  enviarPdf = vi.fn<EnviarPdfDanfse['enviarPdf']>(async () => { throw Error('ENVIO_AO_PACIENTE_PROIBIDO'); }); perguntar = vi.fn<NotificadorAlertas['notificarMedicoWhatsApp']>().mockResolvedValue(); app = criarAppExpress();
});
afterEach(() => {
  expect(rede).not.toHaveBeenCalled(); expect(enviarPdf).not.toHaveBeenCalled();
  expect(JSON.stringify([info.mock.calls, erro.mock.calls, perguntar.mock.calls])).not.toMatch(/senha-exclusiva-fixture|SENHA_PRIVADA|52998224725/);
  Object.assign(config, anterior); vi.restoreAllMocks();
});
async function receber() {
  const handler = (app as any).router.stack.find((c: any) => c.route?.path === '/webhook/evolution').route.stack[0].handle;
  let status = 200, corpo: any;
  const res = { status(n: number) { status = n; return res; }, json(c: any) { corpo = c; return res; } };
  await handler({ headers: { apikey: 'webhook-ficticio' }, query: {}, body: { event: 'messages.upsert', instance: 'clinica', data: { key: { id: 'imagem', remoteJid: '5511999990000@s.whatsapp.net', fromMe: false }, message: { imageMessage: { mimetype: 'image/jpeg' } } } } }, res);
  expect({ status, corpo }).toEqual({ status: 200, corpo: { ok: true, acao: 'mensagem_registrada' } });
}
function worker() {
  const pool = { query: borda.query, connect: borda.connect } as unknown as pg.Pool;
  const supabase = { storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => Uint8Array.from(pfx).buffer }, error: null }), upload: async () => ({ error: null }) }) } };
  return { filaRepositorio: new PostgresFilaRepositorio(pool, false, true), emissorDps: new PostgresEmissorDpsService(pool, 'chave-ficticia', undefined, undefined, supabase as any, new SefinNacionalClient(transmitir), true, true),
    enviarPdfDanfse: { enviarPdf }, notificadorAlertas: { notificarMedicoWhatsApp: perguntar, notificarDesenvolvedorEmail: vi.fn() } };
}

it('flag desligada preserva auditoria seca sem acessar vínculo novo ou SEFIN', async () => {
  config.emissaoComprovanteHomologacaoAtiva = false; app = criarAppExpress(); await receber();
  expect(banco.auditorias[0].decisao).toEqual({ tipo: 'perguntar_medico', motivo: 'CADASTRO_INCOMPLETO' });
  expect(borda.agenda).not.toHaveBeenCalled(); expect(banco.emissoes).toEqual([]); expect(banco.solicitacoes).toEqual([]);
  expect(banco.comandos.some(s => s.includes('noto_emissoes_comprovantes'))).toBe(false); expect(transmitir).not.toHaveBeenCalled();
});
it('webhook, auditoria, fila, assinatura e SEFIN falsa autorizam uma vez e vinculam consulta sem enviar ao paciente', async () => {
  await receber(); await receber(); expect(banco.solicitacoes).toHaveLength(1);
  const deps = worker(), item = await deps.filaRepositorio.buscarETravarProximoItem('worker'); expect(item).not.toBeNull();
  const resultados = await Promise.all([processarItemFila(item!, deps), processarItemFila(item!, deps)]);
  expect(resultados.filter(r => r.ok)).toHaveLength(1); await processarItemFila(item!, deps);
  expect(transmitir).toHaveBeenCalledTimes(1); expect(transmitir.mock.calls[0][0]).toContain('producaorestrita');
  const xml = gunzipSync(Buffer.from(JSON.parse(transmitir.mock.calls[0][1]).dpsXmlGZipB64, 'base64')).toString();
  expect(xml).toContain('<tpAmb>2</tpAmb>'); expect(xml).toContain('<CPF>52998224725</CPF>'); expect(xml).toContain('<Signature');
  expect(notas).toHaveLength(1); expect(banco.emissoes[0]).toMatchObject({ estado: 'nota_gerada', nota_fiscal_id: notas[0].id });
  expect(notas[0].pdf_storage_path).toMatch(/^data:application\/pdf;base64,/);
  expect(JSON.stringify(banco.auditorias)).not.toContain('52998224725');
  expect(perguntar).not.toHaveBeenCalled(); await receber(); expect(banco.solicitacoes).toHaveLength(1);
});
it('recusa SEFIN não marca gerada, registra erro e pergunta ao médico sem retransmitir', async () => {
  transmitir.mockResolvedValue({ status: 400, corpo: JSON.stringify({ erros: [{ codigo: 'E123', descricao: 'SENHA_PRIVADA' }] }) });
  await receber(); const deps = worker(), item = await deps.filaRepositorio.buscarETravarProximoItem('worker'); expect(item).not.toBeNull();
  expect(await processarItemFila(item!, deps)).toMatchObject({ ok: false, status: 'necessita_intervencao' }); await processarItemFila(item!, deps);
  expect(transmitir).toHaveBeenCalledTimes(1); expect(notas).toEqual([]); expect(banco.emissoes[0]).toMatchObject({ estado: 'erro', erro_codigo: 'EMISSAO_COMPROVANTE_RECUSADA' });
  expect(perguntar).toHaveBeenCalledTimes(1); expect(perguntar.mock.calls[0][0].motivoErro).toContain('?');
});
it('produção recusa o pedido e registra bloqueio antes de criar solicitação', async () => {
  banco.ambiente = 'producao'; await receber(); expect(banco.solicitacoes).toEqual([]); expect(banco.emissoes[0]).toMatchObject({ estado: 'bloqueada' });
  expect(info.mock.calls).toContainEqual(['enviaria perguntar_medico']); expect(transmitir).not.toHaveBeenCalled();
});
it('mudança para produção depois de enfileirar é bloqueada no worker antes da SEFIN', async () => {
  await receber(); banco.ambiente = 'producao'; const deps = worker(), item = await deps.filaRepositorio.buscarETravarProximoItem('worker'); expect(item).not.toBeNull();
  expect(await processarItemFila(item!, deps)).toMatchObject({ ok: false, status: 'necessita_intervencao' });
  expect(notas).toEqual([]); expect(banco.emissoes[0].estado).toBe('bloqueada'); expect(transmitir).not.toHaveBeenCalled(); expect(perguntar).toHaveBeenCalledTimes(1);
});

it('indisponibilidade do PDF não apaga autorização SEFIN: comprovante guarda nota e XML sem PDF', async () => {
  const gerarPdf = vi.spyOn(danfse, 'generateDanfsePdf').mockRejectedValue(Error('PDF indisponível'));
  await receber(); const deps = worker(), item = await deps.filaRepositorio.buscarETravarProximoItem('worker'); expect(item).not.toBeNull();
  expect(await processarItemFila(item!, deps)).toMatchObject({ ok: true, status: 'emitida' });
  expect(transmitir).toHaveBeenCalledTimes(1); expect(gerarPdf).toHaveBeenCalledTimes(1);
  expect(notas[0].pdf_storage_path).toBeNull();
  expect(notas).toHaveLength(1); expect(banco.emissoes[0]).toMatchObject({ estado: 'nota_gerada', nota_fiscal_id: notas[0].id });
  expect(perguntar).not.toHaveBeenCalled();
});

it('emissão legada continua gerando PDF pela implementação real', async () => {
  const gerarPdf = vi.spyOn(danfse, 'generateDanfsePdf');
  await receber(); const deps = worker(), item = await deps.filaRepositorio.buscarETravarProximoItem('worker'); expect(item).not.toBeNull();
  const legado = { ...item! }; delete legado.emissaoComprovante;
  const resultado = await deps.emissorDps.emitir(legado);
  expect(resultado).toMatchObject({ sucesso: true, pdfStoragePath: expect.stringContaining('data:application/pdf;base64,') });
  expect(gerarPdf).toHaveBeenCalledTimes(1);
});
