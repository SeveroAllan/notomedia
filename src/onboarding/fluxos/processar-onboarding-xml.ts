/**
 * Fluxo de processamento e extração de parâmetros fiscais do XML no onboarding.
 * Orquestra: parse do XML -> validação padrão nacional -> mapeamento puro dos parâmetros
 * duradouros -> armazenamento do arquivo no storage -> persistência no banco (seção 4 e 7).
 */

import type pg from 'pg';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { lerXmlNotaReferencia } from '../io/ler-xml-nota-referencia.js';
import { mapearParametrosFiscaisDoXml, type ParametrosFiscaisExtraidos } from '../regras/mapear-parametros-fiscais-do-xml.js';
import { mapearServicoFiscalDoXml, type ServicoFiscalExtraido } from '../regras/mapear-servico-fiscal-do-xml.js';
import { armazenarXmlReferencia } from '../io/armazenar-xml-referencia.js';
import { salvarParametrosFiscais } from '../io/salvar-parametros-fiscais.js';
import { salvarServicoFiscalPadrao } from '../io/salvar-servico-fiscal-padrao.js';

export type ProcessarOnboardingXmlDeps = {
  pool: pg.Pool;
  supabase: SupabaseClient;
  chaveCriptografia: string;
  pepperCpf: string;
  documentoTitularEsperado?: string;
  somenteReferencia?: boolean;
};

export type ResultadoProcessamentoXml = {
  ok: boolean;
  versao: string;
  parametros: ParametrosFiscaisExtraidos;
  servico: ServicoFiscalExtraido;
};

export async function processarOnboardingXml(
  deps: ProcessarOnboardingXmlDeps,
  medicoId: string,
  xmlConteudo: string
): Promise<ResultadoProcessamentoXml> {
  const { versao, xmlObj } = lerXmlNotaReferencia(xmlConteudo);

  const parametros = mapearParametrosFiscaisDoXml(xmlObj);
  const servico = mapearServicoFiscalDoXml(xmlObj);
  if (deps.documentoTitularEsperado && parametros.cnpj !== deps.documentoTitularEsperado.replace(/\D/g, '')) {
    throw new Error('A nota de referência não pertence ao titular do certificado cadastrado.');
  }
  parametros.dadosReformaTributaria = { ...parametros.dadosReformaTributaria,
    hash: createHash('sha256').update(xmlConteudo).digest('hex'), importadaEm: new Date().toISOString() };

  const xmlStorageUrl = await armazenarXmlReferencia(deps.supabase, medicoId, xmlConteudo);

  const client = await deps.pool.connect();
  try {
    await client.query('begin');
    await client.query('select id from medicos where id = $1 for update', [medicoId]);
    if (deps.somenteReferencia) {
      await client.query(`update medico_perfil_fiscal set dados_reforma_tributaria = $2,
        xml_nota_referencia_url = coalesce(xml_nota_referencia_url, $3), atualizado_em = now() where medico_id = $1`,
        [medicoId, JSON.stringify(parametros.dadosReformaTributaria), xmlStorageUrl]);
    } else {
      await salvarParametrosFiscais(client, {
      medicoId,
      params: parametros,
      xmlStorageUrl,
      chaveCriptografia: deps.chaveCriptografia,
      pepperCpf: deps.pepperCpf
      });

      await salvarServicoFiscalPadrao(client, medicoId, servico);
    }
    await client.query('commit');
  } catch (erro) {
    await client.query('rollback');
    throw erro;
  } finally { client.release(); }

  return {
    ok: true,
    versao,
    parametros,
    servico
  };
}
