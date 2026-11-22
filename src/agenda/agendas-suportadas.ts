/**
 * Catálogo central de agendas médicas suportadas pelo Noto. Unifica agendas
 * dedicadas (TribeMD, Amplimed), agendas pré-definidas lidas pelo subagente
 * navegador adaptativo e a modalidade `personalizada` (URL HTTPS descoberta
 * online antes do envio do link seguro do cofre).
 */

export interface DefinicaoAgendaSuportada {
  readonly nome: string;
  readonly modoLeitura: 'dedicado' | 'adaptativo';
  readonly urlLoginPadrao: string;
  readonly urlAgendaPadrao: string;
  readonly dominios: readonly string[];
  readonly rotasSeguras: readonly string[];
  readonly consentimento: string;
  readonly apelidos: readonly string[];
  readonly permiteUrlPersonalizada?: boolean;
  readonly suportaPeriodoDias: number;
}

export const AGENDAS_SUPORTADAS = {
  tribemd: {
    nome: 'TribeMD',
    modoLeitura: 'dedicado',
    urlLoginPadrao: 'https://app.tribemd.com/',
    urlAgendaPadrao: 'https://app.tribemd.com/atendimentos/agenda',
    dominios: ['app.tribemd.com', 'tribemd.com'],
    rotasSeguras: ['/atendimentos/agenda', '/profissionais', '/profissional', '/medicos'],
    consentimento: 'tribemd-leitura-v1',
    apelidos: ['tribemd', 'tribe md', 'tribe', 'trible'],
    suportaPeriodoDias: 90
  },
  amplimed: {
    nome: 'Amplimed',
    modoLeitura: 'dedicado',
    urlLoginPadrao: 'https://app.amplimed.com.br/',
    urlAgendaPadrao: 'https://app.amplimed.com.br/agenda',
    dominios: ['amplimed.com.br', 'app.amplimed.com.br', 'auth.amplimed.com.br'],
    rotasSeguras: ['/agenda', '/profissionais', '/profissional', '/medicos'],
    consentimento: 'amplimed-leitura-v1',
    apelidos: ['amplimed', 'ampli med'],
    suportaPeriodoDias: 31
  },
  iclinic: {
    nome: 'iClinic (Afya)',
    modoLeitura: 'adaptativo',
    urlLoginPadrao: 'https://app.iclinic.com.br/',
    urlAgendaPadrao: 'https://app.iclinic.com.br/agenda',
    dominios: ['app.iclinic.com.br', 'iclinic.com.br'],
    rotasSeguras: ['/agenda', '/calendario', '/calendar', '/atendimentos', '/pacientes'],
    consentimento: 'iclinic-leitura-v1',
    apelidos: ['iclinic', 'afya iclinic', 'i clinic'],
    suportaPeriodoDias: 31
  },
  gestaods: {
    nome: 'GestãoDS',
    modoLeitura: 'adaptativo',
    urlLoginPadrao: 'https://app.gestaods.com.br/',
    urlAgendaPadrao: 'https://app.gestaods.com.br/agenda',
    dominios: ['app.gestaods.com.br', 'gestaods.com.br'],
    rotasSeguras: ['/agenda', '/calendario', '/atendimentos', '/consultas'],
    consentimento: 'gestaods-leitura-v1',
    apelidos: ['gestaods', 'gestao ds'],
    suportaPeriodoDias: 31
  },
  consultoriogratis: {
    nome: 'Consultório Grátis',
    modoLeitura: 'adaptativo',
    urlLoginPadrao: 'https://consultoriogratis.com.br/',
    urlAgendaPadrao: 'https://consultoriogratis.com.br/agenda',
    dominios: ['consultoriogratis.com.br', 'app.consultoriogratis.com.br', 'sistema.consultoriogratis.com.br'],
    rotasSeguras: ['/agenda', '/calendario', '/consultas', '/atendimentos'],
    consentimento: 'consultoriogratis-leitura-v1',
    apelidos: ['consultoriogratis', 'consultorio gratis'],
    permiteUrlPersonalizada: true,
    suportaPeriodoDias: 31
  },
  eyeclinic: {
    nome: 'Eye Clinic / Eyecare',
    modoLeitura: 'adaptativo',
    urlLoginPadrao: 'https://eyecarebi.eyecarehealth.com.br/',
    urlAgendaPadrao: 'https://eyecarebi.eyecarehealth.com.br/agenda',
    dominios: ['eyecarehealth.com.br', 'eyecarebi.eyecarehealth.com.br', 'eyeclinic.com.br', 'be3.co'],
    rotasSeguras: ['/agenda', '/calendario', '/atendimentos', '/consultas', '/marcacao'],
    consentimento: 'eyeclinic-leitura-v1',
    apelidos: ['eyeclinic', 'eye clinic', 'eyecare'],
    permiteUrlPersonalizada: true,
    suportaPeriodoDias: 31
  },
  feegow: {
    nome: 'Feegow Clinic',
    modoLeitura: 'adaptativo',
    urlLoginPadrao: 'https://app.feegow.com/main/?P=Login&qs=',
    urlAgendaPadrao: 'https://app.feegow.com/',
    dominios: ['app.feegow.com', 'feegow.com', 'core.feegow.com'],
    rotasSeguras: ['/agenda', '/main', '/atendimentos', '/consultas'],
    consentimento: 'feegow-leitura-v1',
    apelidos: ['feegow', 'feegow clinic'],
    suportaPeriodoDias: 31
  },
  ninsaude: {
    nome: 'Ninsaúde (Apolo)',
    modoLeitura: 'adaptativo',
    urlLoginPadrao: 'https://apolo.ninsaude.com/',
    urlAgendaPadrao: 'https://apolo.ninsaude.com/agenda',
    dominios: ['apolo.ninsaude.com', 'ninsaude.com', 'apolo.app'],
    rotasSeguras: ['/agenda', '/calendario', '/atendimentos', '/consultas'],
    consentimento: 'ninsaude-leitura-v1',
    apelidos: ['ninsaude', 'apolo', 'ninsaude apolo'],
    suportaPeriodoDias: 31
  },
  doctoralia: {
    nome: 'Doctoralia Pro',
    modoLeitura: 'adaptativo',
    urlLoginPadrao: 'https://www.doctoralia.com.br/',
    urlAgendaPadrao: 'https://pro.doctoralia.com.br/',
    dominios: ['doctoralia.com.br', 'pro.doctoralia.com.br', 'www.doctoralia.com.br', 'tuotempo.com.br'],
    rotasSeguras: ['/agenda', '/calendar', '/calendario', '/app', '/consultas'],
    consentimento: 'doctoralia-leitura-v1',
    apelidos: ['doctoralia', 'doctoralia pro', 'tuotempo'],
    suportaPeriodoDias: 31
  },
  clinicanasnuvens: {
    nome: 'Clínica nas Nuvens',
    modoLeitura: 'adaptativo',
    urlLoginPadrao: 'https://app.clinicanasnuvens.com.br/',
    urlAgendaPadrao: 'https://app.clinicanasnuvens.com.br/agenda',
    dominios: ['app.clinicanasnuvens.com.br', 'clinicanasnuvens.com.br'],
    rotasSeguras: ['/agenda', '/calendario', '/atendimentos'],
    consentimento: 'clinicanasnuvens-leitura-v1',
    apelidos: ['clinicanasnuvens', 'clinica nas nuvens'],
    suportaPeriodoDias: 31
  },
  shosp: {
    nome: 'Shosp',
    modoLeitura: 'adaptativo',
    urlLoginPadrao: 'https://sistema.shosp.com.br/',
    urlAgendaPadrao: 'https://sistema.shosp.com.br/agenda',
    dominios: ['sistema.shosp.com.br', 'shosp.com.br'],
    rotasSeguras: ['/agenda', '/calendario', '/atendimentos'],
    consentimento: 'shosp-leitura-v1',
    apelidos: ['shosp'],
    suportaPeriodoDias: 31
  },
  personalizada: {
    nome: 'Agenda Web',
    modoLeitura: 'adaptativo',
    urlLoginPadrao: '',
    urlAgendaPadrao: '',
    dominios: [],
    rotasSeguras: ['/agenda', '/calendario', '/calendar', '/atendimentos', '/consultas', '/marcacao', '/painel', '/app'],
    consentimento: 'agenda-generica-leitura-v1',
    apelidos: [],
    permiteUrlPersonalizada: true,
    suportaPeriodoDias: 31
  }
} as const satisfies Record<string, DefinicaoAgendaSuportada>;

export type AgendaSuportada = keyof typeof AGENDAS_SUPORTADAS;
export type AgendaPreDefinida = Exclude<AgendaSuportada, 'personalizada'>;

export interface ResumoAgendaSuportada {
  id: AgendaSuportada;
  nome: string;
  modoLeitura: 'dedicado' | 'adaptativo';
  urlLoginPadrao: string;
  permiteUrlPersonalizada: boolean;
  suportaPeriodoDias: number;
}

export function agendaSuportada(valor: unknown): AgendaSuportada | null {
  return typeof valor === 'string' && Object.hasOwn(AGENDAS_SUPORTADAS, valor) ? (valor as AgendaSuportada) : null;
}

export function obterAgendaSuportada(id: AgendaSuportada): DefinicaoAgendaSuportada {
  return AGENDAS_SUPORTADAS[id];
}

export function listarAgendasSuportadas(): ResumoAgendaSuportada[] {
  return (Object.keys(AGENDAS_SUPORTADAS) as AgendaSuportada[])
    .filter(id => id !== 'personalizada')
    .map(id => {
      const cfg = AGENDAS_SUPORTADAS[id] as DefinicaoAgendaSuportada;
      return {
        id,
        nome: cfg.nome,
        modoLeitura: cfg.modoLeitura,
        urlLoginPadrao: cfg.urlLoginPadrao,
        permiteUrlPersonalizada: Boolean(cfg.permiteUrlPersonalizada),
        suportaPeriodoDias: cfg.suportaPeriodoDias
      };
    });
}

export function hostPrivadoOuLocal(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.local') || h === '::1' || h.includes(':')) return true;
  if (/^(127\.|10\.|192\.168\.|0\.|169\.254\.)/.test(h)) return true;
  return /^172\.(1[6-9]|2\d|3[0-1])\./.test(h);
}

/** Só HTTPS e domínio exato (ou subdomínio) da lista aprovada ou host explícito permitido. */
export function dominioAprovado(agenda: AgendaSuportada, url: string, hostExtra?: string | null): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || hostPrivadoOuLocal(u.hostname)) return false;
    const extra = String(hostExtra || '').trim().toLowerCase();
    if (extra && !hostPrivadoOuLocal(extra) && (u.hostname === extra || u.hostname.endsWith('.' + extra))) {
      return true;
    }
    return AGENDAS_SUPORTADAS[agenda].dominios.some(d => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

export function validarUrlPortalAgenda(
  agenda: AgendaSuportada,
  rawUrl?: string | null
): { ok: true; urlNormalizada: string | null; hostExtra: string | null } | { ok: false; detalheErro: string } {
  const texto = String(rawUrl ?? '').trim();
  if (!texto) {
    if (agenda === 'personalizada') {
      return { ok: false, detalheErro: 'URL HTTPS do portal é obrigatória para agenda personalizada.' };
    }
    return { ok: true, urlNormalizada: null, hostExtra: null };
  }
  let parsed: URL;
  try {
    parsed = new URL(texto);
  } catch {
    return { ok: false, detalheErro: `URL do portal inválida para ${AGENDAS_SUPORTADAS[agenda].nome}: "${texto}".` };
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || hostPrivadoOuLocal(parsed.hostname)) {
    return { ok: false, detalheErro: 'Informe uma URL HTTPS pública válida para o portal da agenda.' };
  }
  const cfg = AGENDAS_SUPORTADAS[agenda] as DefinicaoAgendaSuportada;
  const hostNoCatalogo = cfg.dominios.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d));
  if (!hostNoCatalogo && !cfg.permiteUrlPersonalizada) {
    return { ok: false, detalheErro: `Domínio "${parsed.hostname}" não pertence ao portal oficial de ${cfg.nome}.` };
  }
  return { ok: true, urlNormalizada: parsed.origin + parsed.pathname, hostExtra: parsed.hostname.toLowerCase() };
}
