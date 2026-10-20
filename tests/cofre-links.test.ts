import { ConversadorMedico } from '../src/onboarding/conversador-medico.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CofreTribemd } from '../src/cofre/tribemd-cofre.js';
import { NavegadorTribemd } from '../src/desenvolvedor/tribemd-navegador.js';
import pg from 'pg';
import express from 'express';
import { LinksCofre } from '../src/cofre/links.js';
import { criarRouterLinksCofre } from '../src/cofre/links-router.js';
import { ComunicacaoHomologacao } from '../src/whatsapp/comunicacao-homologacao.js';
import { carregarConfig } from '../src/config.js';
import { processarMensagemWebhook } from '../src/fluxos/processar-mensagem-webhook.js';
import { processarComunicacaoMedico } from '../src/onboarding/processar-comunicacao-medico.js';
import { MemoriaConversaMedico } from '../src/onboarding/contexto-conversa-medico.js';
import { HistoricoComunicacaoEmMemoria } from '../src/onboarding/historico-comunicacao-repositorio.js';
import { ExtratorRespostaMedicoNvidia } from '../src/io/nvidia/extrator-resposta-medico.js';
import type { AtendimentoRepositorio } from '../src/atendimento/atendimento-repositorio.js';

const medicoId = '11111111-1111-4111-8111-111111111111';
const outroId = '22222222-2222-4222-8222-222222222222';
const telefone = '5511999990000';
const dados = { email: 'teste@example.invalid', senha: 'credencial-ficticia-987', consentimento: 'tribemd-leitura-v1' };
type Link = { id: string; medico_id: string; agenda: string; token_hash: string; expira_em: Date; usado_em: Date | null; criado_em: Date };
let registros: Link[], auditoria: Array<{ link_id: string; evento: string }>;
let medico: { ativo: boolean; telefone: string } | null;
let estado: 'vazio' | 'desconectado' | 'conectado' | 'conectando' | 'salvo' | 'atencao';
let base: string, servidor: Server, links: LinksCofre;
let textos: string[], logs: unknown[], consultas: unknown[];
let flag: boolean, allowlist: string[];
const iniciar = vi.fn(async (_id: string, _dados?: { email: string; senha: string }) => ({ salvo: true, estado: 'conectando', ativo: true, verificadoEm: null, codigo: null, consultasDisponiveis: null }));
const classificar = vi.fn(async () => 'tribemd');
let bancoReal: pg.Pool | undefined;
let administrador: pg.Pool | undefined;
const bancoNome = `cofre_links_teste_${process.pid}`;

// Mesmo contrato roda também contra PostgreSQL local; nenhuma URL do ambiente é usada.
async function query(sql: string, valores: any[] = []): Promise<{ rows: any[] }> {
    consultas.push(valores);
    if (bancoReal) return bancoReal.query(sql, valores);
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
    if (sql.includes('select u.ativo')) return { rows: medico ? [medico] : [] };
    if (sql.includes('select u.telefone')) return { rows: medico ? [{ ...medico, ambiente: 'homologacao' }] : [] };
    if (sql.includes('count(*)')) return { rows: [{ total: registros.filter(l => l.medico_id === valores[0] && l.criado_em.getTime() > Date.now() - 3600000).length }] };
    if (sql.includes('with expirados')) {
        for (const l of registros.filter(l => l.medico_id === valores[0] && l.agenda === valores[1] && !l.usado_em)) {
            l.expira_em = new Date(Math.min(l.expira_em.getTime(), Date.now())); auditoria.push({ link_id: l.id, evento: 'expirado' });
        }
        return { rows: [] };
    }
    if (sql.includes('insert into cofre_links (')) {
        const l = { id: randomUUID(), medico_id: valores[0], agenda: valores[1], token_hash: valores[2], expira_em: new Date(Date.now() + 900000), usado_em: null, criado_em: new Date() };
        registros.push(l); return { rows: [{ id: l.id }] };
    }
    if (sql.includes('insert into cofre_links_auditoria')) { auditoria.push({ link_id: valores[0], evento: valores[1] }); return { rows: [] }; }
    if (sql.includes('update cofre_links set usado_em')) {
        const l = registros.find(l => l.token_hash === valores[0] && !l.usado_em && l.expira_em.getTime() > Date.now());
        if (!l) return { rows: [] }; l.usado_em = new Date(); return { rows: [{ medico_id: l.medico_id }] };
    }
    if (sql.includes('where token_hash')) return { rows: registros.filter(l => l.token_hash === valores[0]).map(l => ({ ...l, expirado: l.expira_em.getTime() <= Date.now() })) };
    if (sql.includes('where medico_id')) return { rows: registros.filter(l => l.medico_id === valores[0] && !l.usado_em && l.expira_em.getTime() > Date.now()) };
    throw Error('SQL_NAO_ESPERADO');
}
const pool = { query, connect: async () => bancoReal ? bancoReal.connect() : { query, release() {} } } as unknown as pg.Pool;

beforeAll(async () => {
    if (process.env.COFRE_TESTE_POSTGRES_LOCAL === '1') {
        administrador = new pg.Pool({ host: '127.0.0.1', port: 55432, user: 'postgres', database: 'postgres' });
        await administrador.query(`create database ${bancoNome}`);
        bancoReal = new pg.Pool({ host: '127.0.0.1', port: 55432, user: 'postgres', database: bancoNome });
        await administrador.query("do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if; if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; end $$");
        await bancoReal.query(`create table usuarios (id uuid primary key, ativo boolean, telefone text);
            create table medicos (id uuid primary key, usuario_id uuid references usuarios);
            create table medico_perfil_fiscal (medico_id uuid, ambiente text);`);
        await bancoReal.query(await readFile('scripts/migrations/20261020-cofre-links.sql', 'utf8'));
    }
    servidor = createServer(); await new Promise<void>(r => servidor.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
    const app = express(); app.use('/c', (req, res, next) => criarRouterLinksCofre(links, base)(req, res, next));
    servidor.on('request', app);
});
beforeEach(async () => {
    registros = []; auditoria = []; consultas = []; textos = []; logs = [];
    medico = { ativo: true, telefone }; estado = 'vazio'; flag = true; allowlist = [telefone];
    if (bancoReal) {
        await bancoReal.query('truncate usuarios, medicos, medico_perfil_fiscal, cofre_links, cofre_links_auditoria cascade');
        await bancoReal.query('insert into usuarios values ($1,true,$2);', [medicoId, telefone]);
        await bancoReal.query('insert into medicos values ($1,$1)', [medicoId]);
        await bancoReal.query("insert into medico_perfil_fiscal values ($1,'homologacao')", [medicoId]);
    }
    iniciar.mockClear(); classificar.mockClear();
    for (const metodo of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, metodo).mockImplementation((...args) => { logs.push(args); });
    const config = carregarConfig({});
    const comunicacao = new ComunicacaoHomologacao(pool, config, { enviarTexto: async entrada => {
        expect(entrada.contatoTelefone).toBe(telefone); textos.push(entrada.texto); return { sucesso: true };
    } }, texto => logs.push(texto));
    links = new LinksCofre({ pool, origem: base, cofre: { status: async () => ({ salvo: estado !== 'vazio', estado, ativo: estado === 'conectado', verificadoEm: null, codigo: null, consultasDisponiveis: null }), iniciar },
        enviar: async (id, texto) => { config.envioMedicoRealAtivo = flag; config.envioRealAllowlist = allowlist; return comunicacao.cofre(id, texto); } });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
    await new Promise<void>(r => servidor.close(() => r()));
    await bancoReal?.end();
    if (administrador) { await administrador.query(`drop database ${bancoNome}`); await administrador.end(); }
});
async function pedir() { const resultado = await links.solicitarLinkCofre(medicoId, 'tribemd'); return { resultado, token: textos.at(-1)!.match(/\/c\/([\w-]{43})/)![1] }; }
async function post(token: string, corpo: unknown = dados, origem = base) {
    return fetch(`${base}/c/${token}/enviar`, { method: 'POST', headers: { Origin: origem, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
}
async function salvos(): Promise<Link[]> { return bancoReal ? (await bancoReal.query('select * from cofre_links')).rows : registros; }
async function configurarMedico(novo: typeof medico) {
    medico = novo;
    if (!bancoReal) return;
    if (!novo) await bancoReal.query('delete from medicos');
    else await bancoReal.query('update usuarios set ativo=$1, telefone=$2', [novo.ativo, novo.telefone]);
}

describe('gatilho determinístico do link', () => {
    it.each([
        [null, 'MEDICO_INEXISTENTE'], [{ ativo: false, telefone }, 'MEDICO_INATIVO'], [{ ativo: true, telefone: '' }, 'SEM_TELEFONE']
    ] as const)('recusa conta %j', async (conta, motivo) => {
        await configurarMedico(conta); expect(await links.solicitarLinkCofre(medicoId, 'tribemd')).toEqual({ ok: false, motivo }); expect(textos).toEqual([]);
    });
    it('recusa agenda não suportada', async () => { expect(await links.solicitarLinkCofre(medicoId, 'outra')).toEqual({ ok: false, motivo: 'AGENDA_NAO_SUPORTADA' }); expect(textos).toEqual([]); });
    it.each(['conectado', 'conectando', 'salvo', 'atencao'] as const)('recusa cofre %s', async valor => {
        estado = valor; expect((await links.solicitarLinkCofre(medicoId, 'tribemd')).ok).toBe(false); expect(textos).toEqual([]);
    });
    it('permite desconectado e limita três pedidos por hora por médico', async () => {
        estado = 'desconectado'; await pedir(); await pedir(); await pedir();
        expect(await links.solicitarLinkCofre(medicoId, 'tribemd')).toEqual({ ok: false, motivo: 'LIMITE_PEDIDOS' }); expect(textos).toHaveLength(3);
    });
    it.each(['flag', 'allowlist'] as const)('não envia nem loga o link com %s bloqueando', async caso => {
        flag = caso !== 'flag'; allowlist = caso === 'allowlist' ? [] : [telefone];
        expect(await links.solicitarLinkCofre(medicoId, 'tribemd')).toEqual({ ok: true, motivo: 'simulado' });
        expect(textos).toEqual([]); expect(JSON.stringify(logs)).not.toContain('/c/');
    });
});

describe('HTTP e segredos', () => {
    it('só guarda SHA256; GET e preview não consomem nem devolvem token', async () => {
        const { token, resultado } = await pedir(); const [l] = await salvos();
        expect(l.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
        expect(new Date(l.expira_em).getTime() - new Date(l.criado_em).getTime()).toBe(900000);
        for (let n = 0; n < 2; n++) {
            const res = await fetch(`${base}/c/${token}`); expect(res.status).toBe(200);
            expect(res.headers.get('cache-control')).toBe('no-store'); expect(res.headers.get('referrer-policy')).toBe('no-referrer'); expect(res.headers.get('x-content-type-options')).toBe('nosniff');
            const html = await res.text(); expect(html).toContain('type="password"'); expect(html).toContain('tribemd-leitura-v1'); expect(html).not.toContain(token);
        }
        expect((await salvos())[0].usado_em).toBeNull();
        expect(JSON.stringify([await salvos(), resultado, consultas, logs])).not.toContain(token);
    });
    it('consome uma vez mesmo com dois POSTs concorrentes e resolve médico pelo token', async () => {
        const { token } = await pedir();
        const respostas = await Promise.all([post(token), post(token)]);
        expect(respostas.map(r => r.status).sort()).toEqual([202, 410]); expect(iniciar).toHaveBeenCalledTimes(1);
        expect(iniciar.mock.calls[0][0]).toBe(medicoId);
        expect(iniciar.mock.calls[0][1]).toEqual({ ...dados, email: '', senha: '' });
        const saida = await Promise.all(respostas.map(r => r.text()));
        expect(JSON.stringify([saida, logs])).not.toContain(token); expect(JSON.stringify([saida, logs])).not.toContain(dados.senha);
    });
    it.each([{ medicoId: outroId }, { extra: 'injetado' }])('body strict rejeita campo extra %j antes de consumir', async extra => {
        const { token } = await pedir(); expect((await post(token, { ...dados, ...extra })).status).toBe(400);
        expect((await salvos())[0].usado_em).toBeNull(); expect(iniciar).not.toHaveBeenCalled();
        expect((await post(token)).status).toBe(202);
    });
    it('rejeita Origin e corpo acima de 4kb sem consumir', async () => {
        const { token } = await pedir(); expect((await post(token, dados, 'https://invalido.example')).status).toBe(403);
        expect((await post(token, { ...dados, senha: 's'.repeat(4096) })).status).toBe(400);
        expect((await salvos())[0].usado_em).toBeNull();
    });
    it('novo link invalida o anterior e respostas inválido/usado/expirado são neutras', async () => {
        const primeiro = await pedir(); const segundo = await pedir();
        expect((await fetch(`${base}/c/${primeiro.token}`)).status).toBe(410);
        expect((await post(segundo.token)).status).toBe(202);
        const paginas = await Promise.all([primeiro.token, segundo.token, 'invalido'].map(async t => (await fetch(`${base}/c/${t}`)).text()));
        expect(new Set(paginas).size).toBe(1); expect(paginas[0]).toContain('Link expirado');
    });
    it('expira ao atingir 15 minutos', async () => {
        const { token } = await pedir();
        if (bancoReal) await bancoReal.query("update cofre_links set expira_em=now()-interval '1 millisecond'");
        else registros[0].expira_em = new Date(Date.now() - 1);
        expect((await fetch(`${base}/c/${token}`)).status).toBe(410); expect((await post(token)).status).toBe(410); expect(iniciar).not.toHaveBeenCalled();
    });
    it('falha do cofre mantém token consumido e oferece novo link sem vazar erro', async () => {
        const { token } = await pedir(); iniciar.mockRejectedValueOnce(Error(dados.senha));
        const res = await post(token); expect(res.status).toBe(503); expect(await res.text()).toContain('novo link');
        expect((await post(token)).status).toBe(410); expect(textos.at(-1)).toContain('novo link'); expect(JSON.stringify(logs)).not.toContain(dados.senha);
    });
});

it('ponta a ponta: WhatsApp fake → link → GET → POST → confirmação só após conexão', async () => {
    const memoria = new MemoriaConversaMedico(); const extrair = vi.fn(); const lerEstado = vi.fn();
    const historico = new HistoricoComunicacaoEmMemoria();
    const tratar = (id: string, texto: string) => links.tratarMensagem(id, texto, classificar);
    const deps = { ativo: true, memoriaConversa: memoria, historico, extratorResposta: { extrair }, lerEstado, tratarCofre: tratar, log: (_nivel: string, texto: string) => logs.push(texto) };
    const webhook = (texto: string, id: string) => processarMensagemWebhook({ event: 'messages.upsert', instance: 'assistente', data: {
        key: { id, fromMe: false, remoteJid: `${telefone}@s.whatsapp.net` }, message: { conversation: texto }
    } }, 'segredo-ficticio', { segredoConfigurado: 'segredo-ficticio', pepper: 'pepper-ficticio', instanciaAssistenteNome: 'assistente', comunicacaoMedicoAtiva: true,
        repositorio: { buscarMedicoPorTelefone: async () => ({ id: medicoId }) } as unknown as AtendimentoRepositorio,
        aoReceberMensagemMedico: entrada => processarComunicacaoMedico({ medicoId: entrada.medicoId, chaveProcessamento: entrada.chaveMensagem, chaveConversa: 'conversa', agora: new Date(), respostaMedico: { texto: entrada.texto, dataMensagem: null } }, deps) });
    await webhook('Quero conectar TribeMD', 'pedido');
    const token = textos[0].match(/\/c\/([\w-]{43})/)![1];
    expect((await fetch(`${base}/c/${token}`)).status).toBe(200); expect((await post(token)).status).toBe(202);
    expect(textos).toHaveLength(1); await links.concluir(medicoId, true); await links.concluir(medicoId, true);
    expect(textos.at(-1)).toBe('TribeMD conectado'); expect(textos).toHaveLength(2);
    await webhook(`minha senha é ${dados.senha}`, 'senha');
    await webhook('credencial-sem-rotulo', 'senha-sem-rotulo');
    expect(classificar).toHaveBeenCalledTimes(1); expect(extrair).not.toHaveBeenCalled(); expect(lerEstado).not.toHaveBeenCalled();
    expect(memoria.ler(medicoId, 'conversa')).toEqual([]); expect((await historico.ler(medicoId, 'simulado')).registros).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain(dados.senha);
});

it('IA só classifica a agenda, sem gerar ação ou token', async () => {
    const completar = vi.fn(async () => '{"agenda":"tribemd"}');
    const ia = new ExtratorRespostaMedicoNvidia('chave-ficticia', 'modelo-ficticio', completar);
    expect(await ia.classificarAgenda('Conectar TribeMD')).toBe('tribemd'); expect(completar).toHaveBeenCalledOnce();
});

it.runIf(process.env.COFRE_TESTE_POSTGRES_LOCAL === '1')('PostgreSQL: quatro pedidos concorrentes criam só três links e só o último fica válido', async () => {
    const resultados = await Promise.all(Array.from({ length: 4 }, () => links.solicitarLinkCofre(medicoId, 'tribemd')));
    expect(resultados.filter(r => r.ok)).toHaveLength(3);
    expect(resultados.filter(r => r.motivo === 'LIMITE_PEDIDOS')).toHaveLength(1);
    expect((await bancoReal!.query('select count(*)::int as total from cofre_links')).rows[0].total).toBe(3);
    expect((await bancoReal!.query('select count(*)::int as total from cofre_links where expira_em>now()')).rows[0].total).toBe(1);
});
it.runIf(process.env.COFRE_TESTE_POSTGRES_LOCAL === '1')('PostgreSQL: RLS sem policies e nenhum acesso anon às tabelas', async () => {
    expect((await bancoReal!.query("select relrowsecurity from pg_class where relname in ('cofre_links','cofre_links_auditoria')")).rows).toEqual([{ relrowsecurity: true }, { relrowsecurity: true }]);
    expect((await bancoReal!.query("select * from pg_policies where tablename like 'cofre_links%'")).rows).toEqual([]);
    const cliente = await bancoReal!.connect();
    try {
        await cliente.query('begin'); await cliente.query('set local role anon');
        await expect(cliente.query('select * from cofre_links')).rejects.toMatchObject({ code: '42501' });
    } finally { await cliente.query('rollback'); cliente.release(); }
});
it.runIf(process.env.COFRE_TESTE_POSTGRES_LOCAL === '1')('PostgreSQL: após uma hora permite nova solicitação e auditoria não armazena segredos', async () => {
    await pedir(); await pedir(); await pedir();
    await bancoReal!.query("update cofre_links set criado_em=now()-interval '1 hour'");
    const { token } = await pedir(); expect((await fetch(`${base}/c/${token}`)).status).toBe(200);
    const eventos = (await bancoReal!.query('select * from cofre_links_auditoria')).rows;
    expect(new Set(eventos.map(e => e.evento))).toEqual(new Set(['criado', 'aberto', 'enviado', 'expirado']));
    expect(JSON.stringify(eventos)).not.toContain(token); expect(JSON.stringify(eventos)).not.toContain(dados.senha);
});

it.each([true, false])('cofre atual notifica conclusão real, conectado=%s, sem modificar persistência', async sucesso => {
    const diretorio = await mkdtemp(join(tmpdir(), 'cofre-links-'));
    const concluir = vi.fn(async () => {});
    vi.spyOn(NavegadorTribemd, 'criar').mockResolvedValue({
        abrir: async () => 'aguardando_credenciais',
        entrar: async () => { if (!sucesso) throw Error('LOGIN_FICTICIO'); },
        ler: async () => ({ consultas: [] }), perfil: async () => ({ cookies: [], origins: [] }),
        estaAutenticado: () => sucesso, encerrar: async () => {}
    } as unknown as NavegadorTribemd);
    const cofre = new CofreTribemd({ diretorio, chave: Buffer.alloc(32, 1).toString('base64'), chromium: '/nao-executar', aoConcluir: concluir });
    try {
        await cofre.iniciar(medicoId, { ...dados });
        await vi.waitFor(() => expect(concluir).toHaveBeenCalledExactlyOnceWith(medicoId, sucesso));
    } finally { await cofre.encerrar(); await rm(diretorio, { recursive: true, force: true }); }
});

it('ferramenta do conversador reutiliza limite real de 3/h do cofre e deduplica reentrega antes do envio', async () => {
    const historico = new HistoricoComunicacaoEmMemoria();
    for (const [chave, acao] of [['inicio', { tipo: 'boas_vindas', ultimaNota: null }], ['pergunta', { tipo: 'perguntar_nota_pendente' }]] as const) {
        await historico.reservar(medicoId, 'simulado', chave);
        await historico.gravarAcao(medicoId, 'simulado', chave, acao, new Date().toISOString());
        await historico.liberar(medicoId, 'simulado', chave);
    }
    const resultados: unknown[] = [];
    const completar = vi.fn(async (_chave: string, _modelo: string, mensagens: Array<{ content: unknown }>) => {
        const dados = JSON.parse(String(mensagens[1].content));
        if (dados.resultadoFerramenta) { return '{"fala":["Resultado recebido."],"acao":"enviar_link_cofre_agenda"}'; }
        return '{"fala":["Peço o link"],"acao":"enviar_link_cofre_agenda"}';
    });
    const deps = { ativo: true, conversaLivreAtiva: true, historico, conversador: new ConversadorMedico('chave', 'modelo', completar),
        listarConsultasSemNota: vi.fn(), enviarLinkCofreAgenda: async (id: string) => { const r = await links.solicitarLinkCofre(id, 'tribemd'); resultados.push(r); return r; },
        lerEstado: async () => ({ estado: { agora: new Date(), fiscal: { certificado: 'ok' as const, dadosFiscais: 'ok' as const }, agenda: { nome: 'tribemd', conectada: false }, ultimaNota: null } }),
        extratorResposta: { extrair: async () => ({ temNota: 'fora_do_assunto' as const, desde: null, confianca: 0.95 }) }, log: vi.fn(), aoConversar: vi.fn() };
    const evento = { medicoId, chaveProcessamento: 'link-0', agora: new Date(), respostaMedico: { texto: 'Envie o link para conectar minha agenda', dataMensagem: '2026-10-20' } };
    await processarComunicacaoMedico(evento, deps);
    await processarComunicacaoMedico(evento, { ...deps, conversador: new ConversadorMedico('chave', 'modelo', completar) });
    expect(textos).toHaveLength(1);
    for (let i = 1; i <= 3; i++) await processarComunicacaoMedico({ ...evento, chaveProcessamento: `link-${i}` }, deps);
    expect(textos).toHaveLength(3); expect(await salvos()).toHaveLength(3);
    expect(resultados).toEqual([{ ok: true, motivo: 'enviado' }, { ok: true, motivo: 'enviado' }, { ok: true, motivo: 'enviado' }, { ok: false, motivo: 'LIMITE_PEDIDOS' }]);
    expect(completar).toHaveBeenCalledTimes(4); expect(deps.aoConversar).toHaveBeenCalledTimes(4);
    expect(deps.listarConsultasSemNota).not.toHaveBeenCalled();
});

it('mensagem de conexão explica necessidade, login na página segura e nunca usa jargão', async () => {
    const { token } = await pedir();
    const texto = textos.at(-1)!;
    expect(texto).toContain('preciso que você conecte sua agenda para cruzar consultas e pagamentos');
    expect(texto).toContain('login e senha da agenda');
    expect(texto).toContain('Eu não recebo senha pela conversa, só por esse link seguro');
    expect(texto).toContain(`/c/${token}`); expect(texto).not.toMatch(/cofre/i);
    expect(texto.length).toBeLessThanOrEqual(500);
});
