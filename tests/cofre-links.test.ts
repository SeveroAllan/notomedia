import { ConversadorMedico } from '../src/onboarding/conversador-medico.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CofreTribemd } from '../src/cofre/tribemd-cofre.js';
import { NavegadorTribemd } from '../src/desenvolvedor/tribemd-navegador.js';
import pg from 'pg';
import express from 'express';
import { PostgresMemoriaConversaMedico } from '../src/onboarding/conversa-repositorio.js';
import { BancoConversaFalso } from './fakes/banco-conversa.js';
import { LinksCofre, type TextoLinkAgendaEnviado } from '../src/cofre/links.js';
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
let instanteBanco = 0;
let registros: Link[], auditoria: Array<{ link_id: string; evento: string }>;
let medico: { ativo: boolean; telefone: string } | null;
let estado: 'vazio' | 'desconectado' | 'conectado' | 'conectando' | 'salvo' | 'atencao';
let origemRouter: string;
let base: string, servidor: Server, links: LinksCofre;
let textos: string[], logs: unknown[], consultas: unknown[];
let flag: boolean, allowlist: string[];
let registrarTextoLink: ((entrada: TextoLinkAgendaEnviado) => Promise<void>) | undefined;
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
    if (sql.includes('pedidos_contados')) {
        expect(sql).toContain('join lateral'); expect(sql).toContain('anterior.expira_em>pedido.criado_em');
        expect(sql).toContain('anterior.usado_em is null'); expect(sql).toContain('order by anterior.criado_em desc, anterior.id desc limit 1');
        instanteBanco = Math.max(Date.now(), instanteBanco + 2);
        const pedidos = registros.filter(l => l.medico_id === valores[0]).sort((a, b) => a.criado_em.getTime() - b.criado_em.getTime() || a.id.localeCompare(b.id));
        const contados = pedidos.filter((pedido, i) => i > 0 && pedido.criado_em.getTime() > instanteBanco - 3600000 &&
            !pedidos[i - 1].usado_em && pedidos[i - 1].expira_em > pedido.criado_em);
        const anterior = pedidos.at(-1);
        return { rows: [{ total: contados.length, instante: new Date(instanteBanco).toISOString(),
            substitui_valido: !!anterior && !anterior.usado_em && anterior.expira_em.getTime() > instanteBanco,
            aguardar_minutos: contados.length ? Math.max(1, Math.ceil((contados[0].criado_em.getTime() + 3600000 - instanteBanco) / 60000)) : 1 }] };
    }
    if (sql.includes('count(*)')) return { rows: [{ total: registros.filter(l => l.medico_id === valores[0] && l.criado_em.getTime() > Date.now() - 3600000).length }] };
    if (sql.includes('with expirados')) {
        for (const l of registros.filter(l => l.medico_id === valores[0] && l.agenda === valores[1] && !l.usado_em)) {
            l.expira_em = new Date(Math.min(l.expira_em.getTime(), sql.includes('clock_timestamp()') ? instanteBanco + 1 : Date.now())); auditoria.push({ link_id: l.id, evento: 'expirado' });
        }
        return { rows: [] };
    }
    if (sql.includes('insert into cofre_links (')) {
        const l = { id: randomUUID(), medico_id: valores[0], agenda: valores[1], token_hash: valores[2], expira_em: new Date(new Date(valores[3] ?? Date.now()).getTime() + 900000), usado_em: null, criado_em: new Date(valores[3] ?? Date.now()) };
        registros.push(l); return { rows: [{ id: l.id }] };
    }
    if (sql.includes("values ($1, 'concluido')")) {
        if (auditoria.some(a => a.link_id === valores[0] && a.evento === 'concluido')) return { rows: [] };
        auditoria.push({ link_id: valores[0], evento: 'concluido' }); return { rows: [{ link_id: valores[0] }] };
    }
    if (sql.includes('insert into cofre_links_auditoria')) { auditoria.push({ link_id: valores[0], evento: valores[1] }); return { rows: [] }; }
    if (sql.includes('update cofre_links set usado_em')) {
        const l = registros.find(l => l.token_hash === valores[0] && !l.usado_em && l.expira_em.getTime() > Math.max(Date.now(), instanteBanco + 2));
        if (!l) return { rows: [] }; l.usado_em = new Date(); return { rows: [{ medico_id: l.medico_id, id: l.id, agenda: l.agenda }] };
    }
    if (sql.includes('where token_hash')) return { rows: registros.filter(l => l.token_hash === valores[0]).map(l => ({ ...l, expirado: l.expira_em.getTime() <= Math.max(Date.now(), instanteBanco + 2) })) };
    if (sql.includes('from cofre_links l where')) return { rows: registros.filter(l => l.medico_id === valores[0]).slice(-1).map(l => ({ ...l, enviado_em: auditoria.some(a => a.link_id === l.id && a.evento === 'enviado') ? l.criado_em : null })) };
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
    const app = express(); app.use('/c', (req, res, next) => criarRouterLinksCofre(links, origemRouter, async () => '5511999990000')(req, res, next));
    servidor.on('request', app);
});
beforeEach(async () => {
    registrarTextoLink = undefined;
    origemRouter = base; instanteBanco = 0; registros = []; auditoria = []; consultas = []; textos = []; logs = [];
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
    links = new LinksCofre({ pool, origem: base, registrarTextoEnviado: entrada => registrarTextoLink?.(entrada) ?? Promise.resolve(), cofre: { status: async () => ({ salvo: estado !== 'vazio', estado, ativo: estado === 'conectado', verificadoEm: null, codigo: null, consultasDisponiveis: null }), iniciar },
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
async function postCom(token: string, headers: Record<string, string>, corpo: unknown = dados) {
    // fetch sobrescreve Host; o cliente HTTP permite simular o host recebido pelo proxy.
    return new Promise<{ status: number }>((resolve, reject) => {
        const req = request(`${base}/c/${token}/enviar`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, res => {
            res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        });
        req.on('error', reject); req.end(JSON.stringify(corpo));
    });
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
    it.each(['conectado', 'conectando', 'salvo'] as const)('recusa cofre %s', async valor => {
        estado = valor; expect((await links.solicitarLinkCofre(medicoId, 'tribemd')).ok).toBe(false); expect(textos).toEqual([]);
    });
    it('permite desconectado e limita três pedidos por hora por médico', async () => {
        estado = 'desconectado'; await pedir(); await pedir(); await pedir();
        expect(await links.solicitarLinkCofre(medicoId, 'tribemd')).toEqual({ ok: false, motivo: 'LIMITE_PEDIDOS', aguardarMinutos: 60 }); expect(textos).toHaveLength(9);
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
    it('falha técnica mantém token consumido e informa instabilidade sem vazar erro', async () => {
        const { token } = await pedir(); iniciar.mockRejectedValueOnce(Error(dados.senha));
        const res = await post(token); expect(res.status).toBe(503); expect(await res.text()).toBe('Tive uma instabilidade e não consegui concluir agora.');
        expect((await post(token)).status).toBe(410); expect(textos.at(-1)).toBe('Não consegui conectar sua agenda agora. Tive uma instabilidade e não consegui concluir agora.'); expect(JSON.stringify(logs)).not.toContain(dados.senha);
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
    const token = textos[2].match(/\/c\/([\w-]{43})/)![1];
    expect((await fetch(`${base}/c/${token}`)).status).toBe(200); expect((await post(token)).status).toBe(202);
    expect(textos).toHaveLength(3); await links.concluir(medicoId, true); await links.concluir(medicoId, true);
    expect(textos.at(-1)).toBe('Já recebi o seu acesso ao TribeMD.'); expect(textos).toHaveLength(4);
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
        if (dados.resultadoFerramenta) { return '{"fala":["Você pode pedir outro link em uma hora."],"acao":null}'; }
        return '{"fala":["Peço o link"],"acao":"enviar_link_cofre_agenda"}';
    });
    const deps = { ativo: true, conversaLivreAtiva: true, historico, conversador: new ConversadorMedico('chave', 'modelo', completar),
        listarConsultasSemNota: vi.fn(), enviarLinkCofreAgenda: async (id: string) => { const r = await links.solicitarLinkCofre(id, 'tribemd'); resultados.push(r); return r; },
        lerEstado: async () => ({ estado: { agora: new Date(), fiscal: { certificado: 'ok' as const, dadosFiscais: 'ok' as const }, agenda: { nome: 'tribemd', conectada: false }, ultimaNota: null } }),
        extratorResposta: { extrair: async () => ({ temNota: 'fora_do_assunto' as const, desde: null, confianca: 0.95 }) }, log: vi.fn(), aoConversar: vi.fn() };
    const evento = { medicoId, chaveProcessamento: 'link-0', agora: new Date(), respostaMedico: { texto: 'Envie o link para conectar minha agenda', dataMensagem: '2026-10-20' } };
    await processarComunicacaoMedico(evento, deps);
    await processarComunicacaoMedico(evento, { ...deps, conversador: new ConversadorMedico('chave', 'modelo', completar) });
    expect(textos).toHaveLength(3);
    for (let i = 1; i <= 3; i++) await processarComunicacaoMedico({ ...evento, chaveProcessamento: `link-${i}` }, deps);
    expect(textos).toHaveLength(9); expect(await salvos()).toHaveLength(3);
    expect(resultados).toEqual([{ ok: true, motivo: 'enviado' }, { ok: true, motivo: 'enviado' }, { ok: true, motivo: 'enviado' }, { ok: false, motivo: 'LIMITE_PEDIDOS', aguardarMinutos: 60 }]);
    expect(completar).toHaveBeenCalledTimes(5); expect(deps.aoConversar).toHaveBeenCalledExactlyOnceWith(['Você pode pedir outro link em uma hora.'], 'link-3');
    const chamada = completar.mock.calls.at(-1)!; expect(String(chamada[2][0].content)).toContain('Espera real para novo link (servidor): 60 minutos');
    expect(deps.listarConsultasSemNota).not.toHaveBeenCalled();
});

it('mensagem de conexão explica necessidade, login na página segura e nunca usa jargão', async () => {
    const { token } = await pedir();
    expect(textos).toEqual([
        'Para conseguir emitir suas notas, preciso conectar sua agenda para cruzar consultas e pagamentos.',
        'Por segurança, eu não recebo senha pela conversa. Seu login e senha da agenda vão só neste link seguro, que vale por 15 minutos e só pode ser usado uma vez.',
        `${base}/c/${token}`
    ]);
    for (const texto of textos) { expect(texto).not.toMatch(/cofre/i); expect(texto.length).toBeLessThanOrEqual(500); }
});

it.each([true, false])('POST e conclusão conectado=%s entregam o evento uma vez com o provedor real', async conectado => {
    const concluir = vi.fn(async () => {});
    const status = async () => ({ salvo: false, estado: 'vazio' as const, ativo: false, verificadoEm: null, codigo: null, consultasDisponiveis: null });
    links = new LinksCofre({ pool, origem: base, cofre: { status, iniciar }, enviar: async (_id, texto) => { textos.push(texto); return 'enviado'; }, aoConcluir: concluir });
    const { token } = await pedir(); const resposta = await post(token); expect(resposta.status).toBe(202);
    const html = await resposta.text(); expect(html).toContain('Acesso salvo'); expect(html).toContain('Voltar para o WhatsApp'); expect(html).toContain('https://wa.me/5511999990000');
    expect(html).not.toMatch(/<form|type="password"|cofre|iClinic/i); expect(html).not.toContain(token); expect(html).not.toContain(dados.senha);
    await links.concluir(medicoId, conectado); await links.concluir(medicoId, conectado);
    expect(concluir).toHaveBeenCalledExactlyOnceWith(medicoId, { agenda: 'tribemd', conectado, chave: (await salvos())[0].id, ...(!conectado ? { falhaAcesso: false } : {}) });
    expect(textos).toHaveLength(3);
});

it('falha de acesso é identificada pelo status real depois da verificação', async () => {
    let falhou = false; const concluir = vi.fn(async () => {});
    const status = async () => ({ salvo: falhou, estado: falhou ? 'atencao' as const : 'vazio' as const, ativo: falhou, verificadoEm: null, codigo: falhou ? 'ACESSO_PRECISA_VERIFICACAO' : null, consultasDisponiveis: null });
    links = new LinksCofre({ pool, origem: base, cofre: { status, iniciar }, enviar: async (_id, texto) => { textos.push(texto); return 'enviado'; }, aoConcluir: concluir });
    const { token } = await pedir(); expect((await post(token)).status).toBe(202); falhou = true;
    await links.concluir(medicoId, false);
    expect(concluir).toHaveBeenCalledExactlyOnceWith(medicoId, { agenda: 'tribemd', conectado: false, falhaAcesso: true, chave: (await salvos())[0].id });
});

it.each([2, 3])('falha no balão %s interrompe e não audita enviado', async falha => {
    const enviar = vi.fn(async () => enviar.mock.calls.length === falha ? 'erro' as const : 'enviado' as const);
    links = new LinksCofre({ pool, origem: base, cofre: { status: async () => ({ salvo: false, estado: 'vazio', ativo: false, verificadoEm: null, codigo: null, consultasDisponiveis: null }), iniciar }, enviar });
    expect(await links.solicitarLinkCofre(medicoId, 'tribemd')).toEqual({ ok: false, motivo: 'erro' });
    expect(enviar).toHaveBeenCalledTimes(falha); expect(auditoria.some(a => a.evento === 'enviado')).toBe(false);
    expect(await salvos()).toHaveLength(1);
});
it('estado real do link expõe idade, uso e expiração sem token ou credenciais', async () => {
    const { token } = await pedir(); const link = (await salvos())[0];
    const agora = new Date(link.criado_em.getTime() + 20 * 60000);
    expect(await links.lerContextoConexao(medicoId, agora)).toEqual({ agendaConectada: false, aguardandoConexao: true,
        link: { enviado: true, minutosDesdeEnvio: 20, usado: false, expirado: true, rejeitado: null } });
    await links.enviarCredencial(token, { ...dados });
    expect((await links.lerContextoConexao(medicoId, agora)).link?.usado).toBe(true);
    estado = 'conectado'; expect(await links.lerContextoConexao(medicoId, agora)).toMatchObject({ agendaConectada: true, aguardandoConexao: false });
    expect(JSON.stringify(await links.lerContextoConexao(medicoId, agora))).not.toMatch(new RegExp(`${token}|${dados.senha}|${dados.email}`));
});
it('falha de acesso permite novo link mantendo limite e invalidação', async () => {
    const anterior = await pedir(); estado = 'atencao'; const novo = await pedir();
    expect(novo.resultado).toEqual({ ok: true, motivo: 'enviado' });
    expect(await links.validar(anterior.token)).toBe(false); expect(await links.validar(novo.token)).toBe(true);
});

it.each(['expirado', 'invalidado', 'usado'])('quatro pedidos após link %s são atendidos sem penalidade', async encerramento => {
    for (let i = 0; i < 4; i++) {
        if (i) {
            const anterior = (await salvos()).at(-1)!;
            if (encerramento === 'usado') anterior.usado_em = new Date(Date.now() - 1000);
            else anterior.expira_em = new Date(Date.now() - (encerramento === 'expirado' ? 60000 : 1000));
        }
        expect(await links.solicitarLinkCofre(medicoId, 'tribemd')).toEqual({ ok: true, motivo: 'enviado' });
    }
    expect(await salvos()).toHaveLength(4); expect(textos).toHaveLength(12);
});
it('rajada recusa quarto pedido e informa minutos até o pedido contado mais antigo sair', async () => {
    await pedir(); await pedir(); await pedir();
    expect(await links.solicitarLinkCofre(medicoId, 'tribemd')).toEqual({ ok: false, motivo: 'LIMITE_PEDIDOS', aguardarMinutos: 60 });
    expect(await salvos()).toHaveLength(3); expect(textos).toHaveLength(9);
});
it('expiração permite novo pedido e espera cai até o contado mais antigo sair da hora', async () => {
    await pedir(); await pedir(); await pedir();
    if (bancoReal) await bancoReal.query("update cofre_links set criado_em=criado_em-interval '58 minutes', expira_em=expira_em-interval '58 minutes'");
    else for (const l of registros) { l.criado_em = new Date(l.criado_em.getTime() - 58 * 60000); l.expira_em = new Date(l.expira_em.getTime() - 58 * 60000); }
    expect(await links.solicitarLinkCofre(medicoId, 'tribemd')).toEqual({ ok: true, motivo: 'enviado' });
    expect(await links.solicitarLinkCofre(medicoId, 'tribemd')).toEqual({ ok: false, motivo: 'LIMITE_PEDIDOS', aguardarMinutos: 2 });
    const antigos = (await salvos()).slice(0, 3);
    if (bancoReal) await bancoReal.query("update cofre_links set criado_em=criado_em-interval '3 minutes', expira_em=expira_em-interval '3 minutes' where id=any($1::uuid[])", [antigos.map(l => l.id)]);
    else for (const l of antigos) { l.criado_em = new Date(l.criado_em.getTime() - 3 * 60000); l.expira_em = new Date(l.expira_em.getTime() - 3 * 60000); }
    expect(await links.solicitarLinkCofre(medicoId, 'tribemd')).toEqual({ ok: true, motivo: 'enviado' });
});


it.each([
    [{ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }, 202],
    [{ Origin: 'null', 'Sec-Fetch-Site': 'none' }, 202],
    [{ Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }, 403],
    [{ Origin: 'https://invalido.example', 'Sec-Fetch-Site': 'same-origin' }, 403],
    [{}, 202]
] as const)('POST com cabeçalhos %j retorna %s sem afrouxar uso único', async (headers, status) => {
    const { token } = await pedir();
    expect((await postCom(token, headers)).status).toBe(status);
    expect((await salvos())[0].usado_em !== null).toBe(status === 202);
    expect(iniciar).toHaveBeenCalledTimes(status === 202 ? 1 : 0);
    if (status === 202) expect((await postCom(token, headers)).status).toBe(410);
});
it.each([false, true])('Origin null segue o Referer antes do Sec-Fetch-Site (divergente=%s)', async divergente => {
    const { token } = await pedir();
    expect((await postCom(token, { Origin: 'null', Referer: `${divergente ? 'https://invalido.example' : base}/c/${token}`, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(divergente ? 403 : 202);
});
it('aceita primeiro X-Forwarded-Host e recusa origem externa não declarada pelo proxy', async () => {
    const primeiro = await pedir();
    expect((await postCom(primeiro.token, { Origin: 'http://app.example.com', 'X-Forwarded-Host': 'app.example.com, proxy.interno' })).status).toBe(202);
    const segundo = await pedir();
    expect((await postCom(segundo.token, { Origin: 'https://invalido.example', 'X-Forwarded-Host': 'app.example.com' })).status).toBe(403);
    expect((await salvos()).filter(l => l.usado_em)).toHaveLength(1);
});
it.each([true, false])('host www e esquema http sob origem https exigem TLS no proxy (%s)', async tls => {
    origemRouter = 'https://app.example.com'; const { token } = await pedir();
    const resposta = await postCom(token, { Host: 'www.app.example.com', Origin: 'http://www.app.example.com', 'X-Forwarded-Proto': tls ? 'https' : 'http' });
    expect(resposta.status, JSON.stringify(logs)).toBe(tls ? 202 : 403);
});
it('log de origem recusada contém os cabeçalhos, sem token, senha, corpo ou caminho do Referer', async () => {
    const { token } = await pedir();
    expect((await postCom(token, { Origin: 'https://invalido.example', Referer: `${base}/c/${token}?senha=${dados.senha}`, 'Sec-Fetch-Site': 'cross-site', 'X-Forwarded-Host': 'notomed.tech', 'X-Forwarded-Proto': 'https' })).status).toBe(403);
    const linha = JSON.stringify(logs);
    for (const valor of ['ORIGEM_RECUSADA', 'metodo=POST', 'origin=https://invalido.example', `referer=${base}`, 'secfetch=cross-site', 'host=', 'xfh=notomed.tech', 'xfp=https']) expect(linha).toContain(valor);
    for (const segredo of [token, dados.senha, dados.email, '/c/', 'consentimento']) expect(linha).not.toContain(segredo);
});
it.each([true, false])('conclusão concorrente por link persiste uma marca e dispara uma vez (conectado=%s)', async conectado => {
    const concluir = vi.fn(async () => {});
    links = new LinksCofre({ pool, origem: base, cofre: { status: async () => ({ salvo: false, estado: 'vazio', ativo: false, verificadoEm: null, codigo: null, consultasDisponiveis: null }), iniciar },
        enviar: async (_id, texto) => { textos.push(texto); return 'enviado'; }, aoConcluir: concluir });
    const { token } = await pedir(); await links.enviarCredencial(token, { ...dados });
    await Promise.all(Array.from({ length: 20 }, () => links.concluir(medicoId, conectado)));
    expect(concluir).toHaveBeenCalledOnce(); expect(auditoria.filter(a => a.evento === 'concluido')).toHaveLength(1);
});
it('marca persistente de conclusão impede callback de outra tentativa do mesmo link', async () => {
    const concluir = vi.fn(async () => {});
    links = new LinksCofre({ pool, origem: base, cofre: { status: async () => ({ salvo: false, estado: 'vazio', ativo: false, verificadoEm: null, codigo: null, consultasDisponiveis: null }), iniciar },
        enviar: async (_id, texto) => { textos.push(texto); return 'enviado'; }, aoConcluir: concluir });
    const { token } = await pedir(); await links.enviarCredencial(token, { ...dados });
    auditoria.push({ link_id: (await salvos())[0].id, evento: 'concluido' });
    await links.concluir(medicoId, true); expect(concluir).not.toHaveBeenCalled();
});

async function conversaComLinkRealFalso() {
    const banco = new BancoConversaFalso();
    const memoria = new PostgresMemoriaConversaMedico(banco as unknown as pg.Pool);
    const historico = new HistoricoComunicacaoEmMemoria(), agora = new Date();
    for (const [chave, acao] of [['inicio', { tipo: 'boas_vindas', ultimaNota: null }], ['pergunta', { tipo: 'perguntar_nota_pendente' }]] as const) {
        await historico.reservar(medicoId, 'simulado', chave); await historico.gravarAcao(medicoId, 'simulado', chave, acao, agora.toISOString()); await historico.liberar(medicoId, 'simulado', chave);
    }
    registrarTextoLink = async e => { await memoria.registrar(e.medicoId, 'conversa', `noto:agenda:link:${e.linkId}:${e.indice}`, e.texto, 'noto'); };
    const completar = vi.fn(async (_chave: string, _modelo: string, mensagens: Array<{ content: string }>) => mensagens[0].content.startsWith('Resuma')
        ? '{"resumo":"O médico recebeu o motivo da conexão e a orientação do link seguro."}' : '{"fala":["Vou pedir o link."],"acao":"enviar_link_cofre_agenda"}');
    const enviarLink = vi.fn((id: string, opcoes?: { reenvio?: boolean }) => links.solicitarLinkCofre(id, 'tribemd', opcoes));
    const aoConversar = vi.fn(async (_fala: string[]) => {});
    const deps = { ativo:true, conversaLivreAtiva:true, memoriaPersistida:memoria, memoriaConversa:new MemoriaConversaMedico(), historico,
        conversador:new ConversadorMedico('k','m',completar), aoConversar, enviarLinkCofreAgenda:enviarLink,
        listarConsultasSemNota:vi.fn(), lerContextoConexao:(id:string, instante:Date)=>links.lerContextoConexao(id, instante),
        extratorResposta:{extrair:async()=>({temNota:'fora_do_assunto' as const,desde:null,confianca:.95})},
        lerEstado:async()=>({estado:{fiscal:{certificado:'ok' as const,dadosFiscais:'ok' as const},agenda:{nome:null,conectada:false},ultimaNota:null}}),log:vi.fn() };
    const turno = (chave: string, texto: string) => processarComunicacaoMedico({medicoId,chaveConversa:'conversa',chaveProcessamento:chave,agora:new Date(),respostaMedico:{texto,dataMensagem:'2026-10-21'}},deps);
    return {banco,memoria,completar,enviarLink,aoConversar,turno};
}
it('emissão → link → agenda de papel: primeira resposta reconhece a fala com o histórico dos balões, sem novo link',async()=>{
    const c=await conversaComLinkRealFalso();await c.turno('emissao','Preciso emitir uma nota.');
    expect(textos).toHaveLength(3);const token=new URL(textos[2]).pathname.split('/').at(-1)!;
    const recebidas=await c.memoria.ler(medicoId,'conversa');expect(recebidas.join(' ')).toContain(textos[0]);expect(recebidas.join(' ')).toContain(textos[1]);
    expect(recebidas.join(' ')).not.toContain(token);expect(recebidas.join(' ')).toContain('[LINK_SEGURO]');
    c.completar.mockImplementation(async (_k,_m,msgs)=>{
        if(msgs[0].content.startsWith('Revise a continuidade manual'))return '{"semAgendaDigitalAtual":true,"evidencia":"não tenho agenda digital","confianca":1,"repeteOrientacao":false}';
        if(msgs[0].content.startsWith('Resuma'))return '{"resumo":"O médico usa agenda de papel; já recebeu a explicação da conexão e o link."}';
        const contexto=JSON.parse(msgs[1].content);expect(contexto.texto).toBe('não tenho agenda digital, uso agenda de papel mesmo');
        expect(contexto.mensagens.join(' ')).toContain(textos[0]);expect(contexto.mensagens.join(' ')).toContain(textos[1]);
        expect(msgs[0].content).toContain('não repetir');
        return '{"fala":["Entendi, você usa agenda de papel. Podemos conferir um paciente por vez: CPF, telefone, valor e data da consulta."],"semAgendaDigital":true,"acao":null}';
    });
    await c.turno('papel','não tenho agenda digital, uso agenda de papel mesmo');
    expect(c.aoConversar).toHaveBeenCalledExactlyOnceWith(['Entendi, você usa agenda de papel. Podemos conferir um paciente por vez: CPF, telefone, valor e data da consulta.'],'papel');
    expect(c.enviarLink).toHaveBeenCalledOnce();expect(await salvos()).toHaveLength(1);expect(textos).toHaveLength(3);
});
it('novo link depois de expirar é curto e não repete o motivo da conexão ou a explicação de segurança',async()=>{
    const c=await conversaComLinkRealFalso();await c.turno('primeiro','Preciso emitir.');
    if(bancoReal)await bancoReal.query("update cofre_links set expira_em=now()-interval '1 second'");else registros[0].expira_em=new Date(Date.now()-1000);
    c.completar.mockImplementation(async (_k,_m,msgs)=>msgs[0].content.startsWith('Resuma') ? '{"resumo":"O médico recebeu um novo link seguro."}' : '{"fala":["Claro."],"acao":"enviar_link_cofre_agenda","intencaoConexao":"pedir_novo_link"}');
    await c.turno('novo','Me manda um novo link.');
    expect(c.enviarLink).toHaveBeenLastCalledWith(medicoId,{reenvio:true});expect(textos.slice(3)).toHaveLength(2);
    expect(textos[3]).toBe('Claro. Aqui está o novo link seguro:');expect(textos[4]).toMatch(/^https?:\/\/.+\/c\/[A-Za-z0-9_-]{43}$/);
    expect(textos.filter(t=>t.startsWith('Para conseguir emitir'))).toHaveLength(1);expect(textos.filter(t=>t.startsWith('Por segurança'))).toHaveLength(1);
});

it.each(['simulado', 'erro'] as const)('histórico só recebe balões com envio real confirmado (%s)', async resultado => {
    const registrar = vi.fn(async (_entrada: TextoLinkAgendaEnviado) => {});
    registrarTextoLink = registrar;
    const envio = vi.spyOn(ComunicacaoHomologacao.prototype, 'cofre');
    if (resultado === 'erro') envio.mockResolvedValueOnce('enviado').mockResolvedValueOnce('erro');
    else envio.mockResolvedValue('simulado');
    const r = await links.solicitarLinkCofre(medicoId, 'tribemd');
    expect(r.motivo).toBe(resultado);
    expect(registrar).toHaveBeenCalledTimes(resultado === 'erro' ? 1 : 0);
    if (resultado === 'erro') expect(registrar.mock.calls[0][0]).toMatchObject({ medicoId, indice: 0,
        texto: 'Para conseguir emitir suas notas, preciso conectar sua agenda para cruzar consultas e pagamentos.' });
    expect(auditoria.filter(a => a.evento === 'enviado')).toHaveLength(0);
});

it('pedido de novo com link ativo informa validade, conserva a mesma URL e uma única linha de link', async () => {
    const c = await conversaComLinkRealFalso();
    await c.turno('inicial', 'Uso TribeMD e preciso emitir uma nota.');
    const url = textos[2];
    c.completar.mockResolvedValue('{"fala":["Vou enviar o link seguro."],"acao":"enviar_link_cofre_agenda","intencaoConexao":"pedir_novo_link"}');
    await c.turno('de-novo', 'me manda o link de novo');
    expect(await salvos()).toHaveLength(1); expect(c.enviarLink).toHaveBeenCalledOnce();
    expect(textos).toHaveLength(3); expect(textos.at(-1)).toBe(url);
    expect(c.aoConversar).toHaveBeenCalledExactlyOnceWith(['O link anterior continua válido; pode usar o mesmo.'], 'de-novo');
});
