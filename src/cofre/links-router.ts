import { MENSAGEM_INSTABILIDADE, registroErroNoto } from '../observabilidade/erros.js';
import express, { type Request } from 'express';
import { z } from 'zod';
import { AGENDAS_SUPORTADAS } from '../agenda/agendas-suportadas.js';
import type { LinksCofre } from './links.js';

const credencial = z.object({ email: z.string().trim().email().max(254), senha: z.string().min(1).max(256), consentimento: z.enum([AGENDAS_SUPORTADAS.tribemd.consentimento, AGENDAS_SUPORTADAS.amplimed.consentimento]) }).strict();
const apagar = (req: Request) => { if (Buffer.isBuffer((req as any).rawBody)) (req as any).rawBody.fill(0); delete (req as any).rawBody; req.body = {}; };

const estilo = `<style>:root{--bg:#F4F4F5;--text:#121C22;--text-secondary:rgba(18,28,34,0.72);--primary:#000000;--primary-hover:#202020;--font-family:"Geist",sans-serif;--headline-md-size:21.48px;--headline-md-line:31.15px;--body-lg-size:15px;--body-lg-line:21.75px}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-family);font-size:var(--body-lg-size);line-height:var(--body-lg-line);min-height:100dvh;display:grid;place-items:center;padding:24px}main{width:100%;max-width:400px;text-align:center}header{font-weight:600;letter-spacing:-1px;font-size:30.77px;margin-bottom:48px}.marca{width:48px;height:48px;margin:0 auto 20px;border:1px solid rgba(18,28,34,.15);border-radius:50%;display:grid;place-items:center}h1{font-size:var(--headline-md-size);line-height:var(--headline-md-line);font-weight:500;margin:0 0 12px}p{color:var(--text-secondary);margin:0 0 28px}.btn-action{display:block;text-decoration:none;background:var(--primary);color:white;border-radius:12px;padding:16px 20px;font:inherit;font-weight:500;transition:background .15s;border:none;width:100%;cursor:pointer}.btn-action:hover{background:var(--primary-hover)}.btn-action:focus-visible{outline:2px solid var(--text);outline-offset:4px}.nota{font-size:12.99px;margin:20px 0 0}
form{text-align:left;margin-top:8px}.campo{display:block;margin-bottom:20px}.campo span{display:block;font-weight:500;margin-bottom:8px}.campo input{width:100%;padding:16px;font:inherit;font-size:16px;border:1px solid rgba(18,28,34,.2);border-radius:12px;background:#fff;color:var(--text)}.campo input:focus-visible{outline:2px solid var(--text);outline-offset:2px}.autoriza{display:flex;gap:12px;align-items:flex-start;margin:0 0 28px;color:var(--text-secondary)}.autoriza input{width:20px;height:20px;margin-top:2px;flex:none;accent-color:var(--primary)}</style>`;
const marca = `<div class="marca" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="m6 12 4 4 8-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
export const pagina = (titulo: string, corpo: string) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${titulo} | Noto</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet">${estilo}</head>
<body><main><header aria-label="Noto">noto</header>${marca}${corpo}</main></body></html>`;

const expirado = pagina('Link seguro', `<h1>Link expirado</h1><p>Este link deixou de valer.<br>Peça um novo link ao Noto pelo WhatsApp.</p>`);
const origemRecusada = pagina('Link seguro', `<h1>Não consegui abrir este link</h1><p>Volte para a conversa com o Noto no WhatsApp e abra o link mais recente que eu te enviei.</p><a class="btn-action" href="whatsapp://">Voltar para o WhatsApp</a><p class="nota">Se o link mais recente também não abrir, me peça um novo por lá.</p>`);
const entradaRecusada = pagina('Conectar agenda', `<h1>Não consegui ler os dados</h1><p>Confira o e-mail, preencha a senha e marque a autorização. Depois toque em Conectar de novo.</p>`);

/** Guarda de origem/host compartilhada pelos links seguros (/c e /p). */
export function guardaOrigem(origem: string, paginaRecusada: string) {
    return (req: Request, res: express.Response, next: () => void) => {
        const url = new URL(origem);
        const semWww = url.host.replace(/^www\./, '');
        const hostsPublicos = new Set([url.host, semWww, 'www.' + semWww,
            req.header('x-forwarded-host')?.split(',')[0]?.trim()].filter((host): host is string => !!host));
        const origemAceita = (valor: string) => {
            try {
                const recebida = new URL(valor);
                return hostsPublicos.has(recebida.host) && (recebida.protocol === url.protocol ||
                    recebida.protocol === 'http:' && url.protocol === 'https:' && req.secure);
            } catch { return false; }
        };
        // O POST precisa de Origin/Referer/Sec-Fetch-Site compatível; sem todos eles (navegadores móveis antigos), a capacidade é o token descartável na URL.
        const postConfiavel = () => {
            const cabecalhoOrigem = req.header('origin');
            // No formulário com no-referrer, Origin null segue a mesma cadeia de um cabeçalho ausente.
            if (cabecalhoOrigem !== undefined && cabecalhoOrigem !== 'null') return origemAceita(cabecalhoOrigem);
            const referer = req.header('referer');
            if (referer !== undefined) { try { return origemAceita(new URL(referer).origin); } catch { return false; } }
            const fetchSite = req.header('sec-fetch-site');
            if (fetchSite !== undefined) return fetchSite === 'same-origin' || fetchSite === 'none';
            return true;
        };
        if (!hostsPublicos.has(req.headers.host ?? '') || url.protocol === 'https:' && !req.secure || req.method === 'POST' && !postConfiavel()) {
            // Não copiar caminhos, credenciais de URL ou valores arbitrários de cabeçalhos para o log.
            const valor = (nome: string) => {
                const v = req.header(nome);
                if (!v) return '-';
                if (nome === 'origin' && v === 'null') return 'null';
                if (nome === 'origin' || nome === 'referer') { try { return new URL(v).origin; } catch { return 'invalido'; } }
                if (nome === 'sec-fetch-site') return ['same-origin', 'same-site', 'cross-site', 'none'].includes(v) ? v : 'invalido';
                if (nome === 'x-forwarded-proto') return v.split(',').map(p => ['http', 'https'].includes(p.trim()) ? p.trim() : 'invalido').join(',');
                return v.split(',').map(h => /^[a-z0-9.[\]:-]+$/i.test(h.trim()) ? h.trim().replace(/[A-Za-z0-9_-]{43,}/g, '[OCULTO]') : 'invalido').join(',');
            };
            console.warn(registroErroNoto('ORIGEM_RECUSADA', 'tecnico', { detalhe: 'metodo=' + req.method + ' origin=' + valor('origin') + ' referer=' + valor('referer') + ' secfetch=' + valor('sec-fetch-site') + ' host=' + valor('host') + ' xfh=' + valor('x-forwarded-host') + ' xfp=' + valor('x-forwarded-proto') }));
            res.status(403).type('html').send(paginaRecusada); return;
        }
        next();
    };
}

export function criarRouterLinksCofre(links: LinksCofre | undefined, origem: string, obterWhatsappAssistente?: () => Promise<string | null>) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    app.use((req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
        if (!links || !origem) { res.status(503).send('Estamos com uma instabilidade no sistema. Tente novamente em instantes.'); return; }
        guardaOrigem(origem, origemRecusada)(req, res, next);
    });
    app.get('/:token', async (req, res) => {
        try {
            if (!await links!.validar(req.params.token)) { res.status(410).type('html').send(expirado); return; }
            // A ação relativa conserva o token só na URL, sem copiá-lo para a resposta.
            const ag = AGENDAS_SUPORTADAS[await links!.agendaDoLink(req.params.token) ?? 'tribemd'];
            res.type('html').send(pagina('Conectar agenda', `<h1>Conectar agenda ${ag.nome}</h1><p>Digite o e-mail e a senha da sua agenda. A senha é digitada somente nesta página.</p>
<form method="post" onsubmit="this.action=location.pathname+'/enviar'">
<label class="campo"><span>E-mail</span><input name="email" type="email" maxlength="254" required autocomplete="username"></label>
<label class="campo"><span>Senha</span><input name="senha" type="password" maxlength="256" required autocomplete="current-password"></label>
<label class="autoriza"><input name="consentimento" type="checkbox" value="${ag.consentimento}" required> <span>Autorizo o Noto a ler a minha agenda ${ag.nome}.</span></label>
<button class="btn-action">Conectar</button></form>`));
        } catch { res.status(503).send('Estamos com uma instabilidade no sistema. Tente novamente em instantes.'); }
    });
    app.use(express.json({ limit: '4kb' }), express.urlencoded({ limit: '4kb', extended: false }));
    app.post('/:token/enviar', async (req, res) => {
        let dados: z.infer<typeof credencial> | undefined;
        try {
            dados = credencial.parse(req.body);
            apagar(req);
            if (!await links!.enviarCredencial(req.params.token as string, dados)) { res.status(410).type('html').send(expirado); return; }
            const telefone = await obterWhatsappAssistente?.().catch(() => null);
            res.status(202).type('html').send(paginaAcessoSalvo(telefone));
        } catch (erro) {
            if (erro instanceof z.ZodError) console.warn(registroErroNoto('SALVAR_ACESSO_RECUSADO', 'tecnico', { detalhe: 'campos=' + erro.issues.map(i => i.path.join('.')).join(',') }));
            else console.warn(registroErroNoto('SALVAR_ACESSO_FALHOU', 'tecnico', { etapa: 'pagina_acesso' }));
            if (erro instanceof z.ZodError) { res.status(400).type('html').send(entradaRecusada); }
            else res.status(503).send(MENSAGEM_INSTABILIDADE);
        } finally { if (dados) { dados.email = ''; dados.senha = ''; } apagar(req); }
    });
    app.use((_req, res) => res.status(404).send('Página indisponível.'));
    app.use((_erro: unknown, req: Request, res: express.Response, _next: unknown) => { apagar(req); res.status(400).type('html').send(entradaRecusada); });
    return app;
}

/** O botão é cortesia: a continuação depende do evento de verificação, nunca do clique. */
export function paginaAcessoSalvo(telefone?: string | null): string {
    const destino = telefone && /^\d{10,15}$/.test(telefone) ? `https://wa.me/${telefone}` : 'whatsapp://';
    return pagina('Acesso salvo', `<h1>Acesso salvo</h1><p>Estou verificando a conexão da sua agenda.<br>Eu continuo com você pelo WhatsApp.</p><a class="btn-action" href="${destino}">Voltar para o WhatsApp</a><p class="nota">Você pode fechar esta página. Não precisa me avisar que salvou.</p>`);
}
