/**
 * Retrato real de prontidão de uma conta para a IA tomar decisões autônomas no
 * WhatsApp: qual agenda está conectada, quais profissionais já estão cadastrados,
 * quem já tem Certificado A1 e dados tributários extraídos, e qual a próxima etapa.
 */

import type pg from 'pg';
import { AGENDAS_SUPORTADAS, agendaSuportada } from '../agenda/agendas-suportadas.js';
import {
  avaliarPreferenciasEmissao,
  type PreferenciasEmissaoConta,
  type ResumoPreferenciasEmissao
} from '../conta/preferencias-emissao.js';
import { consultarPreferenciasEmissaoConta } from '../conta/preferencias-emissao-repositorio.js';
import { nomeProfissionalValido } from '../conta/validar-dados-emissao.js';
import type { StatusFontes } from './agente.js';

export interface ProfissionalProntidaoConta {
  id: string;
  nomeCompleto: string;
  crm: string | null;
  rqe: string | null;
  certificadoValido: boolean;
  dadosFiscaisProntos: boolean;
}

export interface AgendaConectadaResumo {
  conectada: boolean;
  provedor: string | null;
  nomeAgenda: string | null;
}

export type ProximaEtapaOnboarding =
  | 'conectar_agenda'
  | 'cadastrar_profissionais'
  | 'enviar_certificados'
  | 'enviar_xml_referencia'
  | 'definir_preferencias'
  | 'pronto';

export interface UltimaAgendaSolicitada {
  provedor: string;
  nomeAgenda: string;
  usado: boolean;
}

export interface EstadoProntidaoConta {
  agenda: AgendaConectadaResumo;
  ultimaAgendaSolicitada?: UltimaAgendaSolicitada | null;
  profissionais: ProfissionalProntidaoConta[];
  proximaEtapa: ProximaEtapaOnboarding;
  profissionaisSemCertificado: Array<{ id: string; nome: string }>;
  profissionaisSemFiscal: Array<{ id: string; nome: string }>;
  preferenciasEmissao?: ResumoPreferenciasEmissao;
}

/** Regra pura: decide a próxima etapa correta com base apenas no que já existe. */
export function decidirProximoPassoOnboarding(entrada: {
  agenda: AgendaConectadaResumo;
  profissionais: ProfissionalProntidaoConta[];
  preferenciasEmissao?: PreferenciasEmissaoConta;
}): EstadoProntidaoConta {
  const semCert = entrada.profissionais
    .filter(p => !p.certificadoValido)
    .map(p => ({ id: p.id, nome: p.nomeCompleto }));
  const semFiscal = entrada.profissionais
    .filter(p => p.certificadoValido && !p.dadosFiscaisProntos)
    .map(p => ({ id: p.id, nome: p.nomeCompleto }));
  const resumoPreferencias = entrada.preferenciasEmissao
    ? avaliarPreferenciasEmissao(entrada.preferenciasEmissao)
    : undefined;

  let proximaEtapa: ProximaEtapaOnboarding = 'pronto';
  if (!entrada.agenda.conectada) {
    proximaEtapa = 'conectar_agenda';
  } else if (entrada.profissionais.length === 0) {
    proximaEtapa = 'cadastrar_profissionais';
  } else if (semCert.length > 0) {
    proximaEtapa = 'enviar_certificados';
  } else if (semFiscal.length > 0) {
    proximaEtapa = 'enviar_xml_referencia';
  } else if (resumoPreferencias && !resumoPreferencias.completas) {
    proximaEtapa = 'definir_preferencias';
  }

  return {
    agenda: entrada.agenda,
    profissionais: entrada.profissionais,
    proximaEtapa,
    profissionaisSemCertificado: semCert,
    profissionaisSemFiscal: semFiscal,
    ...(resumoPreferencias ? { preferenciasEmissao: resumoPreferencias } : {})
  };
}

export async function consultarEstadoProntidaoConta(deps: {
  pool: Pick<pg.Pool, 'query'>;
  contaId: string;
  consultarAgendasPadrao: () => Promise<StatusFontes>;
  consultarAgendaGenerica?: () => Promise<{ conectada: boolean; provedor: string | null; nomeAgenda: string | null }>;
}): Promise<EstadoProntidaoConta> {
  const [padrao, generica, medsRes, ultimoLinkRes, preferenciasEmissao] = await Promise.all([
    deps.consultarAgendasPadrao().catch(() => null),
    deps.consultarAgendaGenerica ? deps.consultarAgendaGenerica().catch(() => null) : Promise.resolve(null),
    deps.pool.query(
      `select m.id, m.nome_completo, m.crm, m.rqe,
        exists(
          select 1 from public.medico_certificados c
          where c.medico_id = m.id and c.status = 'ativo'
            and (c.valido_de is null or c.valido_de <= current_date)
            and (c.valido_ate is null or c.valido_ate >= current_date)
        ) as certificado_valido,
        exists(
          select 1 from public.medico_perfil_fiscal pf
          join public.medico_servicos_fiscais sf
            on sf.medico_id = pf.medico_id and sf.ativo = true and sf.padrao = true
          where pf.medico_id = m.id
            and pf.confirmado_pelo_medico = true
            and pf.serie_dps ~ '^[0-9]{1,5}$'
            and pf.serie_dps::int <= 49999
            and sf.ctrib_nac is not null
            and sf.parametros_emissao is not null
        ) as dados_fiscais_prontos
       from public.medicos m
       where m.conta_id = $1
       order by m.criado_em, m.id
       limit 25`,
      [deps.contaId]
    ),
    deps.pool.query(
      `select agenda, usado_em, metadados
       from public.cofre_links
       where conta_id = $1
         and agenda not in ('registro_profissional', 'cadastro_profissionais', 'certificado_a1', 'xml_referencia')
       order by criado_em desc
       limit 1`,
      [deps.contaId]
    ).catch(() => ({ rows: [] as any[] })),
    consultarPreferenciasEmissaoConta(deps.pool, deps.contaId)
  ]);

  let agenda: AgendaConectadaResumo = { conectada: false, provedor: null, nomeAgenda: null };
  if (generica?.conectada) {
    agenda = { conectada: true, provedor: generica.provedor, nomeAgenda: generica.nomeAgenda };
  } else if (padrao?.tribemd.conectada) {
    agenda = { conectada: true, provedor: 'tribemd', nomeAgenda: 'TribeMD' };
  } else if (padrao?.amplimed.conectada) {
    agenda = { conectada: true, provedor: 'amplimed', nomeAgenda: 'Amplimed' };
  }

  const linhaLink = ultimoLinkRes.rows[0] as { agenda?: string; usado_em?: unknown; metadados?: { nomeAgenda?: string } | null } | undefined;
  const provLink = linhaLink?.agenda ? agendaSuportada(linhaLink.agenda) : null;
  const ultimaAgendaSolicitada: UltimaAgendaSolicitada | null = linhaLink?.agenda
    ? {
        provedor: linhaLink.agenda,
        nomeAgenda: linhaLink.metadados?.nomeAgenda || (provLink ? AGENDAS_SUPORTADAS[provLink].nome : linhaLink.agenda),
        usado: Boolean(linhaLink.usado_em)
      }
    : null;

  const profissionais: ProfissionalProntidaoConta[] = medsRes.rows
    .map(row => ({
      id: String(row.id),
      nomeCompleto: String(row.nome_completo ?? '').trim(),
      crm: row.crm ? String(row.crm) : null,
      rqe: row.rqe ? String(row.rqe) : null,
      certificadoValido: Boolean(row.certificado_valido),
      dadosFiscaisProntos: Boolean(row.dados_fiscais_prontos)
    }))
    .filter(p => nomeProfissionalValido(p.nomeCompleto));

  return {
    ...decidirProximoPassoOnboarding({ agenda, profissionais, preferenciasEmissao }),
    ultimaAgendaSolicitada
  };
}
