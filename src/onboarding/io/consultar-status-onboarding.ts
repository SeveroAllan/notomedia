/**
 * Consulta o estado atual do médico no checklist dos 5 passos do onboarding.
 * Determina quais etapas já foram completadas e se o médico já está liberado
 * para emitir notas fiscais pelo WhatsApp (seção 1 do plano).
 */

import type pg from 'pg';
import { temAprovacaoProfissional } from '../../cadastro/revisao-painel.js';
import { dadosProfissionaisCompletos } from '../../conta/validar-dados-emissao.js';
import { parametrosEmissaoSchema } from '../../fiscal/preparacao/parametros-emissao.js';
import { validarReferenciaFiscal } from '../../fiscal/preparacao/validar-referencia-fiscal.js';

export type StatusOnboardingMedico = {
  medicoId: string;
  usuarioId: string | null;
  nomeUsuario: string;
  crm?: string | null;
  rqe?: string | null;
  telefone?: string | null;
  email?: string | null;
  numeroWhatsapp?: string | null;
  solicitarCpfDiretoPaciente?: boolean;
  passos: {
    passo1Nome: boolean;
    passo2XmlEnviado: boolean;
    passo2FiscalConfirmado: boolean;
    passo3CertificadoValido: boolean;
    passoProfissionalAprovado: boolean;
    passo4WhatsappConectado: boolean;
    passo4WhatsappVinculado?: boolean;
  };
  liberadoParaEmitir: boolean;
  dadosProfissionaisCompletos: boolean;
  perfilFiscal?: {
    referenciaFiscal?: unknown;
    parametrosEmissao?: unknown;
    razaoSocial: string | null;
    cnpjCpfMask: string | null;
    inscricaoMunicipal: string | null;
    uf: string | null;
    codMunicipioIbge: string | null;
    serieDps: string;
    proximoNumeroDps: number;
    opcaoSimplesNacional?: 'nao_optante' | 'mei' | 'me_epp';
    extraidoAutomaticamente: boolean;
    confirmadoPeloMedico: boolean;
    especialidade: string | null;
    aliquotaIss: number | null;
  } | null;
};

export async function consultarStatusOnboarding(
  pool: pg.Pool,
  medicoId: string,
  preparacaoFiscalAtiva = false
): Promise<StatusOnboardingMedico> {
  const sql = `
    select
      m.id as medico_id,
      m.usuario_id,
      m.nome_completo as medico_nome,
      m.especialidade,
      m.crm,
      m.rqe,
      m.solicitar_cpf_direto_paciente,
      u.nome as usuario_nome,
      u.telefone,
      u.email,
      pf.razao_social,
      pf.inscricao_municipal,
      pf.uf,
      pf.cod_municipio_ibge,
      pf.serie_dps,
      pf.proximo_numero_dps,
      pf.opcao_simples_nacional,
      pf.extraido_automaticamente,
      pf.confirmado_pelo_medico,
      pf.dados_reforma_tributaria,
      msf.aliquota_iss,
      to_jsonb(msf)->'parametros_emissao' as parametros_emissao,
      (select w.numero_telefone from whatsapp_instancias w where (w.conta_id = m.conta_id or w.medico_id = m.id) and w.status = 'conectado' order by w.conectado_em desc nulls last limit 1) as numero_whatsapp,
      (select to_jsonb(t) from cadastro_certificado_trabalhos t
        where t.medico_id=m.id and t.certificado_id=(
          select c.id from medico_certificados c where c.medico_id=m.id and c.status='ativo'
          order by c.criado_em desc,c.id desc limit 1
        ) limit 1) as revisao_profissional,
      (select count(*) from medico_certificados c where c.medico_id = m.id and c.status = 'ativo') as cert_ativos,
      (select count(*) from whatsapp_instancias w where (w.conta_id = m.conta_id or w.medico_id = m.id) and w.status = 'conectado') as whats_conectados,
      exists(select 1 from whatsapp_instancias w where (w.conta_id = m.conta_id or w.medico_id = m.id) and w.oficial = false and w.conectado_em is not null) as whatsapp_vinculado
    from medicos m
    left join usuarios u on u.id = m.usuario_id
    left join medico_perfil_fiscal pf on pf.medico_id = m.id
    left join medico_servicos_fiscais msf on msf.medico_id = m.id and msf.padrao = true and msf.ativo = true
    where m.id = $1
    limit 1
  `;

  const { rows } = await pool.query(sql, [medicoId]);
  if (rows.length === 0) {
    throw new Error(`Médico ${medicoId} não encontrado.`);
  }

  const r = rows[0];
  const nomeExibicao = (r.medico_nome || r.usuario_nome || '').trim();
  const passo1Nome = Boolean(nomeExibicao.length > 2 && nomeExibicao !== 'Médico');
  const passo2XmlEnviado = Boolean(r.extraido_automaticamente || r.confirmado_pelo_medico);
  const politicaRevisada = Boolean(r.parametros_emissao?.confirmadoEm) && parametrosEmissaoSchema.safeParse(r.parametros_emissao?.parametros).success;
  const referenciaNova = r.dados_reforma_tributaria?.versao === 2;
  const referenciaValidada = !referenciaNova || (politicaRevisada &&
    validarReferenciaFiscal(r.dados_reforma_tributaria, r.parametros_emissao).length === 0);
  const passo2FiscalConfirmado = Boolean(r.confirmado_pelo_medico) && (!preparacaoFiscalAtiva || politicaRevisada) && referenciaValidada;
  const passo3CertificadoValido = Number(r.cert_ativos || 0) > 0;
  const passoProfissionalAprovado = temAprovacaoProfissional(r.revisao_profissional ?? null, { nome: r.medico_nome, crm: r.crm ?? null, rqe: r.rqe ?? null });
  const passo4WhatsappConectado = Number(r.whats_conectados || 0) > 0;
  // A temporary disconnect does not undo the completed pairing step.
  const passo4WhatsappVinculado = Boolean(r.whatsapp_vinculado) || passo4WhatsappConectado;

  // Identidade profissional não impede acesso ao painel, mas é obrigatória para emissão.
  const cadastroProfissionalCompleto = dadosProfissionaisCompletos({ nomeCompleto: r.medico_nome, crm: r.crm });
  const liberadoParaEmitir = cadastroProfissionalCompleto && passoProfissionalAprovado && passo2FiscalConfirmado && passo3CertificadoValido && passo4WhatsappConectado;

  return {
    medicoId: r.medico_id,
    usuarioId: r.usuario_id,
    nomeUsuario: nomeExibicao || 'Dr(a).',
    crm: r.crm || null,
    rqe: r.rqe || null,
    telefone: r.telefone || null,
    numeroWhatsapp: r.numero_whatsapp || null,
    email: r.email?.endsWith("@auth.notomed.local") ? null : r.email || null,
    solicitarCpfDiretoPaciente: Boolean(r.solicitar_cpf_direto_paciente),
    passos: {
      passo1Nome,
      passo2XmlEnviado,
      passo2FiscalConfirmado,
      passo3CertificadoValido,
      passoProfissionalAprovado,
      passo4WhatsappConectado,
      passo4WhatsappVinculado
    },
    liberadoParaEmitir,
    dadosProfissionaisCompletos: cadastroProfissionalCompleto,
    perfilFiscal: r.razao_social ? {
      referenciaFiscal: r.dados_reforma_tributaria,
      parametrosEmissao: r.parametros_emissao,
      razaoSocial: r.razao_social,
      cnpjCpfMask: 'Cadastrado / Seguro',
      inscricaoMunicipal: r.inscricao_municipal,
      uf: r.uf,
      codMunicipioIbge: r.cod_municipio_ibge,
      serieDps: r.serie_dps || '00001',
      proximoNumeroDps: r.proximo_numero_dps || 1,
      opcaoSimplesNacional: r.opcao_simples_nacional || 'me_epp',
      extraidoAutomaticamente: r.extraido_automaticamente,
      confirmadoPeloMedico: r.confirmado_pelo_medico,
      especialidade: r.especialidade,
      aliquotaIss: r.aliquota_iss ? Number(r.aliquota_iss) : null
    } : null
  };
}
