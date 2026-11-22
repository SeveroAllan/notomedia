/**
 * Orquestração de I/O das mensagens enviadas no WhatsApp logo após o usuário
 * concluir uma ação no cofre seguro. Toda a decisão do próximo passo vive na
 * regra pura `decidirTransicaoPosCofre`, isolada de banco e Evolution API.
 */

import type { MedicoCadastradoLink } from '../cofre/links-onboarding-service.js';
import {
  decidirTransicaoPosCofre,
  type DecisaoTransicaoPosCofre,
  type SnapshotPosCofre
} from './regras/decidir-transicao-pos-cofre.js';

export interface PortaEnvioOrquestracao {
  enviarTexto: (telefone: string, texto: string, opcoes?: { linkPreview?: boolean }) => Promise<boolean>;
  criarLinkProfissionais: (contaId: string, telefone: string) => Promise<{ ok: boolean; url?: string }>;
  criarLinkCertificado: (contaId: string, medicoId: string, telefone: string) => Promise<{ ok: boolean; url?: string; nomeProfissional?: string }>;
  criarLinkXml: (contaId: string, medicoId: string, telefone: string) => Promise<{ ok: boolean; url?: string; nomeProfissional?: string }>;
  listarProfissionaisCadastrados?: (contaId: string) => Promise<Array<{
    id: string;
    nome: string;
    certificadoValido: boolean;
    dadosFiscaisProntos: boolean;
  }>>;
  listarProfissionaisSemCertificado?: (contaId: string) => Promise<Array<{ id: string; nome: string }>>;
  obterNomeAgendaConectada?: (contaId: string) => Promise<string | null>;
  preferenciasJaConfiguradas?: (contaId: string) => Promise<boolean>;
  retomarCasosPendentes?: (contaId: string) => Promise<{
    retomados: number;
    enfileirados: number;
    pacientesEnfileirados: string[];
  }>;
}

async function carregarSnapshotPosCofre(
  porta: PortaEnvioOrquestracao,
  contaId: string
): Promise<SnapshotPosCofre> {
  const [profissionais, profissionaisSemCertificado, nomeAgendaConectada, preferenciasCompletas] =
    await Promise.all([
      porta.listarProfissionaisCadastrados?.(contaId).catch(() => []) ?? Promise.resolve([]),
      porta.listarProfissionaisSemCertificado?.(contaId).catch(() => []) ?? Promise.resolve([]),
      porta.obterNomeAgendaConectada?.(contaId).catch(() => null) ?? Promise.resolve(null),
      porta.preferenciasJaConfiguradas?.(contaId).catch(() => false) ?? Promise.resolve(false)
    ]);

  return {
    profissionais,
    profissionaisSemCertificado,
    nomeAgendaConectada,
    preferenciasCompletas
  };
}

async function avisarCasosRetomadosSeHouver(
  porta: PortaEnvioOrquestracao,
  contaId: string,
  telefone: string
): Promise<void> {
  if (!porta.retomarCasosPendentes) return;
  const retomada = await porta.retomarCasosPendentes(contaId).catch(() => null);
  if (!retomada || retomada.enfileirados <= 0) return;
  const nomes = retomada.pacientesEnfileirados.join(', ');
  const msg = retomada.enfileirados === 1
    ? `Aproveitei que tudo ficou pronto e já coloquei na fila a nota de ${nomes} que estava esperando.`
    : `Aproveitei que tudo ficou pronto e já coloquei na fila as notas que estavam esperando: ${nomes}.`;
  await porta.enviarTexto(telefone, msg);
}

async function executarAcaoLinkPosCofre(
  porta: PortaEnvioOrquestracao,
  contaId: string,
  telefone: string,
  acaoLink: DecisaoTransicaoPosCofre['acaoLink']
): Promise<void> {
  if (acaoLink.tipo === 'nenhum') return;

  if (acaoLink.tipo === 'link_profissionais') {
    const link = await porta.criarLinkProfissionais(contaId, telefone);
    if (!link.ok || !link.url) return;
    await porta.enviarTexto(telefone, acaoLink.mensagemAntes);
    await porta.enviarTexto(telefone, link.url, { linkPreview: false });
    return;
  }

  if (acaoLink.tipo === 'links_certificados') {
    for (const alvo of acaoLink.alvos) {
      const link = await porta.criarLinkCertificado(contaId, alvo.id, telefone);
      if (!link.ok || !link.url) continue;
      await porta.enviarTexto(telefone, `Certificado A1 — ${alvo.nome}:`);
      await porta.enviarTexto(telefone, link.url, { linkPreview: false });
    }
    return;
  }

  const linkXml = await porta.criarLinkXml(contaId, acaoLink.medicoId, telefone);
  if (!linkXml.ok || !linkXml.url) return;
  await porta.enviarTexto(telefone, acaoLink.mensagemAntes);
  await porta.enviarTexto(telefone, linkXml.url, { linkPreview: false });
}

async function executarDecisaoPosCofre(
  porta: PortaEnvioOrquestracao,
  contaId: string,
  telefone: string,
  decisao: DecisaoTransicaoPosCofre
): Promise<void> {
  for (const texto of decisao.mensagensIniciais) {
    await porta.enviarTexto(telefone, texto);
  }
  await executarAcaoLinkPosCofre(porta, contaId, telefone, decisao.acaoLink);
  for (const texto of decisao.mensagensPosLink) {
    await porta.enviarTexto(telefone, texto);
  }
  if (decisao.retomarCasosPendentes) {
    await avisarCasosRetomadosSeHouver(porta, contaId, telefone);
  }
}

export async function notificarAgendaConectadaEIniciarProfissionais(
  porta: PortaEnvioOrquestracao,
  evento: { contaId: string; nomeAgenda: string; conectado: boolean; telefone: string; motivoErro?: string }
): Promise<void> {
  if (!evento.telefone) return;
  const snapshot = await carregarSnapshotPosCofre(porta, evento.contaId);
  const decisao = decidirTransicaoPosCofre({
    tipo: 'agenda_concluida',
    nomeAgenda: evento.nomeAgenda,
    conectado: evento.conectado,
    motivoErro: evento.motivoErro
  }, snapshot);
  await executarDecisaoPosCofre(porta, evento.contaId, evento.telefone, decisao);
}

export async function notificarProfissionaisEEnviarLinksCertificados(
  porta: PortaEnvioOrquestracao,
  evento: { contaId: string; medicos: readonly MedicoCadastradoLink[]; telefone: string }
): Promise<void> {
  if (!evento.telefone || !evento.medicos.length) return;
  const snapshot = await carregarSnapshotPosCofre(porta, evento.contaId);
  const decisao = decidirTransicaoPosCofre({
    tipo: 'profissionais_cadastrados',
    medicos: evento.medicos
  }, snapshot);
  await executarDecisaoPosCofre(porta, evento.contaId, evento.telefone, decisao);
}

export async function notificarCertificadoSalvoEProximoPasso(
  porta: PortaEnvioOrquestracao,
  evento: {
    contaId: string;
    medicoId: string;
    nomeProfissional: string;
    telefone: string;
    fiscalImportado: boolean;
    resumoFiscal?: string;
  }
): Promise<void> {
  if (!evento.telefone) return;
  const snapshot = await carregarSnapshotPosCofre(porta, evento.contaId);
  const decisao = decidirTransicaoPosCofre({
    tipo: 'certificado_salvo',
    medicoId: evento.medicoId,
    nomeProfissional: evento.nomeProfissional,
    fiscalImportado: evento.fiscalImportado,
    resumoFiscal: evento.resumoFiscal
  }, snapshot);
  await executarDecisaoPosCofre(porta, evento.contaId, evento.telefone, decisao);
}

export async function notificarXmlSalvoEProximoPasso(
  porta: PortaEnvioOrquestracao,
  evento: { contaId: string; nomeProfissional: string; telefone: string }
): Promise<void> {
  if (!evento.telefone) return;
  const snapshot = await carregarSnapshotPosCofre(porta, evento.contaId);
  const decisao = decidirTransicaoPosCofre({
    tipo: 'xml_salvo',
    nomeProfissional: evento.nomeProfissional
  }, snapshot);
  await executarDecisaoPosCofre(porta, evento.contaId, evento.telefone, decisao);
}
