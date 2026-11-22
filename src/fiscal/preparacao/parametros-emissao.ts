/**
 * Contrato da política fiscal revisada para um serviço. Não há defaults fiscais:
 * somente opções que o serializador atual consegue representar são aceitas.
 */
import { z } from 'zod';
import { ibscbsSchema } from './ibscbs.js';
const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(`${v}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, 'Data inválida');
export const parametrosEmissaoSchema = z.object({
  ibscbs: ibscbsSchema.optional(),
  ambiente: z.enum(['producao', 'homologacao']),
  vigenciaInicio: data,
  vigenciaFim: data.optional(),
  municipioPrestacao: z.string().regex(/^\d{7}$/),
  opcaoSimplesNacional: z.enum(['nao_optante', 'mei', 'me_epp']),
  regimeApuracaoSn: z.enum(['regime_1', 'regime_2', 'regime_3']).optional(),
  regimeEspecialTributacao: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(9)]),
  tribISSQN: z.literal(1, { error: 'Esta situação de ISSQN exige suporte fiscal adicional; não será substituída por operação tributável.' }),
  tpRetISSQN: z.union([z.literal(1), z.literal(2)], { error: 'Retenção exige suporte a Não Retido (1) ou Retido pelo Tomador (2).' }),
  cstPisCofins: z.enum(['00', '01', '02', '04', '06', '07', '08', '09']).optional(),
  aliquotaIss: z.number().finite().min(0).max(9.99).multipleOf(0.01).optional(),
  totalTributos: z.discriminatedUnion('tipo', [
    z.object({ tipo: z.literal('nao_informado') }).strict(),
    z.object({ tipo: z.literal('percentual'), federal: z.number().finite().min(0).max(100).multipleOf(0.01),
      estadual: z.number().finite().min(0).max(100).multipleOf(0.01), municipal: z.number().finite().min(0).max(100).multipleOf(0.01) }).strict()
  ]).optional(),
  pisCofinsCalculo: z.object({ base: z.literal('valor_servico'), aliquotaPis: z.number().finite().min(0).max(99.99).multipleOf(0.01),
    aliquotaCofins: z.number().finite().min(0).max(99.99).multipleOf(0.01),
    tipoRetencao: z.union([z.literal(0), z.literal(2)]).optional() }).strict().optional(),
  percentualTotTribSN: z.number().finite().min(0).max(100).optional()
}).strict().superRefine((v, ctx) => {
  if (v.vigenciaFim && v.vigenciaFim < v.vigenciaInicio) ctx.addIssue({ code: 'custom', path: ['vigenciaFim'], message: 'Fim anterior ao início' });
  if (v.opcaoSimplesNacional !== 'nao_optante') {
    for (const campo of ['totalTributos', 'pisCofinsCalculo'] as const) {
      if (v[campo] !== undefined) ctx.addIssue({ code: 'custom', path: [campo], message: 'Campo disponível somente para não optante.' });
    }
    if (v.aliquotaIss !== undefined && v.regimeApuracaoSn !== 'regime_2' && v.tpRetISSQN !== 2) {
      ctx.addIssue({ code: 'custom', path: ['aliquotaIss'], message: 'Alíquota de ISS no Simples disponível apenas para ISS fora do Simples ou retenção.' });
    }
    if (['00', '01', '02'].includes(v.cstPisCofins ?? '')) ctx.addIssue({ code: 'custom', path: ['cstPisCofins'], message: 'CST exige suporte adicional neste regime.' });
  }
  if (v.tpRetISSQN === 2 && v.regimeEspecialTributacao === 6) {
    ctx.addIssue({ code: 'custom', path: ['tpRetISSQN'], message: 'Sociedade de profissionais com ISS fixo não admite retenção.' });
  }
  if (v.tpRetISSQN === 2 && v.opcaoSimplesNacional === 'me_epp' && v.aliquotaIss === undefined) {
    ctx.addIssue({ code: 'custom', path: ['aliquotaIss'], message: 'Retenção no Simples Nacional exige declaração da alíquota de ISS a ser retida.' });
  }
  if (v.opcaoSimplesNacional === 'nao_optante') {
    for (const campo of ['regimeApuracaoSn', 'percentualTotTribSN'] as const) {
      if (v[campo] !== undefined) ctx.addIssue({ code: 'custom', path: [campo], message: 'Não informar dados do Simples para não optante.' });
    }
    if (!v.totalTributos) ctx.addIssue({ code: 'custom', path: ['totalTributos'], message: 'Forma de totalização da referência necessária.' });
    const calcula = ['01', '02'].includes(v.cstPisCofins ?? '');
    if (calcula !== Boolean(v.pisCofinsCalculo)) ctx.addIssue({ code: 'custom', path: ['pisCofinsCalculo'], message: 'CST e regra de cálculo de PIS/COFINS precisam coincidir.' });
  } else if (v.opcaoSimplesNacional === 'me_epp') {
    for (const campo of ['regimeApuracaoSn', 'cstPisCofins', 'percentualTotTribSN'] as const) {
      if (v[campo] === undefined) ctx.addIssue({ code: 'custom', path: [campo], message: 'Confirmação necessária para ME/EPP' });
    }
  } else {
    for (const campo of ['regimeApuracaoSn', 'cstPisCofins', 'percentualTotTribSN'] as const) {
      if (v[campo] !== undefined) ctx.addIssue({ code: 'custom', path: [campo], message: 'Não informar para MEI' });
    }
  }
});
export type ParametrosEmissao = z.infer<typeof parametrosEmissaoSchema>;
export interface PoliticaEmissao {
  referenciaHash?: string;
  parametros: ParametrosEmissao;
  confirmadoEm: string;
  origem: 'revisao_onboarding';
  fidelidadeReferencia?: boolean;
  ctribNac: string;
  cnbs: string | null;
  ctribMun: string | null;
  perfil: { ambiente: string; opcao: string; regime: string | null; especial: number; municipio: string; serie: string; referencia: string | null };
}
