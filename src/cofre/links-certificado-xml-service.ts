/**
 * Links seguros de uso único vinculados a um profissional específico para envio
 * do Certificado Digital A1 (`/c/certificado/:token`) e do XML de referência
 * (`/c/xml/:token`). Separado de `links-onboarding-service.ts` para manter cada
 * arquivo focado em uma única responsabilidade e abaixo do teto de linhas.
 */

import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import {
  TIPO_LINK_CERTIFICADO,
  TIPO_LINK_XML,
  formatoTokenCofreValido,
  hashTokenCofre,
  type ResultadoProcessamentoCertificado,
  type ResultadoProcessamentoXml
} from './links-onboarding-helpers.js';

export interface LinksCertificadoXmlDeps {
  pool: pg.Pool;
  origem: string;
  enviarWhatsapp: (telefone: string, texto: string) => Promise<boolean>;
  processarCertificado?: (entrada: {
    contaId: string;
    medicoId: string;
    arquivoBase64: string;
    senha: string;
    consentimentoFiscal: string;
  }) => Promise<ResultadoProcessamentoCertificado>;
  processarXml?: (entrada: {
    contaId: string;
    medicoId: string;
    xmlString: string;
  }) => Promise<ResultadoProcessamentoXml>;
  aoSalvarCertificado?: (evento: {
    contaId: string;
    medicoId: string;
    nomeProfissional: string;
    telefone: string;
    fiscalImportado: boolean;
    resumoFiscal?: string;
  }) => Promise<void>;
  aoSalvarXml?: (evento: {
    contaId: string;
    medicoId: string;
    nomeProfissional: string;
    telefone: string;
    resumoFiscal?: string;
  }) => Promise<void>;
}

export class LinksCertificadoXmlService {
  constructor(private deps: LinksCertificadoXmlDeps) {}

  private async criarLinkParaMedico(entrada: {
    contaId: string;
    medicoId: string;
    telefone: string;
    tipo: typeof TIPO_LINK_CERTIFICADO | typeof TIPO_LINK_XML;
    caminho: 'certificado' | 'xml';
    enviarMensagem?: boolean;
  }): Promise<{ ok: boolean; url?: string; nomeProfissional?: string; motivo?: string }> {
    const { rows } = await this.deps.pool.query(
      `select id, nome_completo from public.medicos where id = $1 and conta_id = $2 limit 1`,
      [entrada.medicoId, entrada.contaId]
    );
    const medico = rows[0];
    if (!medico) return { ok: false, motivo: 'MEDICO_NAO_ENCONTRADO' };

    const token = randomBytes(32).toString('base64url');
    await this.deps.pool.query(
      `update public.cofre_links set expira_em = least(expira_em, now())
       where medico_id = $1 and agenda = $2 and usado_em is null and expira_em > now()`,
      [entrada.medicoId, entrada.tipo]
    );
    await this.deps.pool.query(
      `insert into public.cofre_links (conta_id, medico_id, agenda, token_hash, expira_em, criado_em, destino_telefone)
       values (null, $1, $2, $3, now() + interval '60 minutes', now(), $4)`,
      [entrada.medicoId, entrada.tipo, hashTokenCofre(token), entrada.telefone]
    );
    const url = `${this.deps.origem}/c/${entrada.caminho}/${token}`;
    const nomeProfissional = String(medico.nome_completo ?? 'Profissional').trim();
    if (entrada.enviarMensagem !== false) {
      const ok = await this.deps.enviarWhatsapp(entrada.telefone, url);
      if (!ok) return { ok: false, motivo: 'ENVIO_FALHOU' };
    }
    return { ok: true, url, nomeProfissional };
  }

  private async buscarLinkMedico(token: string, tipo: string) {
    if (!formatoTokenCofreValido(token)) return null;
    const { rows } = await this.deps.pool.query(
      `select l.id, l.destino_telefone, m.id as medico_id, m.conta_id, m.nome_completo
       from public.cofre_links l
       join public.medicos m on m.id = l.medico_id
       where l.token_hash = $1 and l.agenda = $2 and l.usado_em is null and l.expira_em > now()
       limit 1`,
      [hashTokenCofre(token), tipo]
    );
    return rows[0] ?? null;
  }

  criarLinkCertificadoProfissional(entrada: {
    contaId: string;
    medicoId: string;
    telefone: string;
    enviarMensagem?: boolean;
  }) {
    return this.criarLinkParaMedico({ ...entrada, tipo: TIPO_LINK_CERTIFICADO, caminho: 'certificado' });
  }

  async validarLinkCertificado(token: string): Promise<{ medicoId: string; contaId: string; nomeProfissional: string } | null> {
    const linha = await this.buscarLinkMedico(token, TIPO_LINK_CERTIFICADO);
    if (!linha?.medico_id) return null;
    return {
      medicoId: String(linha.medico_id),
      contaId: String(linha.conta_id),
      nomeProfissional: String(linha.nome_completo ?? 'Profissional').trim()
    };
  }

  async consumirLinkCertificado(
    token: string,
    dados: { arquivoBase64: string; senha: string; consentimentoFiscal: string }
  ): Promise<{ ok: true; fiscalImportado: boolean } | { ok: false; status: number; detalhe: string }> {
    if (!this.deps.processarCertificado) return { ok: false, status: 503, detalhe: 'Serviço de certificado indisponível.' };
    const link = await this.buscarLinkMedico(token, TIPO_LINK_CERTIFICADO);
    if (!link) return { ok: false, status: 410, detalhe: 'Link expirado ou já utilizado.' };

    const res = await this.deps.processarCertificado({
      contaId: String(link.conta_id),
      medicoId: String(link.medico_id),
      arquivoBase64: dados.arquivoBase64,
      senha: dados.senha,
      consentimentoFiscal: dados.consentimentoFiscal
    });
    if (!res.ok) return { ok: false, status: 400, detalhe: res.detalheErro || 'Certificado A1 ou senha inválidos.' };

    await this.deps.pool.query(
      `update public.cofre_links set usado_em = now() where id = $1 and usado_em is null`,
      [link.id]
    );
    const telefone = String(link.destino_telefone ?? '');
    if (telefone && this.deps.aoSalvarCertificado) {
      await this.deps.aoSalvarCertificado({
        contaId: String(link.conta_id),
        medicoId: String(link.medico_id),
        nomeProfissional: String(link.nome_completo ?? 'Profissional').trim(),
        telefone,
        fiscalImportado: Boolean(res.fiscalImportado),
        resumoFiscal: res.resumoFiscal
      }).catch(() => {});
    }
    return { ok: true, fiscalImportado: Boolean(res.fiscalImportado) };
  }

  criarLinkXmlProfissional(entrada: {
    contaId: string;
    medicoId: string;
    telefone: string;
    enviarMensagem?: boolean;
  }) {
    return this.criarLinkParaMedico({ ...entrada, tipo: TIPO_LINK_XML, caminho: 'xml' });
  }

  async validarLinkXml(token: string): Promise<{ medicoId: string; nomeProfissional: string } | null> {
    const linha = await this.buscarLinkMedico(token, TIPO_LINK_XML);
    if (!linha?.medico_id) return null;
    return { medicoId: String(linha.medico_id), nomeProfissional: String(linha.nome_completo ?? 'Profissional').trim() };
  }

  async consumirLinkXml(
    token: string,
    xmlString: string
  ): Promise<{ ok: true } | { ok: false; status: number; detalhe: string }> {
    if (!this.deps.processarXml) return { ok: false, status: 503, detalhe: 'Serviço de XML indisponível.' };
    const link = await this.buscarLinkMedico(token, TIPO_LINK_XML);
    if (!link) return { ok: false, status: 410, detalhe: 'Link expirado ou já utilizado.' };

    const res = await this.deps.processarXml({
      contaId: String(link.conta_id),
      medicoId: String(link.medico_id),
      xmlString
    });
    if (!res.ok) return { ok: false, status: 400, detalhe: res.detalheErro || 'XML inválido.' };

    await this.deps.pool.query(
      `update public.cofre_links set usado_em = now() where id = $1 and usado_em is null`,
      [link.id]
    );
    const telefone = String(link.destino_telefone ?? '');
    if (telefone && this.deps.aoSalvarXml) {
      await this.deps.aoSalvarXml({
        contaId: String(link.conta_id),
        medicoId: String(link.medico_id),
        nomeProfissional: String(link.nome_completo ?? 'Profissional').trim(),
        telefone,
        resumoFiscal: res.resumoFiscal
      }).catch(() => {});
    }
    return { ok: true };
  }
}
