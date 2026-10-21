import type { TomadorAoVivo } from '../io/fiscal/postgres-emissor-dps-service.js';
import { prepararTomadorAoVivo } from '../io/fiscal/postgres-emissor-dps-service.js';
export interface RepositorioExecucaoLote {
  reservar(): Promise<{ id: string; medicoId: string; conversa: string; totalConsultas: number;
    itens: Array<{ id: string; fonte: string; idExterno: string; chave: string; assinatura: string | null }> } | null>;
  reservarItem(id: string): Promise<boolean>;
  concluirItem(id: string, estado: string): Promise<void>;
  finalizar(id: string, bloqueado?: boolean): Promise<void>;
}
/** Esta etapa só simula: não recebe emissor real, envio de PDF ou gravador de nota_gerada. */
export async function processarLoteRetroativo(repo: RepositorioExecucaoLote, deps: {
  permitido: (medicoId: string) => Promise<boolean>;
  faturada: (medicoId: string, fonte: string, idExterno: string) => Promise<boolean>;
  lerDetalhe: (medicoId: string, idExterno: string) => Promise<TomadorAoVivo>;
  assinatura: (medicoId: string, fonte: string, idExterno: string, valor: number) => string;
  simular: (medicoId: string, dados: TomadorAoVivo) => Promise<{ ok: boolean }>;
  enviar: (medicoId: string, chave: string, fala: string[], conversa: string) => Promise<void>;
  log: (mensagem: string) => void;
}): Promise<boolean> {
  const lote = await repo.reservar();
  if (!lote) return false;
  if (!await deps.permitido(lote.medicoId)) { await repo.finalizar(lote.id, true); return true; }
  let simuladas = 0, semValor = 0, faturadas = 0, divergentes = 0;
  for (const item of lote.itens) {
    if (!item.assinatura) { semValor++; await repo.concluirItem(item.id, 'sem_valor'); continue; }
    if (!await repo.reservarItem(item.id)) { await repo.concluirItem(item.id, 'repetida'); continue; }
    try {
      if (!await deps.permitido(lote.medicoId)) { await repo.concluirItem(item.id, 'erro'); divergentes++; continue; }
      const detalhe = await deps.lerDetalhe(lote.medicoId, item.idExterno);
      // Re-check depois da leitura de rede e imediatamente antes da simulação.
      if (await deps.faturada(lote.medicoId, item.fonte, item.idExterno)) { faturadas++; await repo.concluirItem(item.id, 'ja_faturada'); continue; }
      if (!Number.isSafeInteger(detalhe.valorCobradoCentavos) || detalhe.valorCobradoCentavos! <= 0) { semValor++; await repo.concluirItem(item.id, 'sem_valor'); continue; }
      if (!prepararTomadorAoVivo(detalhe).ok || deps.assinatura(lote.medicoId, item.fonte, item.idExterno, detalhe.valorCobradoCentavos!) !== item.assinatura) {
        divergentes++; await repo.concluirItem(item.id, 'dados_divergentes'); continue;
      }
      const r = await deps.simular(lote.medicoId, detalhe);
      if (r.ok) simuladas++; else divergentes++;
      await repo.concluirItem(item.id, r.ok ? 'simulada' : 'erro');
    } catch {
      divergentes++; await repo.concluirItem(item.id, 'erro');
      deps.log(JSON.stringify({ evento: 'ERRO_NOTO', codigo: 'SIMULACAO_LOTE_FALHOU', categoria: 'tecnico', loteId: lote.id, itemId: item.id }));
    }
  }
  await repo.finalizar(lote.id);
  const fala = [`Simulei ${simuladas} de ${lote.totalConsultas} consultas autorizadas. Nenhuma nota foi emitida ou enviada ao paciente.${faturadas ? ` ${faturadas} já tinham nota e foram puladas.` : ''}${divergentes ? ` ${divergentes} precisam de conferência antes de continuar.` : ''}`];
  if (semValor) fala.push(`${semValor} consultas ficaram de fora por falta de valor. Pode conferir os valores na sua agenda?`);
  await deps.enviar(lote.medicoId, `lote:${lote.id}:resumo`, fala, lote.conversa);
  deps.log(JSON.stringify({ evento: 'LOTE_SIMULADO', loteId: lote.id, simuladas, semValor, faturadas, divergentes }));
  return true;
}
