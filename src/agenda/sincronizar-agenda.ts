import { normalizarResultadoAgenda, type EntradaFonteAgenda, type FonteAgenda, type ConsultaSincronizada, type RepositorioConsultasSincronizadas } from './fonte-agenda.js';

/** O UUID local é usado só na escrita; a seleção fiscal continua recebendo os vínculos originais. */
export async function sincronizarAgenda(entrada: EntradaFonteAgenda, fonte: FonteAgenda, repositorio: RepositorioConsultasSincronizadas, resolverPaciente?: (medicoId: string, consulta: ConsultaSincronizada) => Promise<string>) {
  const resultado = normalizarResultadoAgenda(await fonte.consultar({ medicoId: entrada.medicoId, referenciaCofre: entrada.referenciaCofre, ...(entrada.janelaDias !== undefined ? { janelaDias: entrada.janelaDias } : {}), ...(entrada.agora ? { agora: entrada.agora } : {}) }));
  if (resultado.tipo === 'consultas') {
    const consultas = [];
    for (const consulta of resultado.consultas) consultas.push(resolverPaciente ? { ...consulta, pacienteId: await resolverPaciente(entrada.medicoId, consulta) } : consulta);
    await repositorio.salvar(entrada.medicoId, resultado.fonte, consultas);
  }
  return resultado;
}
