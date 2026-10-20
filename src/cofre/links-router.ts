import { MENSAGEM_INSTABILIDADE, registroErroNoto } from '../observabilidade/erros.js';
import express, { type Request } from 'express';
import { z } from 'zod';
import { consentimentoCofre } from './tribemd-cofre.js';
import type { LinksCofre } from './links.js';

const credencial = z.object({ email: z.string().trim().email().max(254), senha: z.string().min(1).max(256), consentimento: z.literal(consentimentoCofre) }).strict();
const apagar = (req: Request) => { if (Buffer.isBuffer((req as any).rawBody)) (req as any).rawBody.fill(0); delete (req as any).rawBody; req.body = {}; };
const expirado = '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Link seguro Noto</title><p>Link expirado. Peça um novo link ao Noto.</p></html>';

export function criarRouterLinksCofre(links: LinksCofre | undefined, origem: string, obterWhatsappAssistente?: () => Promise<string | null>) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    app.use((req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
        if (!links || !origem) { res.status(503).send('Estamos com uma instabilidade no sistema. Tente novamente em instantes.'); return; }
        const url = new URL(origem);
        if (req.headers.host !== url.host || url.protocol === 'https:' && !req.secure || req.method === 'POST' && req.header('origin') !== origem) {
            res.status(403).send('Origem inválida.'); return;
        }
        next();
    });
    app.get('/:token', async (req, res) => {
        try {
            if (!await links!.validar(req.params.token)) { res.status(410).type('html').send(expirado); return; }
            // A ação relativa conserva o token só na URL, sem copiá-lo para a resposta.
            res.type('html').send(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Conectar TribeMD</title>
<h1>Conectar TribeMD</h1><p>Digite sua senha somente nesta página.</p>
<form method="post" onsubmit="this.action=location.pathname+'/enviar'">
<label>Email <input name="email" type="email" maxlength="254" required autocomplete="username"></label>
<label>Senha <input name="senha" type="password" maxlength="256" required autocomplete="current-password"></label>
<label><input name="consentimento" type="checkbox" value="tribemd-leitura-v1" required> Autorizo a leitura da minha agenda TribeMD (tribemd-leitura-v1).</label>
<button>Conectar</button></form></html>`);
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
            if (!(erro instanceof z.ZodError)) console.warn(registroErroNoto('SALVAR_ACESSO_FALHOU', 'tecnico', { etapa: 'pagina_acesso' }));
            res.status(erro instanceof z.ZodError ? 400 : 503).send(erro instanceof z.ZodError ? 'Entrada inválida.' : MENSAGEM_INSTABILIDADE);
        } finally { if (dados) { dados.email = ''; dados.senha = ''; } apagar(req); }
    });
    app.use((_req, res) => res.status(404).send('Página indisponível.'));
    app.use((_erro: unknown, req: Request, res: express.Response, _next: unknown) => { apagar(req); res.status(400).send('Entrada inválida.'); });
    return app;
}

/** O botão é cortesia: a continuação depende do evento de verificação, nunca do clique. */
export function paginaAcessoSalvo(telefone?: string | null): string {
    const destino = telefone && /^\d{10,15}$/.test(telefone) ? `https://wa.me/${telefone}` : 'whatsapp://';
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Acesso salvo | Noto</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
<style>:root{--bg:#F4F4F5;--text:#121C22;--text-secondary:rgba(18,28,34,0.72);--primary:#000000;--primary-hover:#202020;--font-family:"Geist",sans-serif;--headline-md-size:21.48px;--headline-md-line:31.15px;--body-lg-size:15px;--body-lg-line:21.75px}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-family);font-size:var(--body-lg-size);line-height:var(--body-lg-line);min-height:100dvh;display:grid;place-items:center;padding:24px}main{width:100%;max-width:400px;text-align:center}header{font-weight:600;letter-spacing:-1px;font-size:30.77px;margin-bottom:48px}.marca{width:48px;height:48px;margin:0 auto 20px;border:1px solid rgba(18,28,34,.15);border-radius:50%;display:grid;place-items:center}h1{font-size:var(--headline-md-size);line-height:var(--headline-md-line);font-weight:500;margin:0 0 12px}p{color:var(--text-secondary);margin:0 0 28px}.btn-action{display:block;text-decoration:none;background:var(--primary);color:white;border-radius:12px;padding:16px 20px;font:inherit;font-weight:500;transition:background .15s}.btn-action:hover{background:var(--primary-hover)}.btn-action:focus-visible{outline:2px solid var(--text);outline-offset:4px}.nota{font-size:12.99px;margin:20px 0 0}</style></head>
<body><main><header aria-label="Noto">noto</header><div class="marca" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="m6 12 4 4 8-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div><h1>Acesso salvo</h1><p>Estou verificando a conexão da sua agenda.<br>Eu continuo com você pelo WhatsApp.</p><a class="btn-action" href="${destino}">Voltar para o WhatsApp</a><p class="nota">Você pode fechar esta página. Não precisa me avisar que salvou.</p></main></body></html>`;
}
