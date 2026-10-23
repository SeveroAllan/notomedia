import express from 'express';
import { guardaOrigem, pagina } from '../cofre/links-router.js';
import { ROTULOS, VALORES, type Permissoes } from './permissoes.js';

const expirado = pagina('Link seguro', `<h1>Link expirado</h1><p>Este link deixou de valer.<br>Peça um novo link ao Noto pelo WhatsApp.</p>`);
const recusado = pagina('Link seguro', `<h1>Não consegui abrir este link</h1><p>Volte para a conversa com o Noto no WhatsApp e abra o link mais recente que eu te enviei.</p>`);

/** Página de escolha das permissões (link com botões), uso único, mesmo padrão do link do cofre. */
export function criarRouterPermissoes(permissoes: Permissoes | undefined, origem: string, aoEscolher?: (r: { permissao: string; valor: string; medicoId: string; linkId: string }) => Promise<void>) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    app.use((req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
        if (!permissoes || !origem) { res.status(503).send('Estamos com uma instabilidade no sistema. Tente novamente em instantes.'); return; }
        guardaOrigem(origem, recusado)(req, res, next);
    });
    app.get('/:token', async (req, res) => {
        try {
            const link = await permissoes!.abrir(req.params.token);
            if (!link) { res.status(410).type('html').send(expirado); return; }
            const r = ROTULOS[link.permissao];
            const botoes = VALORES[link.permissao].map(v =>
                `<button class="btn-action" name="valor" value="${v}" style="margin-bottom:12px">${r.botoes[v]}</button>`).join('');
            res.type('html').send(pagina(r.titulo, `<h1>${r.titulo}</h1><p>${r.descricao}</p>
<form method="post" onsubmit="this.action=location.pathname+'/escolher'">${botoes}</form>
<p class="nota">A escolha fica salva e você pode mudar depois pela conversa.</p>`));
        } catch { res.status(503).send('Estamos com uma instabilidade no sistema. Tente novamente em instantes.'); }
    });
    app.use(express.urlencoded({ limit: '1kb', extended: false }));
    app.post('/:token/escolher', async (req, res) => {
        try {
            const valor = typeof req.body?.valor === 'string' ? req.body.valor : '';
            req.body = {};
            const r = await permissoes!.escolher(req.params.token as string, valor);
            if (!r.ok) { res.status(r.motivo === 'INVALIDO' ? 410 : 400).type('html').send(expirado); return; }
            const rotulo = ROTULOS[r.permissao];
            try { await aoEscolher?.({ permissao: r.permissao, valor: r.valor, medicoId: r.medicoId, linkId: r.linkId }); } catch { /* a gravação já aconteceu; o aviso é cortesia */ }
            res.status(202).type('html').send(pagina('Escolha salva', `<h1>Escolha salva</h1><p>${rotulo.titulo}: ${rotulo.botoes[r.valor]}.<br>Eu continuo com você pelo WhatsApp.</p><a class="btn-action" href="whatsapp://">Voltar para o WhatsApp</a><p class="nota">Você pode fechar esta página.</p>`));
        } catch { res.status(503).send('Estamos com uma instabilidade no sistema. Tente novamente em instantes.'); }
    });
    app.use((_req, res) => res.status(404).send('Página indisponível.'));
    return app;
}
