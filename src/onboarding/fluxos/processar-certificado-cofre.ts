/**
 * Caso de uso reutilizado pelo link seguro do cofre (`/c/certificado/:token`)
 * para validar o Certificado Digital A1 (.pfx/.p12), salvá-lo criptografado
 * para aquele profissional específico e consultar automaticamente a última
 * NFS-e no ADN Nacional para extrair e adotar os dados tributários.
 */

import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdnNfseClient } from '../../io/fiscal/adn-nfse-client.js';
import { extrairChavesCertificado } from '../../io/fiscal/extrair-chaves-certificado.js';
import { carregarCertificadoMedico } from '../../io/fiscal/carregar-certificado-medico.js';
import { salvarCertificadoMedico } from './salvar-certificado-medico.js';
import { processarOnboardingXml } from './processar-onboarding-xml.js';
import { adotarReferenciaConsentida, versaoConsentimentoFiscal } from './consentimento-fiscal.js';
import type {
  ResultadoProcessamentoCertificado,
  ResultadoProcessamentoXml
} from '../../cofre/links-onboarding-service.js';

export interface DependenciasCertificadoCofre {
  pool: pg.Pool;
  supabase: SupabaseClient;
  adnNfseClient: Pick<AdnNfseClient, 'buscarNfseMaisRecente'>;
  encryptionKey: string;
  appPepper: string;
  preparacaoFiscalAtiva?: boolean;
  escopoFiscalPiloto?: (medicoId: string, contaId: string) => { contaPilotoHomologacao?: string };
}

export async function processarCertificadoViaCofre(
  deps: DependenciasCertificadoCofre,
  entrada: { contaId: string; medicoId: string; arquivoBase64: string; senha: string; consentimentoFiscal: string }
): Promise<ResultadoProcessamentoCertificado> {
  if (entrada.consentimentoFiscal !== versaoConsentimentoFiscal) {
    return { ok: false, detalheErro: 'Consentimento fiscal desatualizado. Recarregue a página e tente novamente.' };
  }
  const arquivoBuffer = Buffer.from(entrada.arquivoBase64, 'base64');
  let certificado: ReturnType<typeof extrairChavesCertificado>;
  try {
    certificado = extrairChavesCertificado(arquivoBuffer, entrada.senha);
  } catch (err: any) {
    return { ok: false, detalheErro: `Certificado A1 ou senha inválidos: ${err?.message || 'arquivo ilegível'}` };
  }

  const { validoDe, validoAte, documentoTitular } = certificado;
  const agora = Date.now();
  if (!validoDe || !validoAte || !Number.isFinite(validoDe.getTime()) || !Number.isFinite(validoAte.getTime())) {
    return { ok: false, detalheErro: 'Não foi possível verificar o período de validade do certificado A1.' };
  }
  if (validoDe.getTime() > agora || validoAte.getTime() <= agora) {
    return { ok: false, detalheErro: 'O certificado A1 está fora do período de validade.' };
  }

  const userRes = await deps.pool.query(
    `select id from public.usuarios where conta_id = $1 and ativo = true order by criado_em, id limit 1`,
    [entrada.contaId]
  );
  const usuarioId = String(userRes.rows[0]?.id ?? entrada.medicoId);

  await salvarCertificadoMedico(deps.pool, deps.supabase, {
    medicoId: entrada.medicoId,
    arquivoBuffer,
    usuarioId,
    validoDe,
    validoAte,
    senhaCertificado: entrada.senha
  });

  if (!documentoTitular) {
    return { ok: true, fiscalImportado: false };
  }

  try {
    const consulta = await deps.adnNfseClient.buscarNfseMaisRecente(arquivoBuffer, entrada.senha, documentoTitular);
    const piloto = deps.escopoFiscalPiloto?.(entrada.medicoId, entrada.contaId) ?? {};
    const fiscal = await processarOnboardingXml(
      {
        pool: deps.pool,
        documentoTitularEsperado: documentoTitular,
        supabase: deps.supabase,
        chaveCriptografia: deps.encryptionKey,
        ...piloto,
        pepperCpf: deps.appPepper
      },
      entrada.medicoId,
      consulta.documento.xml
    );
    const adocao = await adotarReferenciaConsentida(
      { pool: deps.pool, preparacaoFiscalAtiva: Boolean(deps.preparacaoFiscalAtiva), ...piloto },
      entrada.medicoId,
      fiscal.parametros.dadosReformaTributaria.hash
    );
    const resumoFiscal = `${fiscal.parametros.razaoSocial || 'Prestador'} • ${fiscal.parametros.uf || ''}`.replace(/ • $/, '');
    return adocao.ok
      ? { ok: true, fiscalImportado: true, resumoFiscal }
      : { ok: true, fiscalImportado: false, detalheErro: adocao.detalhe || adocao.codigo };
  } catch (err: any) {
    console.warn('[Certificado Cofre] Busca automática no ADN não concluída:', err?.message || 'erro desconhecido');
    return { ok: true, fiscalImportado: false };
  }
}

export async function processarXmlViaCofre(
  deps: DependenciasCertificadoCofre,
  entrada: { contaId: string; medicoId: string; xmlString: string }
): Promise<ResultadoProcessamentoXml> {
  const certificado = await carregarCertificadoMedico(deps.pool, deps.supabase, entrada.medicoId);
  if (!certificado) {
    return { ok: false, detalheErro: 'Salve o certificado A1 antes de enviar o XML de referência.' };
  }
  const titular = extrairChavesCertificado(certificado.pfxBuffer, certificado.senhaCertificado).documentoTitular;
  if (!titular) {
    return { ok: false, detalheErro: 'Não foi possível identificar o titular do certificado A1.' };
  }
  try {
    const piloto = deps.escopoFiscalPiloto?.(entrada.medicoId, entrada.contaId) ?? {};
    const fiscal = await processarOnboardingXml(
      {
        pool: deps.pool,
        documentoTitularEsperado: titular,
        supabase: deps.supabase,
        chaveCriptografia: deps.encryptionKey,
        ...piloto,
        pepperCpf: deps.appPepper
      },
      entrada.medicoId,
      entrada.xmlString
    );
    const adocao = await adotarReferenciaConsentida(
      { pool: deps.pool, preparacaoFiscalAtiva: Boolean(deps.preparacaoFiscalAtiva), ...piloto },
      entrada.medicoId,
      fiscal.parametros.dadosReformaTributaria.hash
    );
    if (!adocao.ok) {
      return { ok: false, detalheErro: adocao.detalhe || 'Os parâmetros fiscais deste XML ficaram pendentes de revisão.' };
    }
    return { ok: true, resumoFiscal: fiscal.parametros.razaoSocial || undefined };
  } catch (err: any) {
    return { ok: false, detalheErro: err?.message || 'Não foi possível ler o XML informado.' };
  }
}

export async function reconsultarFiscalPeloCertificadoSalvo(
  deps: DependenciasCertificadoCofre,
  entrada: { contaId: string; medicoId: string }
): Promise<{
  ok: boolean;
  fiscalImportado: boolean;
  resumoFiscal?: string;
  notasEncontradas?: number;
  dataUltimaNota?: string | null;
  motivo?: string;
}> {
  const certificado = await carregarCertificadoMedico(deps.pool, deps.supabase, entrada.medicoId);
  if (!certificado) {
    return { ok: false, fiscalImportado: false, motivo: 'CERTIFICADO_NAO_ENCONTRADO' };
  }
  const titular = extrairChavesCertificado(certificado.pfxBuffer, certificado.senhaCertificado).documentoTitular;
  if (!titular) {
    return { ok: false, fiscalImportado: false, motivo: 'TITULAR_CERTIFICADO_NAO_IDENTIFICADO' };
  }
  try {
    const consulta = await deps.adnNfseClient.buscarNfseMaisRecente(
      certificado.pfxBuffer,
      certificado.senhaCertificado,
      titular
    );
    const piloto = deps.escopoFiscalPiloto?.(entrada.medicoId, entrada.contaId) ?? {};
    const fiscal = await processarOnboardingXml(
      {
        pool: deps.pool,
        documentoTitularEsperado: titular,
        supabase: deps.supabase,
        chaveCriptografia: deps.encryptionKey,
        ...piloto,
        pepperCpf: deps.appPepper
      },
      entrada.medicoId,
      consulta.documento.xml
    );
    const adocao = await adotarReferenciaConsentida(
      { pool: deps.pool, preparacaoFiscalAtiva: Boolean(deps.preparacaoFiscalAtiva), ...piloto },
      entrada.medicoId,
      fiscal.parametros.dadosReformaTributaria.hash
    );
    const resumoFiscal = `${fiscal.parametros.razaoSocial || 'Prestador'} • ${fiscal.parametros.uf || ''}`.replace(/ • $/, '');
    return {
      ok: adocao.ok,
      fiscalImportado: adocao.ok,
      resumoFiscal,
      notasEncontradas: consulta.resumo.notasDoTitular,
      dataUltimaNota: consulta.resumo.dataEmissaoSelecionada,
      ...(!adocao.ok ? { motivo: adocao.detalhe || adocao.codigo || 'PARAMETROS_FISCAIS_PENDENTES' } : {})
    };
  } catch (err: any) {
    const motivo = err?.message || 'ADN_INDISPONIVEL';
    console.warn('[Certificado Cofre] Reconsulta ADN não concluída:', motivo);
    return { ok: false, fiscalImportado: false, motivo };
  }
}
