import { LinksCofre, type ConclusaoAgenda, type TextoLinkAgendaEnviado } from './links.js';
import { criarRouterLinksCofre } from './links-router.js';
import express, { type Request, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDoIdAmplimed, tomadorAmplimedAoVivo } from '../agenda/amplimed-lote.js';
import { lerEventosAgendaAmplimed, listarProfissionaisAgendaAmplimed, verificarLoginAmplimed } from '../desenvolvedor/amplimed-navegador.js';
import { CofreAmplimed } from './amplimed-cofre.js';
import { pedirCodigo2faPorArquivo } from './codigo-2fa-arquivo.js';
import { CofreTribemd, ErroCofre, consentimentoCofre } from './tribemd-cofre.js';
import { resolverReferenciaAgendaConta } from '../conta/referencia-agenda-conta.js';
const conectadoPorEstado: Record<Awaited<ReturnType<CofreTribemd['status']>>['estado'], boolean> = {
    vazio: false, salvo: false, conectando: false, conectado: true, desconectado: false, atencao: false
};
export interface EstadoAgendaCofre { salvo: boolean; conectada: boolean; consentimentoEm: string | null }
/** Com as duas agendas conectadas vale a que o médico conectou por último; sem nenhuma conectada, a salva. */
export function escolherAgendaAtiva(tribe: EstadoAgendaCofre, amplimed: EstadoAgendaCofre): 'tribemd' | 'amplimed' {
    if (!amplimed.salvo) return 'tribemd';
    if (!tribe.salvo) return 'amplimed';
    if (amplimed.conectada && !tribe.conectada) return 'amplimed';
    if (tribe.conectada && !amplimed.conectada) return 'tribemd';
    return (amplimed.consentimentoEm ?? '') > (tribe.consentimentoEm ?? '') ? 'amplimed' : 'tribemd';
}
export function mapearStatusAgenda(status: Awaited<ReturnType<CofreTribemd['status']>>) {
    return { nome: status.salvo ? 'tribemd' : null, conectada: status.ativo && conectadoPorEstado[status.estado] };
}
const credencial = z.object({ email: z.string().trim().email().max(254), senha: z.string().min(1).max(256), consentimento: z.literal(consentimentoCofre) }).strict();
const vazio = z.object({}).strict();
const apagar = (req: Request) => { if (Buffer.isBuffer((req as any).rawBody))
    (req as any).rawBody.fill(0); delete (req as any).rawBody; req.body = {}; };
export function criarCofreContas(deps: {
    pool: pg.Pool;
    autenticar: (token: string) => Promise<string | null>;
    env?: NodeJS.ProcessEnv;
    aoAlterarAcesso?: (medicoId: string) => void;
    aoConcluirAgenda?: (medicoId: string, evento: ConclusaoAgenda) => Promise<void>;
    obterWhatsappAssistente?: () => Promise<string | null>;
    registrarTextoLink?: (entrada: TextoLinkAgendaEnviado) => Promise<void>;
    enviarCofre?: (medicoId: string, texto: string, contatoTelefone?:string) => Promise<'simulado' | 'enviado' | 'erro'>;
}) {
    const env = deps.env ?? process.env, app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    let origem = '', cofre: CofreTribemd | undefined, cofreAmplimed: CofreAmplimed | undefined, links: LinksCofre | undefined;
    try {
        const u = new URL(env.COFRE_ORIGEM || env.TRIBEMD_TESTE_ORIGEM || '');
        if (u.pathname !== '/' || u.search || u.hash || u.username || u.password || u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)))
            throw Error();
        origem = u.origin;
        const base = env.COFRE_DIRETORIO || env.TRIBEMD_TESTE_DIRETORIO;
        if (!base)
            throw Error();
        const raiz = join(base, 'cofres-contas-v1');
        cofre = new CofreTribemd({ aoAlterarAcesso: deps.aoAlterarAcesso, diretorio: raiz, chave: env.COFRE_CHAVE || env.TRIBEMD_TESTE_CHAVE || '', chromium: env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium-browser', xvfb: env.XVFB_EXECUTABLE_PATH, aoConcluir: (id, conectado) => links?.concluir(id, conectado) ?? Promise.resolve() });
        const chromiumAmplimed = env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium-browser';
        const dir2fa = env.NOTO_AMPLIMED_2FA_DIRETORIO || undefined;
        // O diretório é local ao container (some a cada deploy): recria a cada boot, restrito ao serviço.
        if (dir2fa) mkdirSync(dir2fa, { recursive: true, mode: 0o700 });
        cofreAmplimed = new CofreAmplimed({ aoAlterarAcesso: deps.aoAlterarAcesso, diretorio: raiz, chave: env.COFRE_CHAVE || env.TRIBEMD_TESTE_CHAVE || '',
            verificar: c => verificarLoginAmplimed({ executavel: chromiumAmplimed, ...c }), lerEventos: (c, diasAtras, detalhes, codigoProfissional) => lerEventosAgendaAmplimed({ executavel: chromiumAmplimed, ...c, diasAtras, detalhes, codigoProfissional }), listarProfissionais: c => listarProfissionaisAgendaAmplimed({ executavel: chromiumAmplimed, ...c }), aoConcluir: (id, conectado) => links?.concluir(id, conectado) ?? Promise.resolve(),
            pedirCodigo2fa: dir2fa ? id => pedirCodigo2faPorArquivo(dir2fa, id) : undefined });
        if (deps.enviarCofre) links = new LinksCofre({ pool: deps.pool, origem, cofre, cofres: { amplimed: cofreAmplimed }, registrarTextoEnviado: deps.registrarTextoLink, enviar: deps.enviarCofre, aoConcluir: deps.aoConcluirAgenda });
    }
    catch { /* Configuração indisponível afeta somente o cofre; não publicar valores. */ }
    app.use(async (req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
        try {
            const h = req.header('authorization') || '', authId = h.startsWith('Bearer ') ? await deps.autenticar(h.slice(7)) : null;
            if (!authId) {
                res.status(401).json({ ok: false, codigo: 'SESSAO_INVALIDA' });
                return;
            }
            const dono = (await deps.pool.query(`
                select m.id
                from usuarios u join medicos m on m.conta_id=u.conta_id
                where u.auth_user_id=$1 and u.ativo=true
                order by m.criado_em,m.id
                limit 1`, [authId])).rows[0];
            if (!dono || !z.string().uuid().safeParse(dono.id).success) {
                res.status(403).json({ ok: false, codigo: 'CONTA_INDISPONIVEL' });
                return;
            }
            if (!cofre || !origem) {
                res.status(503).json({ ok: false, codigo: 'COFRE_INDISPONIVEL' });
                return;
            }
            const url = new URL(origem);
            if (req.headers.host !== url.host || url.protocol === 'https:' && !req.secure || !['GET', 'HEAD'].includes(req.method) && (req.header('origin') !== origem || req.header('x-noto-cofre') !== '1')) {
                res.status(403).json({ ok: false, codigo: 'ORIGEM_INVALIDA' });
                return;
            }
            res.locals.dono = dono.id;
            next();
        }
        catch {
            res.status(503).json({ ok: false, codigo: 'COFRE_INDISPONIVEL' });
        }
    });
    app.use(express.json({ limit: '4kb' }));
    const rota = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
        try {
            await fn(req, res);
        }
        catch (e) {
            const codigo = e instanceof z.ZodError ? 'ENTRADA_INVALIDA' : e instanceof ErroCofre ? e.codigo : 'COFRE_INDISPONIVEL';
            res.status(e instanceof z.ZodError ? 400 : e instanceof ErroCofre ? 409 : 503).json({ ok: false, codigo });
        }
        finally {
            apagar(req);
        }
    };
    app.get('/tribemd', rota(async (_req, res) => { res.json({ ok: true, cofre: await cofre!.status(res.locals.dono) }); }));
    app.post('/tribemd', rota(async (req, res) => {
        let d: z.infer<typeof credencial> | undefined;
        try {
            d = credencial.parse(req.body);
            apagar(req);
            res.status(202).json({ ok: true, cofre: await cofre!.iniciar(res.locals.dono, d) });
        }
        finally {
            if (d) {
                d.email = '';
                d.senha = '';
            }
        }
    }));
    app.post('/tribemd/reconectar', rota(async (req, res) => { vazio.parse(req.body); res.status(202).json({ ok: true, cofre: await cofre!.iniciar(res.locals.dono) }); }));
    app.post('/tribemd/desconectar', rota(async (req, res) => { vazio.parse(req.body); await cofre!.desconectar(res.locals.dono); res.json({ ok: true, cofre: await cofre!.status(res.locals.dono) }); }));
    app.delete('/tribemd', rota(async (req, res) => { vazio.parse(req.body); await cofre!.excluir(res.locals.dono); res.json({ ok: true, cofre: await cofre!.status(res.locals.dono) }); }));
    app.post('/tribemd/consultas', rota(async (req, res) => { vazio.parse(req.body); res.status(202).json({ ok: true, cofre: await cofre!.consultar(res.locals.dono) }); }));
    app.get('/tribemd/consultas', rota(async (_req, res) => { res.json({ ok: true, cofre: await cofre!.status(res.locals.dono), resultado: cofre!.resultado(res.locals.dono) }); }));
    // Amplimed: espelho do painel do TribeMD. Leitura apenas; a conexão sempre passa pela verificação em modo observação.
    const credencialAmplimed = z.object({ email: z.string().trim().max(254).min(3), senha: z.string().min(1).max(256), consentimento: z.literal('amplimed-leitura-v1') }).strict();
    app.get('/amplimed', rota(async (_req, res) => { if (!cofreAmplimed) throw new ErroCofre('COFRE_INDISPONIVEL'); res.json({ ok: true, cofre: await cofreAmplimed.status(res.locals.dono) }); }));
    app.post('/amplimed', rota(async (req, res) => {
        if (!cofreAmplimed) throw new ErroCofre('COFRE_INDISPONIVEL');
        let d: z.infer<typeof credencialAmplimed> | undefined;
        try {
            d = credencialAmplimed.parse(req.body);
            apagar(req);
            res.status(202).json({ ok: true, cofre: await cofreAmplimed.iniciar(res.locals.dono, { email: d.email, senha: d.senha }) });
        }
        finally { if (d) { d.email = ''; d.senha = ''; } }
    }));
    app.post('/amplimed/reconectar', rota(async (req, res) => { vazio.parse(req.body); if (!cofreAmplimed) throw new ErroCofre('COFRE_INDISPONIVEL'); res.status(202).json({ ok: true, cofre: await cofreAmplimed.reverificar(res.locals.dono) }); }));
    app.delete('/amplimed', rota(async (req, res) => { vazio.parse(req.body); if (!cofreAmplimed) throw new ErroCofre('COFRE_INDISPONIVEL'); res.json({ ok: true, cofre: await cofreAmplimed.excluir(res.locals.dono) }); }));
    app.use((_req, res) => res.status(404).json({ ok: false, codigo: 'COFRE_ROTA_INVALIDA' }));
    app.use((_erro: unknown, req: Request, res: Response, _next: unknown) => { apagar(req); res.status(400).json({ ok: false, codigo: 'ENTRADA_INVALIDA' }); });
    const referencia = (medicoId:string,agenda:'tribemd'|'amplimed') =>
        resolverReferenciaAgendaConta(deps.pool,medicoId,agenda).catch(()=>medicoId);
    return { app, links, detalheAoVivo: async (medicoId: string, atendimentoId: string) => {
        if (!cofre) throw new ErroCofre('COFRE_INDISPONIVEL');
        return cofre.detalheAoVivo(await referencia(medicoId,'tribemd'), atendimentoId);
    }, appLinks: criarRouterLinksCofre(links, origem, deps.obterWhatsappAssistente), fonteAgenda: { consultar: async (entrada: import('../agenda/fonte-agenda.js').EntradaFonteAgenda) => {
        if(!cofre)return { tipo: 'erro' as const, codigo: 'SEM_AGENDA_CONECTADA' as const };
        const ref=await referencia(entrada.medicoId,'tribemd');
        return cofre.fonteAgenda.consultar({...entrada,medicoId:ref,referenciaCofre:ref});
    } }, encerrar: async () => { await cofre?.encerrar(); },
        statusAgendas: async (medicoId: string) => {
            if (!cofre) throw new ErroCofre('COFRE_INDISPONIVEL');
            const refTribe=await referencia(medicoId,'tribemd');
            const refAmplimed=await referencia(medicoId,'amplimed');
            const status = await cofre.status(refTribe);
            const tribe = { salvo: status.salvo, conectada: status.salvo && status.ativo && conectadoPorEstado[status.estado], consentimentoEm: await cofre.consentimentoEm(refTribe) };
            const a = cofreAmplimed ? await cofreAmplimed.status(refAmplimed) : null;
            const amplimed = { salvo: !!a?.salvo, conectada: !!a?.salvo && !!a?.ativo && a?.estado === 'conectado', consentimentoEm: a?.consentimentoEm ?? null };
            return { tribemd: tribe, amplimed };
        },
        statusAgenda: async (medicoId: string) => {
            if (!cofre) throw new ErroCofre('COFRE_INDISPONIVEL');
            const refTribe=await referencia(medicoId,'tribemd');
            const refAmplimed=await referencia(medicoId,'amplimed');
            const status = await cofre.status(refTribe);
            if (cofreAmplimed) {
                const a = await cofreAmplimed.status(refAmplimed);
                const escolha = escolherAgendaAtiva(
                    { salvo: status.salvo, conectada: status.salvo && status.ativo && conectadoPorEstado[status.estado], consentimentoEm: await cofre.consentimentoEm(refTribe) },
                    { salvo: a.salvo, conectada: a.salvo && a.ativo && a.estado === 'conectado', consentimentoEm: a.consentimentoEm });
                if (escolha === 'amplimed') return { nome: 'amplimed' as string | null, conectada: a.salvo && a.ativo && a.estado === 'conectado' };
            }
            return mapearStatusAgenda(status);
        },
        lerAgendaAmplimed: async (medicoId: string, desde: string, hoje: string, comDetalhes = false, codigoProfissional?: string) => {
            const ref=await referencia(medicoId,'amplimed');
            return cofreAmplimed ? cofreAmplimed.lerAgendaPeriodo(ref, desde, hoje, comDetalhes, codigoProfissional) : { ok: false as const, motivo: 'LEITURA_INDISPONIVEL' };
        },
        listarProfissionaisAmplimed: async (medicoId: string) => {
            const ref=await referencia(medicoId,'amplimed');
            return cofreAmplimed ? cofreAmplimed.listarProfissionais(ref) : { ok: false as const, motivo: 'LEITURA_INDISPONIVEL' as const };
        },
        detalheAmplimedAoVivo: async (medicoId: string, idExterno: string) => {
            const data = dataDoIdAmplimed(idExterno);
            if (!cofreAmplimed || !data) throw new ErroCofre('SEM_AGENDA_CONECTADA');
            const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
            const ref=await referencia(medicoId,'amplimed');
            const r = await cofreAmplimed.lerAgendaPeriodo(ref, data, hoje, true);
            if (!r.ok) throw new ErroCofre('DETALHES_NAO_CONCLUIDOS');
            return tomadorAmplimedAoVivo(r.dias, idExterno);
        }
    };
}
