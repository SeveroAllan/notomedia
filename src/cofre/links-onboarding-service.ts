/**
 * Serviço de links seguros de uso único por conta para agendas adaptativas ou
 * descobertas online (`/c/:token`) e cadastro de múltiplos profissionais
 * (`/c/profissionais/:token`). Delega os links individuais de certificado A1 e
 * XML para `LinksCertificadoXmlService`.
 */

import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import {
  AGENDAS_SUPORTADAS,
  agendaSuportada,
  validarUrlPortalAgenda,
  type AgendaSuportada
} from '../agenda/agendas-suportadas.js';
import { normalizarNomeMedico } from '../conta/medicos-conta.js';
import { cofreIdDaConta } from './identidade-conta.js';
import type { CofreAgendaGenerico } from './generico-cofre.js';
import {
  validarProfissionaisFormularioCofre,
  type ProfissionalFormularioCofre
} from './validar-profissionais-cofre.js';
import {
  TIPO_LINK_CERTIFICADO,
  TIPO_LINK_PROFISSIONAIS,
  TIPO_LINK_XML,
  formatoTokenCofreValido,
  hashTokenCofre,
  operadorAutorizadoNaConta,
  type MedicoCadastradoLink,
  type ResultadoProcessamentoCertificado,
  type ResultadoProcessamentoXml
} from './links-onboarding-helpers.js';
import {
  LinksCertificadoXmlService,
  type LinksCertificadoXmlDeps
} from './links-certificado-xml-service.js';

export {
  TIPO_LINK_CERTIFICADO,
  TIPO_LINK_PROFISSIONAIS,
  TIPO_LINK_XML,
  type MedicoCadastradoLink,
  type ResultadoProcessamentoCertificado,
  type ResultadoProcessamentoXml
};

export interface LinksOnboardingDeps extends LinksCertificadoXmlDeps {
  cofreGenerico?: Pick<CofreAgendaGenerico, 'status' | 'iniciar'>;
  aoCadastrarProfissionais?: (evento: {
    contaId: string;
    medicos: MedicoCadastradoLink[];
    telefone: string;
  }) => Promise<void>;
}

export class LinksOnboardingService {
  private certXml: LinksCertificadoXmlService;

  constructor(private deps: LinksOnboardingDeps) {
    this.certXml = new LinksCertificadoXmlService(deps);
  }

  async criarLinkAgendaAdaptativa(entrada: {
    contaId: string;
    provedor: AgendaSuportada;
    nomeAgenda?: string;
    urlPortal?: string | null;
    telefone: string;
    enviarMensagem?: boolean;
  }): Promise<{ ok: boolean; url?: string; motivo?: string }> {
    if (!this.deps.cofreGenerico) return { ok: false, motivo: 'COFRE_INDISPONIVEL' };
    if (!(await operadorAutorizadoNaConta(this.deps.pool, entrada.contaId, entrada.telefone))) {
      return { ok: false, motivo: 'OPERADOR_NAO_AUTORIZADO' };
    }
    const urlCheck = validarUrlPortalAgenda(entrada.provedor, entrada.urlPortal);
    if (!urlCheck.ok) return { ok: false, motivo: 'URL_PORTAL_INVALIDA' };

    const cfg = AGENDAS_SUPORTADAS[entrada.provedor];
    const nomeAgenda = entrada.nomeAgenda?.trim() || cfg.nome;
    const urlFinal = urlCheck.urlNormalizada || cfg.urlLoginPadrao;
    const token = randomBytes(32).toString('base64url');

    await this.deps.pool.query(
      `update public.cofre_links set expira_em = least(expira_em, now())
       where conta_id = $1 and agenda = $2 and usado_em is null and expira_em > now()`,
      [entrada.contaId, entrada.provedor]
    );
    await this.deps.pool.query(
      `insert into public.cofre_links (conta_id, medico_id, agenda, token_hash, expira_em, criado_em, destino_telefone, metadados)
       values ($1, null, $2, $3, now() + interval '15 minutes', now(), $4, $5::jsonb)`,
      [entrada.contaId, entrada.provedor, hashTokenCofre(token), entrada.telefone, JSON.stringify({ nomeAgenda, urlPortal: urlFinal })]
    );

    const url = `${this.deps.origem}/c/${token}`;
    if (entrada.enviarMensagem !== false && !(await this.deps.enviarWhatsapp(entrada.telefone, url))) {
      return { ok: false, motivo: 'ENVIO_FALHOU' };
    }
    return { ok: true, url };
  }

  async validarLinkAgendaAdaptativa(token: string): Promise<{
    provedor: AgendaSuportada;
    nomeAgenda: string;
    urlPortal: string;
    hostPortal: string | null;
    consentimento: string;
  } | null> {
    if (!formatoTokenCofreValido(token)) return null;
    const { rows } = await this.deps.pool.query(
      `select agenda, metadados from public.cofre_links
       where token_hash = $1 and usado_em is null and expira_em > now()
         and agenda not in ('tribemd', 'amplimed', 'registro_profissional', $2, $3, $4)
       limit 1`,
      [hashTokenCofre(token), TIPO_LINK_PROFISSIONAIS, TIPO_LINK_CERTIFICADO, TIPO_LINK_XML]
    );
    const linha = rows[0];
    const prov = agendaSuportada(linha?.agenda);
    if (!prov) return null;
    const cfg = AGENDAS_SUPORTADAS[prov];
    const meta = (linha.metadados && typeof linha.metadados === 'object' ? linha.metadados : {}) as Record<string, unknown>;
    const urlPortal = typeof meta['urlPortal'] === 'string' && meta['urlPortal'] ? meta['urlPortal'] : cfg.urlLoginPadrao;
    const nomeAgenda = typeof meta['nomeAgenda'] === 'string' && meta['nomeAgenda'] ? meta['nomeAgenda'] : cfg.nome;
    let hostPortal: string | null = null;
    try { hostPortal = new URL(urlPortal).hostname; } catch { hostPortal = null; }
    return { provedor: prov, nomeAgenda, urlPortal, hostPortal, consentimento: cfg.consentimento };
  }

  async consumirLinkAgendaAdaptativa(
    token: string,
    dados: { email: string; senha: string; consentimento: string }
  ): Promise<boolean> {
    if (!formatoTokenCofreValido(token) || !this.deps.cofreGenerico) return false;
    const { rows } = await this.deps.pool.query(
      `update public.cofre_links set usado_em = now()
       where token_hash = $1 and usado_em is null and expira_em > now()
         and agenda not in ('tribemd', 'amplimed', 'registro_profissional', $2, $3, $4)
       returning conta_id, medico_id, agenda, metadados`,
      [hashTokenCofre(token), TIPO_LINK_PROFISSIONAIS, TIPO_LINK_CERTIFICADO, TIPO_LINK_XML]
    );
    const link = rows[0];
    const prov = agendaSuportada(link?.agenda);
    if (!link || !prov) return false;
    const cfg = AGENDAS_SUPORTADAS[prov];
    if (dados.consentimento !== cfg.consentimento) return false;
    const chaveCofre = link.conta_id ? cofreIdDaConta(link.conta_id) : link.medico_id;
    if (!chaveCofre) return false;
    const meta = (link.metadados && typeof link.metadados === 'object' ? link.metadados : {}) as Record<string, unknown>;

    await this.deps.cofreGenerico.iniciar(chaveCofre, {
      email: dados.email,
      senha: dados.senha,
      provedor: prov,
      nomeAgenda: typeof meta['nomeAgenda'] === 'string' && meta['nomeAgenda'] ? meta['nomeAgenda'] : cfg.nome,
      urlPortal: typeof meta['urlPortal'] === 'string' && meta['urlPortal'] ? meta['urlPortal'] : cfg.urlLoginPadrao
    });
    return true;
  }

  async criarLinkCadastroProfissionais(entrada: {
    contaId: string;
    telefone: string;
    enviarMensagem?: boolean;
  }): Promise<{ ok: boolean; url?: string; motivo?: string }> {
    if (!(await operadorAutorizadoNaConta(this.deps.pool, entrada.contaId, entrada.telefone))) {
      return { ok: false, motivo: 'OPERADOR_NAO_AUTORIZADO' };
    }
    const token = randomBytes(32).toString('base64url');
    await this.deps.pool.query(
      `update public.cofre_links set expira_em = least(expira_em, now())
       where conta_id = $1 and agenda = $2 and usado_em is null and expira_em > now()`,
      [entrada.contaId, TIPO_LINK_PROFISSIONAIS]
    );
    await this.deps.pool.query(
      `insert into public.cofre_links (conta_id, medico_id, agenda, token_hash, expira_em, criado_em, destino_telefone)
       values ($1, null, $2, $3, now() + interval '30 minutes', now(), $4)`,
      [entrada.contaId, TIPO_LINK_PROFISSIONAIS, hashTokenCofre(token), entrada.telefone]
    );
    const url = `${this.deps.origem}/c/profissionais/${token}`;
    if (entrada.enviarMensagem !== false && !(await this.deps.enviarWhatsapp(entrada.telefone, url))) {
      return { ok: false, motivo: 'ENVIO_FALHOU' };
    }
    return { ok: true, url };
  }

  async validarLinkCadastroProfissionais(token: string): Promise<{ contaId: string; existentes: string[] } | null> {
    if (!formatoTokenCofreValido(token)) return null;
    const { rows } = await this.deps.pool.query(
      `select conta_id from public.cofre_links
       where token_hash = $1 and agenda = $2 and usado_em is null and expira_em > now() limit 1`,
      [hashTokenCofre(token), TIPO_LINK_PROFISSIONAIS]
    );
    const contaId = rows[0]?.conta_id as string | undefined;
    if (!contaId) return null;
    const meds = await this.deps.pool.query(
      `select nome_completo from public.medicos where conta_id = $1 order by criado_em, id`,
      [contaId]
    );
    const existentes = meds.rows
      .map(r => String(r.nome_completo ?? '').trim())
      .filter(n => n && !/^m[eé]dic[oa]\s+\d+$/i.test(n));
    return { contaId, existentes };
  }

  async consumirLinkCadastroProfissionais(
    token: string,
    corpoBruto: unknown
  ): Promise<{ ok: true; medicos: MedicoCadastradoLink[] } | { ok: false; status: number; detalhe: string }> {
    if (!formatoTokenCofreValido(token)) return { ok: false, status: 410, detalhe: 'Link expirado ou inválido.' };
    const validacao = validarProfissionaisFormularioCofre(corpoBruto);
    if (!validacao.ok) return { ok: false, status: 400, detalhe: validacao.detalhe };

    const client = await this.deps.pool.connect();
    let contaId = '';
    let telefone = '';
    const salvos: MedicoCadastradoLink[] = [];
    let commitOk = false;

    try {
      await client.query('begin');
      const linkRes = await client.query(
        `update public.cofre_links set usado_em = now()
         where token_hash = $1 and agenda = $2 and usado_em is null and expira_em > now()
         returning conta_id, destino_telefone`,
        [hashTokenCofre(token), TIPO_LINK_PROFISSIONAIS]
      );
      const link = linkRes.rows[0];
      if (!link?.conta_id) return { ok: false, status: 410, detalhe: 'Link expirado ou já utilizado.' };
      contaId = link.conta_id;
      telefone = String(link.destino_telefone ?? '');

      const existentes = (await client.query(
        `select id, nome_completo from public.medicos where conta_id = $1 order by criado_em, id`,
        [contaId]
      )).rows as Array<{ id: string; nome_completo: string | null }>;

      let placeholder = existentes.find(m => /^m[eé]dic[oa]\s+\d+$/i.test(String(m.nome_completo ?? '').trim()));
      for (const prof of validacao.profissionais) {
        const salvo = await this.gravarProfissionalNaTransacao(client, contaId, existentes, placeholder, prof);
        if (placeholder && salvo.id === placeholder.id) placeholder = undefined;
        salvos.push(salvo);
      }
      await client.query('commit');
      commitOk = true;
    } finally {
      if (!commitOk) await client.query('rollback').catch(() => undefined);
      client.release();
    }

    if (telefone && salvos.length && this.deps.aoCadastrarProfissionais) {
      await this.deps.aoCadastrarProfissionais({ contaId, medicos: salvos, telefone }).catch(() => {});
    }
    return { ok: true, medicos: salvos };
  }

  private async gravarProfissionalNaTransacao(
    client: pg.PoolClient,
    contaId: string,
    existentes: Array<{ id: string; nome_completo: string | null }>,
    placeholder: { id: string; nome_completo: string | null } | undefined,
    prof: ProfissionalFormularioCofre
  ): Promise<MedicoCadastradoLink> {
    const chave = normalizarNomeMedico(prof.nomeCompleto);
    const existente = existentes.find(m => normalizarNomeMedico(String(m.nome_completo ?? '')) === chave) ?? placeholder;
    if (existente) {
      await client.query(
        `update public.medicos set nome_completo = $2, crm = $3, rqe = $4, atualizado_em = now() where id = $1`,
        [existente.id, prof.nomeCompleto, prof.crm, prof.rqe]
      );
      existente.nome_completo = prof.nomeCompleto;
      return { id: existente.id, nomeCompleto: prof.nomeCompleto, crm: prof.crm, rqe: prof.rqe };
    }
    const inserido = await client.query(
      `insert into public.medicos (usuario_id, conta_id, nome_completo, crm, rqe)
       values (null, $1, $2, $3, $4) returning id`,
      [contaId, prof.nomeCompleto, prof.crm, prof.rqe]
    );
    const novoId = String(inserido.rows[0].id);
    existentes.push({ id: novoId, nome_completo: prof.nomeCompleto });
    return { id: novoId, nomeCompleto: prof.nomeCompleto, crm: prof.crm, rqe: prof.rqe };
  }

  criarLinkCertificadoProfissional = (entrada: Parameters<LinksCertificadoXmlService['criarLinkCertificadoProfissional']>[0]) =>
    this.certXml.criarLinkCertificadoProfissional(entrada);
  validarLinkCertificado = (token: string) => this.certXml.validarLinkCertificado(token);
  consumirLinkCertificado = (token: string, dados: Parameters<LinksCertificadoXmlService['consumirLinkCertificado']>[1]) =>
    this.certXml.consumirLinkCertificado(token, dados);
  criarLinkXmlProfissional = (entrada: Parameters<LinksCertificadoXmlService['criarLinkXmlProfissional']>[0]) =>
    this.certXml.criarLinkXmlProfissional(entrada);
  validarLinkXml = (token: string) => this.certXml.validarLinkXml(token);
  consumirLinkXml = (token: string, xmlString: string) => this.certXml.consumirLinkXml(token, xmlString);
}
