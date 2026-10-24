/** A confirmação prende a política ao serviço/perfil revisados na mesma transação. */
import type pg from 'pg';

import { parametrosEmissaoSchema, type ParametrosEmissao } from '../../fiscal/preparacao/parametros-emissao.js';
import { validarReferenciaFiscal } from '../../fiscal/preparacao/validar-referencia-fiscal.js';
export class ErroAdocaoReferencia extends Error {
  constructor(public readonly codigo: string, mensagem: string,
    public readonly diagnostico: { campos?: string[]; pendencias?: string[] } = {}) {
    super(mensagem);
    this.name = 'ErroAdocaoReferencia';
  }
}
/** Explica categorias fiscais sem encaminhar mensagens cruas do validador. */
function explicarCamposPendentes(campos: string[]): string {
  const regras: Array<[RegExp, string]> = [
    [/^aliquotaIss(?:\.|$)|(?:^|\/)pAliq$/, 'alíquota de ISS'],
    [/tpRetISSQN/, 'retenção de ISS'],
    [/tribISSQN/, 'tratamento do ISS'],
    [/totalTributos|totTrib|percentualTotTribSN/, 'forma de totalização dos tributos'],
    [/pisCofinsCalculo|cstPisCofins|piscofins/, 'declaração e cálculo de PIS/COFINS'],
    [/tribFed/, 'declaração de tributos federais'],
    [/municipioPrestacao|locPrest/, 'município da prestação'],
    [/regime|opcaoSimplesNacional|regTrib/, 'regime tributário e forma de apuração'],
    [/ambiente/, 'ambiente de emissão'],
    [/IBSCBS|ibscbs/, 'informações de IBS/CBS'],
    [/^tribMun/, 'regras municipais de ISS'],
    [/^serv/, 'identificação e classificação do serviço'],
    [/^valores/, 'base de cálculo e composição dos valores'],
    [/^DPS/, 'informações adicionais da declaração']
  ];
  const motivos = [...new Set(campos.map(campo => regras.find(([padrao]) => padrao.test(campo))?.[1]
    || 'informações adicionais da referência'))];
  return motivos.length
    ? `A nota tem pendências em: ${motivos.join('; ')}. Esses dados estão incompletos, inconsistentes ou exigem suporte adicional. A equipe precisa analisar esses itens antes de liberar a emissão.`
    : 'A declaração original da nota precisa de análise antes de liberar a emissão. A equipe pode consultar as pendências específicas nos registros de validação.';
}
export async function confirmarPoliticaEmissao(pool: pg.Pool, input: { medicoId: string; referenciaHash?: string; usarReferencia?: boolean; parametrosEmissao?: unknown; opcaoSimplesNacional?: string; serieDps?: string; proximoNumeroDps?: number; razaoSocial?: string; especialidade?: string; aliquotaIss?: number }): Promise<void> {
  let parametros: ParametrosEmissao | undefined = input.usarReferencia ? undefined : parametrosEmissaoSchema.parse(input.parametrosEmissao);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const perfil = await client.query(`select cod_municipio_ibge, serie_dps, xml_nota_referencia_url, dados_reforma_tributaria
      from medico_perfil_fiscal where medico_id = $1 for update`, [input.medicoId]);
    const servicos = await client.query(`select id, ctrib_nac, cnbs, ctrib_mun, parametros_emissao from medico_servicos_fiscais
      where medico_id = $1 and padrao and ativo for update`, [input.medicoId]);
    if (perfil.rows.length !== 1 || servicos.rows.length !== 1) throw new Error('É necessário um perfil e um único serviço padrão ativo.');
    const p = perfil.rows[0], s = servicos.rows[0];
    if (input.usarReferencia) {
      const referencia = p.dados_reforma_tributaria;
      if (referencia?.versao !== 2 || !referencia.hash || referencia.hash !== input.referenciaHash) {
        throw new ErroAdocaoReferencia('REFERENCIA_ALTERADA', 'A nota encontrada mudou. Confira a referência atual antes de continuar.');
      }
      const pendenciasReferencia: string[] = referencia.pendencias || [];
      if (pendenciasReferencia.length) {
        const texto = pendenciasReferencia.join(' ');
        const campos = [...new Set(pendenciasReferencia.map(pendencia => pendencia.split(':')[0].trim())
          .filter(campo => /^[A-Za-z_][A-Za-z0-9_/.]{0,119}$/.test(campo)))];
        const mensagem = texto.includes('tribMun/pAliq')
          ? 'A nota contém uma alíquota de ISS que o emissor do Noto ainda não consegue reproduzir. A configuração permanece pendente para análise da equipe.'
          : texto.includes('não optante pelo Simples')
          ? 'Esta referência foi analisada antes do suporte ao regime fora do Simples. Clique em Buscar nota pelo certificado para atualizar a análise e confirme novamente.'
          : texto.includes('totTrib/vTotTrib')
          ? 'A nota informa tributos aproximados em valores, sem uma regra explícita para recalculá-los nas próximas consultas. A equipe precisa analisar essa forma de totalização antes de liberar a emissão.'
          : texto.includes('IBSCBS') || texto.includes('IBS/CBS')
          ? 'A nota contém informações de IBS/CBS que o Noto ainda não consegue reproduzir integralmente. A configuração permanece pendente para análise da equipe.'
          : texto.includes('tribFed')
          ? 'A forma de declaração dos tributos federais dessa nota ainda precisa de suporte no Noto. A configuração permanece pendente para análise da equipe.'
          : explicarCamposPendentes(campos);
        throw new ErroAdocaoReferencia('REFERENCIA_FISCAL_PENDENTE', mensagem, { campos, pendencias: pendenciasReferencia });
      }
      const hojeSp = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
      const inicioAno = `${hojeSp.slice(0, 4)}-01-01`;
      const vigenciaInicio = typeof referencia.parametrosSugeridos?.vigenciaInicio === 'string' &&
        referencia.parametrosSugeridos.vigenciaInicio <= hojeSp
          ? referencia.parametrosSugeridos.vigenciaInicio
          : inicioAno;
      const candidato = parametrosEmissaoSchema.safeParse({ ...referencia.parametrosSugeridos,
        vigenciaInicio });
      if (!candidato.success) {
        const campos = [...new Set(candidato.error.issues.map(erro => erro.path.join('.')))];
        const nomes: Record<string, string> = { ambiente: 'ambiente de emissão', municipioPrestacao: 'município da prestação',
          opcaoSimplesNacional: 'regime tributário', regimeApuracaoSn: 'regime de apuração', regimeEspecialTributacao: 'regime especial',
          tribISSQN: 'tratamento do ISS', tpRetISSQN: 'retenção do ISS', cstPisCofins: 'PIS/COFINS', percentualTotTribSN: 'totalização dos tributos', aliquotaIss: 'alíquota do ISS', totalTributos: 'totalização dos tributos', pisCofinsCalculo: 'cálculo de PIS/COFINS', ibscbs: 'IBS/CBS' };
        const motivos = [...new Set(campos.map(campo => nomes[campo.split('.')[0]] || 'informações tributárias adicionais'))];
        throw new ErroAdocaoReferencia('PARAMETROS_REFERENCIA_PENDENTES',
          `A referência precisa de análise em: ${motivos.join(', ')}. Esses dados estão ausentes ou ainda não são suportados pelo Noto; o consentimento não substitui essa verificação.`, { campos });
      }
      parametros = candidato.data;
    }
    if (!parametros) throw new Error('Configuração fiscal ausente.');
    if (input.opcaoSimplesNacional && input.opcaoSimplesNacional !== parametros.opcaoSimplesNacional) throw new Error('Regimes informados divergem.');
    const pendencias = validarReferenciaFiscal(p.dados_reforma_tributaria, { referenciaHash: input.referenciaHash, parametros, fidelidadeReferencia: input.usarReferencia, ctribNac: s.ctrib_nac, ctribMun: s.ctrib_mun, cnbs: s.cnbs });
    if (pendencias.length) throw new Error(pendencias.join(' '));
    const serie = input.serieDps ?? p.serie_dps;
    if (!/^\d{1,5}$/.test(serie) || Number(serie) > 49999) throw new Error('Série da DPS deve estar entre 0 e 49999 para emissão pelo aplicativo próprio.');
    if (input.proximoNumeroDps !== undefined && (!Number.isSafeInteger(input.proximoNumeroDps) || input.proximoNumeroDps < 1)) throw new Error('Número da DPS inválido.');
    if (!/^\d{6}$/.test(s.ctrib_nac)) throw new Error('Código de tributação do serviço inválido.');
    await client.query(`update medico_perfil_fiscal set confirmado_pelo_medico = true,
      ambiente = $8, serie_dps = $2, proximo_numero_dps = coalesce($3, proximo_numero_dps),
      opcao_simples_nacional = $4, regime_apuracao_sn = $5, regime_especial_tributacao = $6,
      percentual_tot_trib_sn = coalesce($7, percentual_tot_trib_sn), atualizado_em = now()
      where medico_id = $1`, [input.medicoId, serie, input.proximoNumeroDps, parametros.opcaoSimplesNacional,
      parametros.regimeApuracaoSn ?? null, parametros.regimeEspecialTributacao, parametros.percentualTotTribSN, parametros.ambiente]);
    const politica = { parametros, referenciaHash: input.referenciaHash, confirmadoEm: new Date().toISOString(), origem: 'revisao_onboarding', fidelidadeReferencia: Boolean(input.usarReferencia),
      ctribNac: s.ctrib_nac, cnbs: s.cnbs, ctribMun: s.ctrib_mun,
      perfil: { ambiente: parametros.ambiente, opcao: parametros.opcaoSimplesNacional, regime: parametros.regimeApuracaoSn ?? null,
        especial: parametros.regimeEspecialTributacao, municipio: p.cod_municipio_ibge, serie,
        referencia: p.xml_nota_referencia_url } };
    await client.query(`update medico_servicos_fiscais set parametros_emissao = $3
      where id = $1 and medico_id = $2`, [s.id, input.medicoId, JSON.stringify(politica)]);
    await client.query(`insert into auditoria (acao, entidade, entidade_id, dados_anteriores, dados_novos)
      values ('confirmar_parametros_emissao', 'medico_servicos_fiscais', $1, $2, $3)`,
      [s.id, s.parametros_emissao ? JSON.stringify(s.parametros_emissao) : null, JSON.stringify(politica)]);
    if (input.especialidade) {
      await client.query(`update medicos set especialidade = $2, atualizado_em = now()
        where id = $1`, [input.medicoId, input.especialidade]);
    }
    if (input.razaoSocial) await client.query('update medico_perfil_fiscal set razao_social = $2 where medico_id = $1', [input.medicoId, input.razaoSocial]);
    if (input.aliquotaIss !== undefined) {
      if (!Number.isFinite(input.aliquotaIss) || input.aliquotaIss < 0 || input.aliquotaIss > 100) throw new Error('Alíquota inválida.');
      await client.query('update medico_servicos_fiscais set aliquota_iss = $2 where id = $1', [s.id, input.aliquotaIss]);
    }
    await client.query('commit');
  } catch (erro) { await client.query('rollback'); throw erro; }
  finally { client.release(); }
}
