/**
 * Regra pura de máquina de estados para decidir o próximo passo após qualquer
 * ação concluída no Cofre (agenda, cadastro de profissionais, Certificado A1 ou XML).
 * Isolada de I/O (banco e Evolution API) para garantir que qualquer ordem de
 * preenchimento pelo usuário nunca repita etapas já salvas na conta.
 */

import type { MedicoCadastradoLink } from '../../cofre/links-onboarding-service.js';

export interface SnapshotPosCofre {
  profissionais: ReadonlyArray<{
    id: string;
    nome: string;
    certificadoValido: boolean;
    dadosFiscaisProntos: boolean;
  }>;
  profissionaisSemCertificado: ReadonlyArray<{ id: string; nome: string }>;
  nomeAgendaConectada: string | null;
  preferenciasCompletas: boolean;
}

export type AcaoLinkPosCofre =
  | { tipo: 'nenhum' }
  | { tipo: 'link_profissionais'; mensagemAntes: string }
  | { tipo: 'links_certificados'; alvos: ReadonlyArray<{ id: string; nome: string }> }
  | { tipo: 'link_xml'; medicoId: string; nomeProfissional: string; mensagemAntes: string };

export interface DecisaoTransicaoPosCofre {
  mensagensIniciais: string[];
  acaoLink: AcaoLinkPosCofre;
  mensagensPosLink: string[];
  retomarCasosPendentes: boolean;
}

export type EventoPosCofre =
  | {
      tipo: 'agenda_concluida';
      nomeAgenda: string;
      conectado: boolean;
      motivoErro?: string;
    }
  | {
      tipo: 'profissionais_cadastrados';
      medicos: readonly MedicoCadastradoLink[];
    }
  | {
      tipo: 'certificado_salvo';
      medicoId: string;
      nomeProfissional: string;
      fiscalImportado: boolean;
      resumoFiscal?: string;
    }
  | {
      tipo: 'xml_salvo';
      nomeProfissional: string;
    };

function explicarFalhaLoginAgenda(nomeAgenda: string, motivoErro?: string): string {
  if (motivoErro === 'ACESSO_CAPTCHA') {
    return `A agenda ${nomeAgenda} pediu verificação anti-robô. Acesse pelo seu navegador, conclua a etapa e me peça um novo link.`;
  }
  if (motivoErro === 'ACESSO_PRECISA_VERIFICACAO') {
    return `A agenda ${nomeAgenda} pediu verificação em duas etapas (2FA). Me avise aqui para refazermos a conexão.`;
  }
  return `Não consegui validar o login na agenda ${nomeAgenda}. Confira e-mail/senha e me peça um novo link seguro.`;
}

function decidirAposFiscalPronto(
  mensagensBase: string[],
  snapshot: SnapshotPosCofre
): DecisaoTransicaoPosCofre {
  const { nomeAgendaConectada, preferenciasCompletas } = snapshot;

  if (preferenciasCompletas) {
    return {
      mensagensIniciais: [
        ...mensagensBase,
        'Por aqui tá tudo certo! Já peguei seus dados fiscais das últimas notas e vou usar esses mesmos parâmetros nas próximas.',
        nomeAgendaConectada
          ? `Também já tô com o acesso da tua agenda ${nomeAgendaConectada} e com as preferências que combinamos.`
          : 'As preferências de emissão já estão salvas — agora só falta conectarmos a tua agenda para fechar tudo.'
      ],
      acaoLink: { tipo: 'nenhum' },
      mensagensPosLink: [],
      retomarCasosPendentes: true
    };
  }

  return {
    mensagensIniciais: [
      ...mensagensBase,
      'Por aqui tá tudo certo! Já peguei todos os teus dados fiscais das últimas notas e vou usar esses mesmos dados nas próximas.',
      nomeAgendaConectada
        ? `Também já tô com o acesso da tua agenda ${nomeAgendaConectada}, então agora só preciso entender como você prefere trabalhar com as emissões no dia a dia.`
        : 'Depois ainda falta conectarmos a tua agenda, mas já me diz como você prefere trabalhar com as emissões no dia a dia.',
      'Hoje você costuma emitir a nota só quando o paciente faz o pagamento e manda o comprovante, ou já emite logo depois da consulta?'
    ],
    acaoLink: { tipo: 'nenhum' },
    mensagensPosLink: [],
    retomarCasosPendentes: true
  };
}

function decidirAgendaConcluida(
  evento: Extract<EventoPosCofre, { tipo: 'agenda_concluida' }>,
  snapshot: SnapshotPosCofre
): DecisaoTransicaoPosCofre {
  if (!evento.conectado) {
    return {
      mensagensIniciais: [explicarFalhaLoginAgenda(evento.nomeAgenda, evento.motivoErro)],
      acaoLink: { tipo: 'nenhum' },
      mensagensPosLink: [],
      retomarCasosPendentes: false
    };
  }

  if (snapshot.profissionais.length === 0) {
    return {
      mensagensIniciais: [`Conexão com a agenda ${evento.nomeAgenda} confirmada!`],
      acaoLink: {
        tipo: 'link_profissionais',
        mensagemAntes: 'Agora informe o nome completo, CRM e RQE dos profissionais que vão emitir notas (você pode adicionar mais de um):'
      },
      mensagensPosLink: [],
      retomarCasosPendentes: false
    };
  }

  if (snapshot.profissionaisSemCertificado.length > 0) {
    const nomes = snapshot.profissionais.map(p => p.nome).join(', ');
    return {
      mensagensIniciais: [
        `Conexão com a agenda ${evento.nomeAgenda} confirmada! Como já tenho o cadastro de ${nomes}, agora falta só o Certificado A1:`
      ],
      acaoLink: { tipo: 'links_certificados', alvos: snapshot.profissionaisSemCertificado },
      mensagensPosLink: [],
      retomarCasosPendentes: false
    };
  }

  if (snapshot.preferenciasCompletas) {
    return {
      mensagensIniciais: [
        `Conexão com a agenda ${evento.nomeAgenda} confirmada! Como o cadastro, certificado e preferências já estavam salvos, ficou tudo 100% pronto por aqui.`
      ],
      acaoLink: { tipo: 'nenhum' },
      mensagensPosLink: [],
      retomarCasosPendentes: true
    };
  }

  return {
    mensagensIniciais: [
      `Conexão com a agenda ${evento.nomeAgenda} confirmada! Como o cadastro e o certificado já estão salvos, só falta alinharmos como você prefere trabalhar com as emissões no dia a dia.`,
      'Hoje você costuma emitir a nota só quando o paciente faz o pagamento e manda o comprovante, ou já emite logo depois da consulta?'
    ],
    acaoLink: { tipo: 'nenhum' },
    mensagensPosLink: [],
    retomarCasosPendentes: true
  };
}

export function decidirTransicaoPosCofre(
  evento: EventoPosCofre,
  snapshot: SnapshotPosCofre
): DecisaoTransicaoPosCofre {
  if (evento.tipo === 'agenda_concluida') {
    return decidirAgendaConcluida(evento, snapshot);
  }

  if (evento.tipo === 'profissionais_cadastrados') {
    const nomes = evento.medicos.map(m => m.nomeCompleto).join(', ');
    const idsJaComCert = new Set(
      snapshot.profissionais.filter(p => p.certificadoValido).map(p => p.id)
    );
    const alvos = evento.medicos
      .filter(m => !idsJaComCert.has(m.id))
      .map(m => ({ id: m.id, nome: m.nomeCompleto }));

    if (alvos.length === 0) {
      return decidirAposFiscalPronto([`Recebi o cadastro de: ${nomes}.`], snapshot);
    }

    return {
      mensagensIniciais: [
        `Recebi o cadastro de: ${nomes}.`,
        alvos.length === 1
          ? 'Agora vou te enviar o link seguro para salvar o Certificado A1:'
          : 'Agora vou te enviar o link seguro do Certificado A1 referente a cada profissional:'
      ],
      acaoLink: { tipo: 'links_certificados', alvos },
      mensagensPosLink: [],
      retomarCasosPendentes: false
    };
  }

  if (evento.tipo === 'certificado_salvo') {
    const pendentes = snapshot.profissionaisSemCertificado;
    const msgPendentes = pendentes.length > 0
      ? [`Ainda falta salvar o Certificado A1 de: ${pendentes.map(p => p.nome).join(', ')}.`]
      : [];

    if (!evento.fiscalImportado) {
      return {
        mensagensIniciais: [
          `Certificado A1 de ${evento.nomeProfissional} salvo! Não encontrei uma NFS-e recente no Ambiente Nacional.`
        ],
        acaoLink: {
          tipo: 'link_xml',
          medicoId: evento.medicoId,
          nomeProfissional: evento.nomeProfissional,
          mensagemAntes: `Envie o XML de uma nota anterior de ${evento.nomeProfissional} por este link seguro:`
        },
        mensagensPosLink: msgPendentes,
        retomarCasosPendentes: false
      };
    }

    const detalhe = evento.resumoFiscal ? ` (${evento.resumoFiscal})` : '';
    const msgSalvo = `Certificado A1 de ${evento.nomeProfissional} salvo! Já puxei os dados tributários automaticamente${detalhe}.`;
    if (pendentes.length > 0) {
      return {
        mensagensIniciais: [msgSalvo, ...msgPendentes],
        acaoLink: { tipo: 'nenhum' },
        mensagensPosLink: [],
        retomarCasosPendentes: false
      };
    }
    return decidirAposFiscalPronto([msgSalvo], snapshot);
  }

  const msgXml = `Recebi o XML de referência de ${evento.nomeProfissional} e já salvei os dados tributários!`;
  if (snapshot.profissionaisSemCertificado.length > 0) {
    const lista = snapshot.profissionaisSemCertificado.map(p => p.nome).join(', ');
    return {
      mensagensIniciais: [msgXml, `Ainda falta salvar o Certificado A1 de: ${lista}.`],
      acaoLink: { tipo: 'nenhum' },
      mensagensPosLink: [],
      retomarCasosPendentes: false
    };
  }
  return decidirAposFiscalPronto([msgXml], snapshot);
}
