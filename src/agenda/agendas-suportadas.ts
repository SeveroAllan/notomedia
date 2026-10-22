/** Agendas que o Noto aceita conectar. Domínios aprovados: o login só é usado neles. */
export const AGENDAS_SUPORTADAS = {
  tribemd: { nome: 'TribeMD', dominios: ['app.tribemd.com', 'tribemd.com'], consentimento: 'tribemd-leitura-v1' },
  amplimed: { nome: 'Amplimed', dominios: ['amplimed.com.br', 'app.amplimed.com.br'], consentimento: 'amplimed-leitura-v1' }
} as const;
export type AgendaSuportada = keyof typeof AGENDAS_SUPORTADAS;

export function agendaSuportada(valor: unknown): AgendaSuportada | null {
  return typeof valor === 'string' && Object.hasOwn(AGENDAS_SUPORTADAS, valor) ? (valor as AgendaSuportada) : null;
}
/** Só HTTPS e domínio exato (ou subdomínio) da lista aprovada. */
export function dominioAprovado(agenda: AgendaSuportada, url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    return AGENDAS_SUPORTADAS[agenda].dominios.some(d => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch { return false; }
}
