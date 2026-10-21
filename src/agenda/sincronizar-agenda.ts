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

/** Dados transitórios: expiram em dez minutos e nunca atravessam médicos ou processos. */
export class CacheAgendaProcesso {
  private readonly leituras = new Map<string, { janelaDias: number; expiraEm: number; timer?: NodeJS.Timeout;
    trabalho: Promise<Awaited<ReturnType<typeof sincronizarAgenda>>> }>();
  invalidar(medicoId: string) {
    clearTimeout(this.leituras.get(medicoId)?.timer);
    this.leituras.delete(medicoId);
  }
  consultar(medicoId: string, janelaDias: number, carregar: () => Promise<Awaited<ReturnType<typeof sincronizarAgenda>>>) {
    const anterior = this.leituras.get(medicoId);
    if (anterior && anterior.expiraEm > Date.now() && anterior.janelaDias >= janelaDias) return anterior.trabalho;
    this.invalidar(medicoId);
    const entrada: NonNullable<ReturnType<typeof this.leituras.get>> = { janelaDias, expiraEm: Infinity, trabalho: Promise.resolve().then(carregar).then(resultado => {
      if (this.leituras.get(medicoId) !== entrada) throw Error('ACESSO_AGENDA_ALTERADO');
      if (resultado.tipo === 'erro') this.invalidar(medicoId);
      else {
        entrada.expiraEm = Date.now() + 600000;
        entrada.timer = setTimeout(() => { if (this.leituras.get(medicoId) === entrada) this.invalidar(medicoId); }, 600000);
        entrada.timer.unref();
      }
      return resultado;
    }).catch(erro => { if (this.leituras.get(medicoId) === entrada) this.invalidar(medicoId); throw erro; }) };
    this.leituras.set(medicoId, entrada);
    return entrada.trabalho;
  }
}
