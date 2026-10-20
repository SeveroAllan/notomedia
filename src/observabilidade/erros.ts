import { sanitizarTextoMedico } from '../onboarding/contexto-conversa-medico.js';

export const MENSAGEM_INSTABILIDADE = 'Estamos com uma instabilidade no sistema; já vou verificar e te retorno.';
/** Registro consumível por um futuro agente; nunca copiar o detalhe para mensagens. */
export function registroErroNoto(codigo: string, categoria: 'tecnico' | 'acionavel' | 'validacao', contexto: { medicoId?: string; solicitacaoId?: string; etapa?: string; detalhe?: string } = {}): string {
  const seguro = Object.fromEntries(Object.entries(contexto).map(([k, v]) => [k, sanitizarTextoMedico(String(v)).slice(0, 500)]));
  return `NOTO_ERRO ${JSON.stringify({ codigo: /^[A-Z0-9_]{1,80}$/.test(codigo) ? codigo : 'ERRO_NAO_MAPEADO', categoria, contexto: seguro })}`;
}
