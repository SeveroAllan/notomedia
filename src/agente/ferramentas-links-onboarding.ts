/**
 * Ferramentas autônomas do agente para diagnóstico da conta e envio dos links
 * seguros do Cofre (agenda, cadastro multi-profissional, Certificado A1/XML e
 * reconsulta ADN). Separado das ferramentas de rotina/memória e emissão para
 * manter cada módulo com uma única responsabilidade (< 300 linhas).
 */

import { tool } from '@openai/agents';
import { z } from 'zod';
import {
  AGENDAS_SUPORTADAS,
  validarUrlPortalAgenda,
  type AgendaSuportada
} from '../agenda/agendas-suportadas.js';
import { identificarAgendaPreDefinida } from '../agenda/escolher-url-login-agenda.js';
import type { ResultadoDescobertaAgendaOnline } from '../agenda/descobrir-url-agenda-online.js';
import { normalizarNomeMedico } from '../conta/medicos-conta.js';
import type { EstadoProntidaoConta } from './estado-prontidao-conta.js';
import type { CodigoFerramenta, FerramentaNoto } from './diagnostico.js';

export interface DependenciasLinksOnboarding {
  consultarEstadoConta?: () => Promise<EstadoProntidaoConta>;
  descobrirUrlAgendaOnline?: (nomeAgenda: string) => Promise<ResultadoDescobertaAgendaOnline>;
  enviarLinkAgendaQualquer?: (entrada: {
    provedor: AgendaSuportada;
    nomeAgenda: string;
    urlPortal: string | null;
  }) => Promise<{ ok: boolean; url?: string; motivo?: string }>;
  enviarLinkCadastroProfissionais?: () => Promise<{ ok: boolean; url?: string; motivo?: string }>;
  enviarLinkCertificadoIndividual?: (medicoId: string) => Promise<{ ok: boolean; url?: string; nomeProfissional?: string; motivo?: string }>;
  enviarLinkXmlIndividual?: (medicoId: string) => Promise<{ ok: boolean; url?: string; nomeProfissional?: string; motivo?: string }>;
  reconsultarDadosFiscaisCertificado?: (medicoId: string) => Promise<{
    ok: boolean;
    fiscalImportado: boolean;
    emAndamento?: boolean;
    resumoFiscal?: string;
    notasEncontradas?: number;
    dataUltimaNota?: string | null;
    motivo?: string;
  }>;
}

export function criarFerramentasLinksOnboarding(
  deps: DependenciasLinksOnboarding,
  registrar: (nome: FerramentaNoto, codigo: CodigoFerramenta, inicio: number) => void
): ReturnType<typeof tool>[] {
  const ferramentas: ReturnType<typeof tool>[] = [];

  if (deps.consultarEstadoConta) {
    ferramentas.push(tool({
      name: 'consultar_estado_onboarding_conta',
      description: 'Consulta interna do estado real da conta (agenda, profissionais, certificado, fiscal e preferências). Use em silêncio só para decidir o próximo passo — NUNCA recite esse relatório de volta ao médico nem repita pendências que ele já sabe.',
      parameters: z.object({}),
      async execute() {
        const inicio = Date.now();
        try {
          const estado = await deps.consultarEstadoConta!();
          registrar('consultar_estado_onboarding_conta', 'ONBOARDING_CONSULTADO', inicio);
          registrar('consultar_estado_onboarding_conta', estado.agenda.conectada ? 'STATUS_CONECTADO' : 'STATUS_NAO_CONECTADO', inicio);
          return { ok: true, ...estado };
        } catch {
          registrar('consultar_estado_onboarding_conta', 'FERRAMENTA_INDISPONIVEL', inicio);
          return { ok: false, motivo: 'ESTADO_CONTA_INDISPONIVEL' };
        }
      }
    }));
  }

  if (deps.enviarLinkAgendaQualquer) {
    ferramentas.push(tool({
      name: 'preparar_link_agenda_inteligente',
      description: 'Conecta QUALQUER agenda citada pelo usuário (ex.: Tribe, TribeMD, Amplimed, iClinic, GestãoDS, Feegow, Doctoralia, Ninsaúde, Clínica nas Nuvens, Shosp, Consultório Grátis, Eye Clinic) ou reenvia o link seguro quando ele pedir de novo (consulte consultar_estado_onboarding_conta para ver ultimaAgendaSolicitada se ele não repetir o nome). Para agendas fora da lista, pesquisa online o endereço de login antes de gerar e enviar o link do cofre. Depois desta ferramenta, escreva uma fala curta e natural (sem usar [[RESULTADO_ACAO]]); em caso de reenvio, seja direto em 1 frase.',
      parameters: z.object({
        nomeAgenda: z.string().trim().min(2).max(80),
        urlManual: z.string().trim().max(250).nullable().optional()
      }),
      async execute({ nomeAgenda, urlManual }) {
        const inicio = Date.now();
        const preDefinida = identificarAgendaPreDefinida(nomeAgenda);

        if (preDefinida) {
          const cfg = AGENDAS_SUPORTADAS[preDefinida];
          const urlValida = urlManual ? validarUrlPortalAgenda(preDefinida, urlManual) : null;
          const urlPortal = urlValida?.ok ? urlValida.urlNormalizada : cfg.urlLoginPadrao;
          const envio = await deps.enviarLinkAgendaQualquer!({
            provedor: preDefinida,
            nomeAgenda: cfg.nome,
            urlPortal
          });
          registrar('preparar_link_agenda_inteligente', envio.ok ? 'LINK_ACEITO_PARA_ENVIO' : 'FERRAMENTA_INDISPONIVEL', inicio);
          return envio.ok
            ? { ok: true, tipo: 'pre_definida', agenda: cfg.nome, urlEnviada: true, observacao: 'A URL do link seguro já foi enviada na conversa. Acompanhe com 1 frase natural dizendo que quando ele acessar por lá a validação começa sozinha.' }
            : { ok: false, motivo: envio.motivo ?? 'ENVIO_INDISPONIVEL' };
        }

        let urlDescoberta: string | null = null;
        if (urlManual) {
          const checada = validarUrlPortalAgenda('personalizada', urlManual);
          if (checada.ok) urlDescoberta = checada.urlNormalizada;
        }
        if (!urlDescoberta && deps.descobrirUrlAgendaOnline) {
          const busca = await deps.descobrirUrlAgendaOnline(nomeAgenda);
          if (busca.ok) urlDescoberta = busca.urlLogin;
        }
        if (!urlDescoberta) {
          registrar('preparar_link_agenda_inteligente', 'URL_AGENDA_NAO_ENCONTRADA', inicio);
          return {
            ok: false,
            motivo: 'URL_AGENDA_NAO_ENCONTRADA',
            orientacao: `Não encontrei o endereço de login da agenda "${nomeAgenda}" online. Peça ao usuário o link/site que ele acessa para fazer login.`
          };
        }

        const envio = await deps.enviarLinkAgendaQualquer!({
          provedor: 'personalizada',
          nomeAgenda,
          urlPortal: urlDescoberta
        });
        registrar('preparar_link_agenda_inteligente', envio.ok ? 'LINK_ACEITO_PARA_ENVIO' : 'FERRAMENTA_INDISPONIVEL', inicio);
        return envio.ok
          ? { ok: true, tipo: 'descoberta_online', agenda: nomeAgenda, portalDescoberto: new URL(urlDescoberta).hostname, urlEnviada: true }
          : { ok: false, motivo: envio.motivo ?? 'ENVIO_INDISPONIVEL' };
      }
    }));
  }

  if (deps.enviarLinkCadastroProfissionais) {
    ferramentas.push(tool({
      name: 'enviar_link_cadastro_profissionais',
      description: 'Envia o link seguro do cofre SOMENTE para cadastrar Nome completo, CRM e RQE dos médicos da conta. NUNCA chame quando o usuário disser o nome da agenda (como Tribe, TribeMD, Amplimed) — para agenda use preparar_link_agenda_inteligente. Se já houver profissionais cadastrados na conta, só chame com adicionarOuEditar=true quando o médico pedir explicitamente para adicionar outro profissional ou editar cadastro. Não use [[RESULTADO_ACAO]].',
      parameters: z.object({
        adicionarOuEditar: z.boolean().optional().describe('true somente quando o médico pedir explicitamente para adicionar outro profissional ou editar dados já cadastrados.')
      }),
      async execute({ adicionarOuEditar }) {
        const inicio = Date.now();
        try {
          if (deps.consultarEstadoConta && !adicionarOuEditar) {
            const estado = await deps.consultarEstadoConta().catch(() => null);
            if (estado && estado.profissionais.length > 0) {
              registrar('enviar_link_cadastro_profissionais', 'ONBOARDING_CONSULTADO', inicio);
              return {
                ok: false,
                urlEnviada: false,
                jaCadastrados: estado.profissionais.map(p => p.nomeCompleto),
                observacao: 'Os profissionais já estão cadastrados na conta. Não envie novo link de cadastro a menos que o médico peça explicitamente para adicionar ou editar (adicionarOuEditar=true).'
              };
            }
          }
          const r = await deps.enviarLinkCadastroProfissionais!();
          registrar('enviar_link_cadastro_profissionais', r.ok ? 'LINK_ACEITO_PARA_ENVIO' : 'FERRAMENTA_INDISPONIVEL', inicio);
          return r.ok
            ? { ok: true, urlEnviada: true, observacao: 'Link de cadastro multi-profissional enviado no WhatsApp.' }
            : { ok: false, motivo: r.motivo ?? 'ENVIO_INDISPONIVEL' };
        } catch {
          registrar('enviar_link_cadastro_profissionais', 'FERRAMENTA_INDISPONIVEL', inicio);
          return { ok: false, motivo: 'ENVIO_INDISPONIVEL' };
        }
      }
    }));
  }

  if (deps.enviarLinkCertificadoIndividual && deps.consultarEstadoConta) {
    ferramentas.push(tool({
      name: 'enviar_link_certificado_profissional',
      description: 'Envia o link seguro do cofre de Certificado Digital A1 (ou XML de referência) para um profissional específico da conta, ou para todos os pendentes quando profissional=null. Se o médico pediu explicitamente para enviar/substituir um novo link mesmo já existindo certificado salvo, passe substituirExistente=true. Se linkEnviado=false, NUNCA diga que enviou o link. Não use [[RESULTADO_ACAO]].',
      parameters: z.object({
        profissional: z.string().trim().min(2).max(150).nullable(),
        tipo: z.enum(['certificado', 'xml']).default('certificado'),
        substituirExistente: z.boolean().optional().describe('true quando o médico pediu explicitamente um novo link para reenviar ou trocar o certificado já salvo.')
      }),
      async execute({ profissional, tipo, substituirExistente }) {
        const inicio = Date.now();
        try {
          const estado = await deps.consultarEstadoConta!();
          if (!estado.profissionais.length) {
            registrar('enviar_link_certificado_profissional', 'DEPENDENCIA_PROFISSIONAL', inicio);
            return { ok: false, linkEnviado: false, motivo: 'SEM_PROFISSIONAIS_CADASTRADOS', orientacao: 'Envie primeiro o link de cadastro de profissionais (enviar_link_cadastro_profissionais).' };
          }
          const alvo = profissional
            ? (estado.profissionais.length === 1
                ? estado.profissionais
                : estado.profissionais.filter(p => {
                    const norm = normalizarNomeMedico(p.nomeCompleto);
                    const busca = normalizarNomeMedico(profissional);
                    return norm === busca || norm.includes(busca) || busca.includes(norm);
                  }))
            : substituirExistente
              ? estado.profissionais
              : tipo === 'xml'
                ? estado.profissionais.filter(p => p.certificadoValido && !p.dadosFiscaisProntos)
                : estado.profissionais.filter(p => !p.certificadoValido);

          if (!alvo.length) {
            registrar('enviar_link_certificado_profissional', 'CERTIFICADO_EXISTENTE', inicio);
            return {
              ok: false,
              linkEnviado: false,
              jaEmDia: true,
              enviados: [],
              observacao: 'NENHUM link foi enviado porque o certificado A1 e/ou dados fiscais já estão válidos e cadastrados. Avise que já está tudo em dia — só envie novo link com substituirExistente=true se ele quiser trocar o certificado.'
            };
          }

          const enviados: string[] = [];
          for (const med of alvo) {
            const envio = tipo === 'xml' && deps.enviarLinkXmlIndividual
              ? await deps.enviarLinkXmlIndividual(med.id)
              : await deps.enviarLinkCertificadoIndividual!(med.id);
            if (envio.ok) enviados.push(med.nomeCompleto);
          }
          registrar('enviar_link_certificado_profissional', enviados.length ? 'LINK_ACEITO_PARA_ENVIO' : 'FERRAMENTA_INDISPONIVEL', inicio);
          return { ok: enviados.length > 0, linkEnviado: enviados.length > 0, tipo, enviados };
        } catch {
          registrar('enviar_link_certificado_profissional', 'FERRAMENTA_INDISPONIVEL', inicio);
          return { ok: false, linkEnviado: false, motivo: 'ENVIO_INDISPONIVEL' };
        }
      }
    }));
  }

  if (deps.reconsultarDadosFiscaisCertificado && deps.consultarEstadoConta) {
    ferramentas.push(tool({
      name: 'reconsultar_dados_fiscais_certificado',
      description: 'Usa o Certificado Digital A1 já salvo na conta para consultar novamente o ADN da NFS-e Nacional e importar automaticamente a última nota emitida e os parâmetros tributários. Use sempre que o médico disser "tenta puxar de novo", "busca minhas notas pelo certificado" ou perguntar se o certificado já puxou os dados fiscais. Não use [[RESULTADO_ACAO]].',
      parameters: z.object({
        profissional: z.string().trim().min(2).max(150).nullable().optional()
      }),
      async execute({ profissional }) {
        const inicio = Date.now();
        try {
          const estado = await deps.consultarEstadoConta!();
          const alvo = estado.profissionais.length === 1
            ? estado.profissionais[0]
            : profissional
              ? estado.profissionais.find(p => {
                  const norm = normalizarNomeMedico(p.nomeCompleto);
                  const busca = normalizarNomeMedico(profissional);
                  return norm === busca || norm.includes(busca) || busca.includes(norm);
                })
              : estado.profissionais[0];
          if (!alvo) {
            registrar('reconsultar_dados_fiscais_certificado', 'DEPENDENCIA_PROFISSIONAL', inicio);
            return { ok: false, fiscalImportado: false, motivo: 'SEM_PROFISSIONAIS_CADASTRADOS' };
          }
          if (!alvo.certificadoValido) {
            registrar('reconsultar_dados_fiscais_certificado', 'CERTIFICADO_PENDENTE', inicio);
            return { ok: false, fiscalImportado: false, motivo: 'CERTIFICADO_NAO_ENCONTRADO', profissional: alvo.nomeCompleto };
          }
          const r = await deps.reconsultarDadosFiscaisCertificado!(alvo.id);
          registrar('reconsultar_dados_fiscais_certificado', r.fiscalImportado ? 'FISCAL_IMPORTADO_ADN' : 'FISCAL_ADN_NAO_ENCONTRADO', inicio);
          return { ...r, profissional: alvo.nomeCompleto };
        } catch {
          registrar('reconsultar_dados_fiscais_certificado', 'FERRAMENTA_INDISPONIVEL', inicio);
          return { ok: false, fiscalImportado: false, motivo: 'RECONSULTA_INDISPONIVEL' };
        }
      }
    }));
  }

  return ferramentas;
}
