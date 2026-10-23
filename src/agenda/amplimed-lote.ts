import { createHash } from 'node:crypto';
import type { ConsultaSincronizada } from './fonte-agenda.js';
import type { TomadorAoVivo } from '../io/fiscal/postgres-emissor-dps-service.js';

/** Elegível lido do Amplimed (finalizado, particular, valor > 0) com o tomador do painel do atendimento. */
export interface ElegivelAmplimed { paciente: string; dataHora: string; idExterno: string; valorCentavos: number; detalhe: { nome: string; cpf: string; celular: string | null } | null }
export interface DiaElegiveisAmplimed { data: string; elegiveis: ElegivelAmplimed[] }

/** O id do Amplimed começa pela data ("2026-10-22T08:00|5199..."): é assim que o lote sabe qual dia reler. */
export const dataDoIdAmplimed = (idExterno: string) => /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}\|/.exec(idExterno)?.[1] ?? null;
export const ehIdAmplimed = (idExterno: string) => dataDoIdAmplimed(idExterno) !== null;

/** Só entram no lote os elegíveis com tomador válido; os demais são contados à parte (o médico é avisado, nada é emitido por eles). */
export function prepararLoteAmplimed(dias: DiaElegiveisAmplimed[]) {
  const consultas: ConsultaSincronizada[] = []; const valoresAoVivo = new Map<string, number | null>(); let semTomador = 0;
  for (const d of dias) for (const e of d.elegiveis) {
    if (!e.detalhe) { semTomador++; continue; }
    const pacienteId = 'amp-' + createHash('sha256').update(e.detalhe.cpf).digest('hex').slice(0, 24);
    consultas.push({ pacienteId, idExterno: e.idExterno, dataHora: e.dataHora, status: 'realizada', valorConsultaCentavos: e.valorCentavos, valorCobradoAoVivoCentavos: e.valorCentavos, nomeAoVivo: e.detalhe.nome,
      ...(e.detalhe.celular ? { telefonePaciente: e.detalhe.celular } : {}) });
    valoresAoVivo.set(e.idExterno, e.valorCentavos);
  }
  return { consultas, valoresAoVivo, semTomador };
}

/** Releitura ao vivo de uma consulta do lote: devolve o tomador só se ela continua finalizada, particular e com tomador válido. */
export function tomadorAmplimedAoVivo(dias: DiaElegiveisAmplimed[], idExterno: string): TomadorAoVivo {
  const e = dias.flatMap(d => d.elegiveis).find(x => x.idExterno === idExterno);
  if (!e?.detalhe) throw Error('DETALHES_NAO_CONCLUIDOS');
  return { nome: e.detalhe.nome, cpf: e.detalhe.cpf, valorCobradoCentavos: e.valorCentavos, contato: { celular: e.detalhe.celular, telefone: null } };
}
