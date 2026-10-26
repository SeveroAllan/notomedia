import { beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { Permissoes, ROTULOS, explicacaoEscolhaPermissao } from '../src/permissoes/permissoes.js';
import { criarRouterPermissoes } from '../src/permissoes/router.js';
import { ComunicacaoHomologacao } from '../src/whatsapp/comunicacao-homologacao.js';
import { carregarConfig } from '../src/config.js';

const medicoId = '11111111-1111-4111-8111-111111111111';
const contaDoMedico = () => vinculos.find(v => v.medico_id === medicoId)!.conta;

interface LinkFalso { id: string; conta: string; permissao: string; criado_por: string; token_hash: string; expira_em: Date; usado_em: Date | null }
let contas: { id: string; numero_whatsapp: string; operador: string | null }[];
let vinculos: { conta: string; medico_id: string }[];
let links: LinkFalso[];
let escolhas: { conta: string; permissao: string; valor: string; escolhido_por: string | null; link_id: string }[];
let auditoria: { conta: string; permissao: string; valor: string }[];
let linksAuditoria: { link_id: string; evento: string }[];
let medicoTelefone: string | null;
let sequencia = 0;

function queryFalsa(sql: string, valores: any[] = []): Promise<{ rows: any[] }> {
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return Promise.resolve({ rows: [] });
    if (sql.includes('from noto_whatsapps_medicos m join noto_whatsapps_conectados')) {
        const v = vinculos.find(v => v.medico_id === valores[0]);
        const c = v && contas.find(c => c.id === v.conta);
        return Promise.resolve({ rows: c ? [{ id: c.id, numero_whatsapp: c.numero_whatsapp, operador: c.operador }] : [] });
    }
    if (sql.includes('select distinct c.id,c.numero_whatsapp,c.operador')) {
        return Promise.resolve({ rows: [] });
    }
    if (sql.includes("select distinct regexp_replace(u.telefone")) {
        return Promise.resolve({ rows: medicoTelefone ? [{ telefone: medicoTelefone.replace(/\D/g,'') }] : [] });
    }
    if (sql.includes('select u.telefone from medicos')) {
        return Promise.resolve({ rows: medicoTelefone ? [{ telefone: medicoTelefone }] : [] });
    }
    if (sql.includes('insert into noto_whatsapps_conectados')) {
        let c = contas.find(c => c.numero_whatsapp === valores[0]);
        if (!c) { c = { id: `conta-${++sequencia}`, numero_whatsapp: valores[0], operador: null }; contas.push(c); }
        return Promise.resolve({ rows: [{ id: c.id, numero_whatsapp: c.numero_whatsapp, operador: c.operador }] });
    }
    if (sql.includes('insert into noto_whatsapps_medicos')) {
        if (!vinculos.some(v => v.medico_id === valores[1])) vinculos.push({ conta: valores[0], medico_id: valores[1] });
        return Promise.resolve({ rows: [] });
    }
    if (sql.includes('select valor, escolhido_por, atualizado_em::text from noto_permissoes')) {
        const e = escolhas.find(e => e.conta === valores[0] && e.permissao === valores[1]);
        return Promise.resolve({ rows: e ? [{ valor: e.valor, escolhido_por: e.escolhido_por, atualizado_em: '2026-10-23' }] : [] });
    }
    if (sql.includes('select 1 from noto_permissoes_links where')) {
        return Promise.resolve({ rows: links.some(l => l.conta === valores[0] && l.permissao === valores[1]) ? [{ '?column?': 1 }] : [] });
    }
    if (sql.includes('for update')) return Promise.resolve({ rows: [{ id: valores[0] }] });
    if (sql.includes('with expirados as (update noto_permissoes_links')) {
        for (const l of links) if (l.conta === valores[0] && l.permissao === valores[1] && !l.usado_em && l.expira_em.getTime() > Date.now()) {
            l.expira_em = new Date(Date.now() - 1); linksAuditoria.push({ link_id: l.id, evento: 'expirado' });
        }
        return Promise.resolve({ rows: [] });
    }
    if (sql.includes('insert into noto_permissoes_links (')) {
        const link: LinkFalso = { id: `link-${++sequencia}`, conta: valores[0], permissao: valores[1], criado_por: valores[2], token_hash: valores[3],
            expira_em: new Date(Date.now() + 15 * 60000), usado_em: null };
        links.push(link);
        return Promise.resolve({ rows: [{ id: link.id }] });
    }
    if (sql.includes('insert into noto_permissoes_links_auditoria')) {
        if (!linksAuditoria.some(a => a.link_id === valores[0] && a.evento === valores[1])) linksAuditoria.push({ link_id: valores[0], evento: valores[1] });
        return Promise.resolve({ rows: [] });
    }
    if (sql.includes('select id, permissao, usado_em, expira_em<=now() as expirado from noto_permissoes_links')) {
        const l = links.find(l => l.token_hash === valores[0]);
        return Promise.resolve({ rows: l ? [{ id: l.id, permissao: l.permissao, usado_em: l.usado_em, expirado: l.expira_em.getTime() <= Date.now() }] : [] });
    }
    if (sql.includes('update noto_permissoes_links set usado_em')) {
        const l = links.find(l => l.token_hash === valores[0]);
        if (!l || l.usado_em || l.expira_em.getTime() <= Date.now()) return Promise.resolve({ rows: [] });
        l.usado_em = new Date();
        return Promise.resolve({ rows: [{ id: l.id, whatsapp_conectado_id: l.conta, permissao: l.permissao, criado_por_medico_id: l.criado_por }] });
    }
    if (sql.includes('select operador from noto_whatsapps_conectados where id=')) {
        return Promise.resolve({ rows: [{ operador: contas.find(c => c.id === valores[0])?.operador ?? null }] });
    }
    if (sql.includes('insert into noto_permissoes (')) {
        const i = escolhas.findIndex(e => e.conta === valores[0] && e.permissao === valores[1]);
        const registro = { conta: valores[0], permissao: valores[1], valor: valores[2], escolhido_por: valores[3], link_id: valores[4] };
        if (i >= 0) escolhas[i] = registro; else escolhas.push(registro);
        return Promise.resolve({ rows: [] });
    }
    if (sql.includes('insert into noto_permissoes_auditoria')) {
        auditoria.push({ conta: valores[0], permissao: valores[1], valor: valores[2] });
        return Promise.resolve({ rows: [] });
    }
    throw new Error('SQL não mapeado no fake: ' + sql.slice(0, 90));
}
const poolFalso = () => ({ query: queryFalsa, connect: async () => ({ query: queryFalsa, release: () => {} }) }) as unknown as pg.Pool;

beforeEach(() => {
    contas = []; vinculos = []; links = []; escolhas = []; auditoria = []; linksAuditoria = []; sequencia = 0;
    medicoTelefone = '5551993527271';
});

describe('Permissoes: escopo por WhatsApp conectado', () => {
    it('a escolha da conta vale para outro médico da mesma conta e nunca para outra conta', async () => {
        const p = new Permissoes({ pool: poolFalso(), origem: '' });
        const medicoB = '22222222-2222-4222-8222-222222222222';
        const medicoC = '33333333-3333-4333-8333-333333333333';
        // conta da clínica provisionada pelo médico A; médico B é vinculado à mesma conta
        const a = await p.criarLink(medicoId, 'emitir_autonomo');
        expect('url' in a).toBe(true);
        const contaA = vinculos.find(v => v.medico_id === medicoId)!.conta;
        vinculos.push({ conta: contaA, medico_id: medicoB });
        const r = await p.escolher((a as { url: string }).url.split('/p/')[1], 'autonomo');
        expect(r).toMatchObject({ ok: true, medicoId });
        // B (mesma conta) herda a escolha; C (outra conta, outro telefone) não
        expect(await p.permite(medicoB, 'emitir_autonomo')).toBe(true);
        medicoTelefone = '5551988887777';
        expect(await p.permite(medicoC, 'emitir_autonomo')).toBe(false);
        expect(vinculos.find(v => v.medico_id === medicoC)!.conta).not.toBe(contaA);
    });
});

describe('Permissoes: ausência nunca autoriza', () => {
    it('sem escolha gravada, permite() é falso para as duas permissões', async () => {
        const p = new Permissoes({ pool: poolFalso(), origem: 'https://notomed.tech' });
        expect(await p.ler(medicoId, 'emitir_autonomo')).toBeNull();
        expect(await p.permite(medicoId, 'emitir_autonomo')).toBe(false);
        expect(await p.permite(medicoId, 'entregar_paciente')).toBe(false);
        expect(await p.faltantes(medicoId)).toEqual(['emitir_autonomo', 'entregar_paciente', 'solicitar_cpf']);
    });
    it('valores conservadores gravados também não liberam', async () => {
        const p = new Permissoes({ pool: poolFalso(), origem: 'https://notomed.tech' });
        const link1 = await p.criarLink(medicoId, 'emitir_autonomo');
        const token1 = 'url' in link1! ? link1.url.split('/p/')[1] : '';
        const hash1 = (await import('node:crypto')).createHash('sha256').update(token1).digest('hex');
        // grava direto o valor conservador, como a página faria
        const l = links.find(l => l.token_hash === hash1)!; l.usado_em = null;
        escolhas.push({ conta: contaDoMedico(), permissao: 'emitir_autonomo', valor: 'sempre_perguntar', escolhido_por: null, link_id: l.id });
        expect(await p.permite(medicoId, 'emitir_autonomo')).toBe(false);
        escolhas.push({ conta: contaDoMedico(), permissao: 'entregar_paciente', valor: 'so_medico', escolhido_por: null, link_id: l.id });
        expect(await p.permite(medicoId, 'entregar_paciente')).toBe(false);
    });
    it('só o valor que libera, gravado, libera', async () => {
        const p = new Permissoes({ pool: poolFalso(), origem: 'https://notomed.tech' });
        await p.criarLink(medicoId, 'emitir_autonomo');
        escolhas.push({ conta: contaDoMedico(), permissao: 'emitir_autonomo', valor: 'autonomo', escolhido_por: null, link_id: 'x' });
        expect(await p.permite(medicoId, 'emitir_autonomo')).toBe(true);
        expect(await p.permite(medicoId, 'entregar_paciente')).toBe(false);
    });
});

describe('Permissoes: link de escolha', () => {
    it('cria link /p/ com token de 43 caracteres e invalida o anterior da mesma permissão', async () => {
        const p = new Permissoes({ pool: poolFalso(), origem: 'https://notomed.tech' });
        const a = await p.criarLink(medicoId, 'emitir_autonomo');
        const b = await p.criarLink(medicoId, 'emitir_autonomo');
        if (!('url' in a!) || !('url' in b!)) throw new Error('links não criados');
        expect(a.url).toMatch(/^https:\/\/notomed\.tech\/p\/[A-Za-z0-9_-]{43}$/);
        const tokenA = a.url.split('/p/')[1], tokenB = b.url.split('/p/')[1];
        expect(await p.abrir(tokenA)).toBeNull(); // anterior expirado
        expect(await p.abrir(tokenB)).toEqual({ permissao: 'emitir_autonomo' });
        expect(await p.linkJaCriado(medicoId, 'emitir_autonomo')).toBe(true);
        expect(await p.linkJaCriado(medicoId, 'entregar_paciente')).toBe(false);
    });
    it('escolha válida grava vigente + auditoria, queima o link e devolve o dono', async () => {
        const p = new Permissoes({ pool: poolFalso(), origem: 'https://notomed.tech' });
        const a = await p.criarLink(medicoId, 'entregar_paciente');
        const token = 'url' in a! ? a.url.split('/p/')[1] : '';
        const r = await p.escolher(token, 'paciente');
        expect(r).toMatchObject({ ok: true, permissao: 'entregar_paciente', valor: 'paciente', medicoId });
        expect(escolhas).toHaveLength(1);
        expect(auditoria).toEqual([{ conta: contaDoMedico(), permissao: 'entregar_paciente', valor: 'paciente' }]);
        expect(await p.permite(medicoId, 'entregar_paciente')).toBe(true);
        // uso único: o mesmo token não grava de novo
        expect(await p.escolher(token, 'so_medico')).toEqual({ ok: false, motivo: 'INVALIDO' });
        expect(escolhas[0].valor).toBe('paciente');
    });
    it('valor fora do conjunto não grava nada', async () => {
        const p = new Permissoes({ pool: poolFalso(), origem: 'https://notomed.tech' });
        const a = await p.criarLink(medicoId, 'emitir_autonomo');
        const token = 'url' in a! ? a.url.split('/p/')[1] : '';
        expect(await p.escolher(token, 'so_medico')).toEqual({ ok: false, motivo: 'VALOR' });
        expect(escolhas).toHaveLength(0);
        expect(await p.permite(medicoId, 'emitir_autonomo')).toBe(false);
    });
    it('mudança de escolha atualiza a vigente e mantém as duas na auditoria', async () => {
        const p = new Permissoes({ pool: poolFalso(), origem: 'https://notomed.tech' });
        const t1 = await p.criarLink(medicoId, 'emitir_autonomo');
        await p.escolher('url' in t1! ? t1.url.split('/p/')[1] : '', 'sempre_perguntar');
        const t2 = await p.criarLink(medicoId, 'emitir_autonomo');
        await p.escolher('url' in t2! ? t2.url.split('/p/')[1] : '', 'autonomo');
        expect(escolhas).toHaveLength(1);
        expect(escolhas[0].valor).toBe('autonomo');
        expect(auditoria.map(a => a.valor)).toEqual(['sempre_perguntar', 'autonomo']);
        expect(await p.permite(medicoId, 'emitir_autonomo')).toBe(true);
    });
    it('sem conta (médico inexistente), criarLink falha sem vazar detalhe', async () => {
        medicoTelefone = null;
        const p = new Permissoes({ pool: poolFalso(), origem: 'https://notomed.tech' });
        expect(await p.criarLink(medicoId, 'emitir_autonomo')).toEqual({ erro: 'SEM_CONTA' });
    });
});

describe('router /p: página de escolha com botões', () => {
    let servidor: Server, base: string, escolhido: unknown[];
    beforeEach(async () => {
        escolhido = [];
        const p = new Permissoes({ pool: poolFalso(), origem: '' });
        servidor = createServer();
        await new Promise<void>(r => servidor.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
        (p as any).deps.origem = base;
        const app = (await import('express')).default();
        app.use('/p', criarRouterPermissoes(p, base, async r => { escolhido.push(r); }));
        servidor.on('request', app);
        (globalThis as any).__permissoesTeste = p;
    });
    const fechar = () => new Promise<void>((r, j) => servidor.close(e => e ? j(e) : r()));
    it('GET mostra os dois botões da permissão; POST grava e avisa; link morre', async () => {
        const p = (globalThis as any).__permissoesTeste as Permissoes;
        const a = await p.criarLink(medicoId, 'entregar_paciente');
        const url = 'url' in a! ? a.url : '';
        const get = await fetch(url, { headers: { host: new URL(base).host } });
        expect(get.status).toBe(200);
        const html = await get.text();
        expect(html).toContain(ROTULOS.entregar_paciente.botoes.paciente);
        expect(html).toContain(ROTULOS.entregar_paciente.botoes.so_medico);
        expect(html).toContain('type="submit"');
        expect(html).toContain('não emite nem envia notas antigas');
        const post = await fetch(url + '/escolher', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: 'valor=paciente' });
        expect(post.status).toBe(202);
        expect(await post.text()).toContain('Escolha salva');
        expect(escolhido).toEqual([{ permissao: 'entregar_paciente', valor: 'paciente', medicoId, linkId: links[0].id }]);
        expect(await (await fetch(url, { headers: { host: new URL(base).host } })).status).toBe(410);
        await fechar();
    });
    it.each([
        ['autonomo', ROTULOS.emitir_autonomo.botoes.autonomo],
        ['sempre_perguntar', ROTULOS.emitir_autonomo.botoes.sempre_perguntar]
    ] as const)('POST de emissão salva e confirma exatamente o botão %s, sem escolha implícita', async (valor,label) => {
        const p = (globalThis as any).__permissoesTeste as Permissoes;
        const a = await p.criarLink(medicoId, 'emitir_autonomo');
        const url = 'url' in a! ? a.url : '';
        const post = await fetch(url + '/escolher', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: 'valor='+valor });
        expect(post.status).toBe(202);
        const resposta=await post.text();
        expect(escolhas.at(-1)?.valor).toBe(valor);
        expect(escolhido.at(-1)).toMatchObject({permissao:'emitir_autonomo',valor});
        expect(resposta).toContain(label);
        expect(resposta).toContain('Essa foi exatamente a opção salva');
        expect(resposta).toContain('não emite nem envia notas antigas');
        await fechar();
    });
    it('GET de token desconhecido devolve 410; POST com origem estranha é recusado', async () => {
        const p = (globalThis as any).__permissoesTeste as Permissoes;
        const a = await p.criarLink(medicoId, 'emitir_autonomo');
        const url = 'url' in a! ? a.url : '';
        expect(await (await fetch(base + '/p/token-inexistente-12345678901234567890123', { headers: { host: new URL(base).host } })).status).toBe(410);
        const post = await fetch(url + '/escolher', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' }, body: 'valor=autonomo' });
        expect(post.status).toBe(403);
        expect(escolhas).toHaveLength(0);
        await fechar();
    });
});

describe('portão de entrega ao paciente', () => {
    it('sem permissão gravada, paciente() não envia e avisa o médico (entrega_sem_permissao)', async () => {
        const envios: string[] = [];
        const nota = { nota_fiscal_id: 'nf-1', pdf_storage_path: '/tmp/x.pdf', origem: 'lote', contato_telefone: '5551999990000',
            ambiente: 'homologacao', nome_instancia: 'inst-medica', instancia_medico_id: medicoId, instancia_status: 'conectado' };
        const pool = { query: async (sql: string) => {
            if (sql.includes('from notas_fiscais')) return { rows: [nota] };
            if (sql.includes('select u.telefone')) return { rows: [{ telefone: '5551993527271', ambiente: 'homologacao' }] };
            if (sql.includes('noto_envios_homologacao')) return sql.startsWith('insert') || sql.includes('insert into') ? { rows: [{ id: 1 }] } : { rows: [] };
            if (sql.includes('conversa_mensagens')) return { rows: [] };
            return { rows: [] };
        } } as unknown as pg.Pool;
        const config = carregarConfig({ DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: 'k', APP_PEPPER: 'p',
            ENVIO_MEDICO_REAL_ATIVO: 'true', ENVIO_PACIENTE_REAL_ATIVO: 'true', ENVIO_REAL_ALLOWLIST: '5551993527271,5551999990000' });
        const permissoes = { permite: async () => false, linkJaCriado: async () => true, criarLink: async () => ({ url: 'https://x/p/t' }) } as unknown as Permissoes;
        const com = new ComunicacaoHomologacao(pool, config, { enviarTexto: async () => ({ sucesso: true, mensagemId: 'm1' }) } as any, console.info, permissoes);
        const r = await com.paciente({ medicoId, solicitacaoId: 'sol-1' }, { enviarPdf: async () => { envios.push('pdf'); return { sucesso: true }; } } as any);
        expect(r).toBe('sem_permissao');
        expect(envios).toEqual([]); // nada ao paciente
    });
    it('com entregar_paciente=paciente gravado, o envio segue o caminho normal', async () => {
        const envios: string[] = [];
        const nota = { nota_fiscal_id: 'nf-1', pdf_storage_path: '/tmp/x.pdf', origem: 'lote', contato_telefone: '5551999990000',
            ambiente: 'homologacao', nome_instancia: 'inst-medica', instancia_medico_id: medicoId, instancia_status: 'conectado' };
        const pool = { query: async (sql: string) => {
            if (sql.includes('from notas_fiscais')) return { rows: [nota] };
            if (sql.includes('select u.telefone')) return { rows: [{ telefone: '5551993527271', ambiente: 'homologacao' }] };
            if (sql.includes('noto_envios_homologacao')) return sql.includes('insert into') ? { rows: [{ id: 1 }] } : { rows: [] };
            if (sql.includes('conversa_mensagens')) return { rows: [] };
            return { rows: [] };
        } } as unknown as pg.Pool;
        const config = carregarConfig({ DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: 'k', APP_PEPPER: 'p',
            ENVIO_MEDICO_REAL_ATIVO: 'true', ENVIO_PACIENTE_REAL_ATIVO: 'true', ENVIO_REAL_ALLOWLIST: '5551993527271,5551999990000' });
        const permissoes = { permite: async (_id: string, p: string) => p === 'entregar_paciente', linkJaCriado: async () => true, criarLink: async () => ({ url: 'https://x/p/t' }) } as unknown as Permissoes;
        const com = new ComunicacaoHomologacao(pool, config, { enviarTexto: async () => ({ sucesso: true, mensagemId: 'm1' }) } as any, console.info, permissoes);
        const r = await com.paciente({ medicoId, solicitacaoId: 'sol-1' }, { enviarPdf: async () => { envios.push('pdf'); return { sucesso: true }; } } as any);
        expect(r).toBe('enviado');
        expect(envios).toEqual(['pdf']);
    });
});


it('explicação de emissão é neutra: mostra as duas opções e diz que sim no chat não escolhe nenhuma',()=>{
 const fala=explicacaoEscolhaPermissao('emitir_autonomo').join(' ');
 expect(fala).toContain(ROTULOS.emitir_autonomo.botoes.autonomo);
 expect(fala).toContain(ROTULOS.emitir_autonomo.botoes.sempre_perguntar);
 expect(fala).toContain('Responder “sim” aqui no WhatsApp não escolhe nenhuma opção');
});
