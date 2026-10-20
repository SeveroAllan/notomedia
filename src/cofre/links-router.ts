import express, { type Request } from 'express';
import { z } from 'zod';
import { consentimentoCofre } from './tribemd-cofre.js';
import type { LinksCofre } from './links.js';

const credencial = z.object({ email: z.string().trim().email().max(254), senha: z.string().min(1).max(256), consentimento: z.literal(consentimentoCofre) }).strict();
const apagar = (req: Request) => { if (Buffer.isBuffer((req as any).rawBody)) (req as any).rawBody.fill(0); delete (req as any).rawBody; req.body = {}; };
const expirado = '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Link seguro Noto</title><p>Link expirado. Peça um novo link ao Noto.</p></html>';

export function criarRouterLinksCofre(links: LinksCofre | undefined, origem: string) {
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
            res.status(202).send('Conexão em andamento. O Noto confirmará no WhatsApp.');
        } catch (erro) {
            res.status(erro instanceof z.ZodError ? 400 : 503).send(erro instanceof z.ZodError ? 'Entrada inválida.' : 'Não consegui conectar. Peça um novo link ao Noto.');
        } finally { if (dados) { dados.email = ''; dados.senha = ''; } apagar(req); }
    });
    app.use((_req, res) => res.status(404).send('Página indisponível.'));
    app.use((_erro: unknown, req: Request, res: express.Response, _next: unknown) => { apagar(req); res.status(400).send('Entrada inválida.'); });
    return app;
}
