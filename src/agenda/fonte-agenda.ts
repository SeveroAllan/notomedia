import { z } from 'zod';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';

const consultaSchema = z.object({
  pacienteId: z.string().min(1), telefonePaciente: z.string().min(1).optional(), idExterno: z.string().min(1), dataHora: z.string().min(1),
  status: z.enum(['realizada', 'cancelada', 'faltou', 'agendada']),
  valorConsultaCentavos: z.number().int().nullable().optional()
}).strict();
const resultadoSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('consultas'), fonte: z.string().min(1), consultas: z.array(consultaSchema) }).strict(),
  z.object({ tipo: z.literal('erro'), codigo: z.enum(['FONTE_INDISPONIVEL', 'ACESSO_EXPIRADO', 'SEM_AGENDA_CONECTADA']) }).strict()
]);
export interface EntradaFonteAgenda { medicoId: string; referenciaCofre: string }
export type ResultadoFonteAgenda = z.infer<typeof resultadoSchema>;
export type ConsultaSincronizada = Omit<z.infer<typeof consultaSchema>, 'valorConsultaCentavos'> & { valorConsultaCentavos: number | null };
export interface FonteAgenda { consultar(entrada: EntradaFonteAgenda): Promise<ResultadoFonteAgenda> }
export interface RepositorioConsultasSincronizadas {
  salvar(medicoId: string, fonte: string, consultas: ConsultaSincronizada[]): Promise<void>;
}

/** Pura: restringe os campos ao contrato, sem inferir preço nem situação de conexão. */
export function normalizarResultadoAgenda(resultado: unknown) {
  const dados = resultadoSchema.parse(resultado);
  if (dados.tipo === 'erro') return dados;
  return { ...dados, consultas: dados.consultas.map(consulta => ({ ...consulta, valorConsultaCentavos: consulta.valorConsultaCentavos ?? null })) };
}

/** Não há desempate por nome, preço ou ordem de retorno da fonte. */
export function selecionarConsultaComprovante(consultas: z.infer<typeof consultaSchema>[], telefone: string, faturadas: ReadonlySet<string> = new Set()) {
  const variantes = gerarVariantesTelefoneBrasileiro(telefone);
  const vinculadas = consultas.filter(c => c.telefonePaciente && gerarVariantesTelefoneBrasileiro(c.telefonePaciente).some(t => variantes.includes(t)));
  if (new Set(vinculadas.map(c => c.pacienteId)).size !== 1) return { tipo: 'perguntar_medico' as const, motivo: 'VINCULO_TELEFONE_INDEFINIDO' as const };
  const realizadas = vinculadas.filter(c => c.status === 'realizada' && !faturadas.has(c.idExterno));
  if (!realizadas.length || realizadas.some(c => !Number.isFinite(Date.parse(c.dataHora)))) return { tipo: 'perguntar_medico' as const, motivo: 'CONSULTA_AMBIGUA_OU_AUSENTE' as const };
  realizadas.sort((a, b) => Date.parse(b.dataHora) - Date.parse(a.dataHora));
  if (realizadas[1] && Date.parse(realizadas[0].dataHora) === Date.parse(realizadas[1].dataHora)) return { tipo: 'perguntar_medico' as const, motivo: 'CONSULTA_AMBIGUA_OU_AUSENTE' as const };
  return { tipo: 'consulta' as const, consulta: realizadas[0] };
}
