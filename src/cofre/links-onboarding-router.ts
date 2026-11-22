/**
 * Rotas Express dedicadas aos links de onboarding do cofre (`/c/profissionais/:token`,
 * `/c/certificado/:token` e `/c/xml/:token`). Separado de `links-router.ts` para
 * manter cada arquivo pequeno e aplicar limites de payload específicos (ex.: 4 MB
 * para `.pfx` em base64 e XML, mantendo 4 KB nas rotas de senha de agenda).
 */

import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { versaoConsentimentoFiscal } from '../onboarding/fluxos/consentimento-fiscal.js';
import type { LinksOnboardingService } from './links-onboarding-service.js';
import {
  envolverPaginaCofre,
  renderizarPaginaCadastroProfissionais,
  renderizarPaginaCertificadoProfissional,
  renderizarPaginaConcluida,
  renderizarPaginaXmlProfissional
} from './paginas-cofre-html.js';

const expiradoHtml = envolverPaginaCofre(
  'Link expirado',
  '<h1>Link expirado</h1><p>Este link deixou de valer.<br>Peça um novo link ao Noto pelo WhatsApp.</p>'
);

const certificadoSchema = z.object({
  arquivoBase64: z.string().min(32).max(4_000_000),
  senha: z.string().min(1).max(256),
  consentimentoFiscal: z.string().min(1).max(80)
}).strict();

const xmlSchema = z.object({
  xmlString: z.string().min(20).max(2_000_000)
}).strict();

function limparBody(req: Request): void {
  if (Buffer.isBuffer((req as any).rawBody)) (req as any).rawBody.fill(0);
  delete (req as any).rawBody;
  req.body = {};
}

export function criarRouterLinksOnboarding(
  servico: LinksOnboardingService,
  obterWhatsappAssistente?: () => Promise<string | null>
) {
  const router = express.Router();

  router.get('/profissionais/:token', async (req: Request, res: Response) => {
    try {
      const info = await servico.validarLinkCadastroProfissionais(String(req.params['token'] ?? ''));
      if (!info) { res.status(410).type('html').send(expiradoHtml); return; }
      res.type('html').send(renderizarPaginaCadastroProfissionais(info.existentes));
    } catch {
      res.status(503).send('Não foi possível abrir o formulário agora.');
    }
  });

  router.post(
    '/profissionais/:token/enviar',
    express.json({ limit: '32kb' }),
    express.urlencoded({ limit: '32kb', extended: true }),
    async (req: Request, res: Response) => {
      try {
        const resultado = await servico.consumirLinkCadastroProfissionais(String(req.params['token'] ?? ''), req.body);
        limparBody(req);
        if (!resultado.ok) {
          res.status(resultado.status).type('text/plain').send(resultado.detalhe);
          return;
        }
        const telefone = await obterWhatsappAssistente?.().catch(() => null);
        const nomes = resultado.medicos.map(m => m.nomeCompleto).join(', ');
        res.status(200).type('html').send(renderizarPaginaConcluida({
          titulo: 'Profissionais salvos',
          mensagem: `Cadastro salvo (${nomes}). Já enviei no seu WhatsApp o link individual do Certificado A1 para cada profissional.`,
          telefoneAssistente: telefone
        }));
      } catch {
        limparBody(req);
        res.status(503).type('text/plain').send('Não foi possível salvar agora. Tente novamente.');
      }
    }
  );

  router.get('/certificado/:token', async (req: Request, res: Response) => {
    try {
      const info = await servico.validarLinkCertificado(String(req.params['token'] ?? ''));
      if (!info) { res.status(410).type('html').send(expiradoHtml); return; }
      res.type('html').send(renderizarPaginaCertificadoProfissional({
        nomeProfissional: info.nomeProfissional,
        versaoConsentimento: versaoConsentimentoFiscal
      }));
    } catch {
      res.status(503).send('Não foi possível abrir a página do certificado agora.');
    }
  });

  router.post(
    '/certificado/:token/enviar',
    express.json({ limit: '5mb' }),
    async (req: Request, res: Response) => {
      let parsed: z.infer<typeof certificadoSchema> | undefined;
      try {
        parsed = certificadoSchema.parse(req.body);
        limparBody(req);
        const resultado = await servico.consumirLinkCertificado(String(req.params['token'] ?? ''), parsed);
        if (!resultado.ok) {
          res.status(resultado.status).type('text/plain').send(resultado.detalhe);
          return;
        }
        const telefone = await obterWhatsappAssistente?.().catch(() => null);
        res.status(200).type('html').send(renderizarPaginaConcluida({
          titulo: 'Certificado A1 salvo',
          mensagem: resultado.fiscalImportado
            ? 'Certificado validado e dados tributários extraídos automaticamente. Confira os detalhes no WhatsApp.'
            : 'Certificado validado com sucesso! Continue pelo WhatsApp para finalizar os dados tributários.',
          telefoneAssistente: telefone
        }));
      } catch (err) {
        if (err instanceof z.ZodError) {
          res.status(400).type('text/plain').send('Selecione o arquivo .pfx/.p12, informe a senha e marque a autorização.');
          return;
        }
        res.status(503).type('text/plain').send('Não foi possível processar o certificado agora.');
      } finally {
        if (parsed) { parsed.arquivoBase64 = ''; parsed.senha = ''; }
        limparBody(req);
      }
    }
  );

  router.get('/xml/:token', async (req: Request, res: Response) => {
    try {
      const info = await servico.validarLinkXml(String(req.params['token'] ?? ''));
      if (!info) { res.status(410).type('html').send(expiradoHtml); return; }
      res.type('html').send(renderizarPaginaXmlProfissional(info.nomeProfissional));
    } catch {
      res.status(503).send('Não foi possível abrir o envio de XML agora.');
    }
  });

  router.post(
    '/xml/:token/enviar',
    express.json({ limit: '3mb' }),
    async (req: Request, res: Response) => {
      try {
        const parsed = xmlSchema.parse(req.body);
        limparBody(req);
        const resultado = await servico.consumirLinkXml(String(req.params['token'] ?? ''), parsed.xmlString);
        if (!resultado.ok) {
          res.status(resultado.status).type('text/plain').send(resultado.detalhe);
          return;
        }
        const telefone = await obterWhatsappAssistente?.().catch(() => null);
        res.status(200).type('html').send(renderizarPaginaConcluida({
          titulo: 'XML importado',
          mensagem: 'Dados tributários extraídos do XML com sucesso. Continue pelo WhatsApp com o Noto.',
          telefoneAssistente: telefone
        }));
      } catch (err) {
        limparBody(req);
        if (err instanceof z.ZodError) {
          res.status(400).type('text/plain').send('Envie um arquivo XML de NFS-e válido.');
          return;
        }
        res.status(503).type('text/plain').send('Não foi possível importar o XML agora.');
      }
    }
  );

  return router;
}
