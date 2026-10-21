import { z } from 'zod';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';

const consultaSchema = z.object({
  pacienteId: z.string().min(1), telefonePaciente: z.string().min(1).optional(), idExterno: z.string().min(1), dataHora: z.string().min(1),
  status: z.enum(['realizada', 'cancelada', 'faltou', 'agendada']),
  valorCobradoAoVivoCentavos: z.number().int().nullable().optional(),
  nomeAoVivo: z.string().trim().min(1).max(200).nullable().optional(),
  valorConsultaCentavos: z.number().int().nullable().optional()
}).strict();
const resultadoSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('consultas'), fonte: z.string().min(1), consultas: z.array(consultaSchema) }).strict(),
  z.object({ tipo: z.literal('erro'), codigo: z.enum(['FONTE_INDISPONIVEL', 'ACESSO_EXPIRADO', 'SEM_AGENDA_CONECTADA', 'SINCRONIZACAO_INCOMPLETA']) }).strict()
]);
export interface EntradaFonteAgenda { medicoId: string; referenciaCofre: string; janelaDias?: number; agora?: Date }
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

/** Não há desempate por nome, preço ou ordem de retorno da fonte. Com dataPagamento, só valem consultas realizadas até o dia do pagamento; duas ou mais exigem escolha do médico. */
export function selecionarConsultaComprovante(consultas: z.infer<typeof consultaSchema>[], telefone: string, faturadas: ReadonlySet<string> = new Set(), dataPagamento?: string | null) {
  const variantes = gerarVariantesTelefoneBrasileiro(telefone);
  const vinculadas = consultas.filter(c => c.telefonePaciente && gerarVariantesTelefoneBrasileiro(c.telefonePaciente).some(t => variantes.includes(t)));
  if (new Set(vinculadas.map(c => c.pacienteId)).size !== 1) return { tipo: 'perguntar_medico' as const, motivo: 'VINCULO_TELEFONE_INDEFINIDO' as const };
  const realizadas = vinculadas.filter(c => c.status === 'realizada' && !faturadas.has(c.idExterno));
  if (!realizadas.length || realizadas.some(c => !Number.isFinite(Date.parse(c.dataHora)))) return { tipo: 'perguntar_medico' as const, motivo: 'CONSULTA_AMBIGUA_OU_AUSENTE' as const };
  if (dataPagamento) {
    const limite = Date.parse(`${dataPagamento}T23:59:59.999-03:00`);
    if (Number.isFinite(limite)) {
      const anteriores = realizadas.filter(c => Date.parse(c.dataHora) <= limite)
        .sort((a, b) => Date.parse(b.dataHora) - Date.parse(a.dataHora));
      if (!anteriores.length) return { tipo: 'perguntar_medico' as const, motivo: 'CONSULTA_APOS_PAGAMENTO' as const };
      if (anteriores.length > 1) return { tipo: 'perguntar_medico' as const, motivo: 'MULTIPLAS_CONSULTAS_SEM_NOTA' as const,
        consultas: anteriores.map(c => ({ dataHora: c.dataHora })) };
      return { tipo: 'consulta' as const, consulta: anteriores[0] };
    }
  }
  realizadas.sort((a, b) => Date.parse(b.dataHora) - Date.parse(a.dataHora));
  if (realizadas[1] && Date.parse(realizadas[0].dataHora) === Date.parse(realizadas[1].dataHora)) return { tipo: 'perguntar_medico' as const, motivo: 'CONSULTA_AMBIGUA_OU_AUSENTE' as const };
  return { tipo: 'consulta' as const, consulta: realizadas[0] };
}

/** Dois contatos válidos diferentes não permitem escolher o destinatário de uma nota. */
export function resolverContatoConsulta(contato?: { celular?: string | null; telefone?: string | null }): string | null {
  const valido = (valor?: string | null) => { const telefone = valor?.replace(/\D/g, '') ?? ''; return /^\d{10,13}$/.test(telefone) ? telefone : null; };
  const celular = valido(contato?.celular), telefone = valido(contato?.telefone);
  if (celular && telefone && celular !== telefone) return null;
  return celular ?? telefone;
}
