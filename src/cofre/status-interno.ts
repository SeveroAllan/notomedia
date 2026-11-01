import type { AgendaSuportada } from '../agenda/agendas-suportadas.js';
import type { CofreTribemd } from './tribemd-cofre.js';
import type { CofreAmplimed } from './amplimed-cofre.js';

/** Leitura interna do estado persistido: não cria links, não faz login, não abre porta HTTP
 * e não depende de COFRE_ORIGEM. Erros por fonte são independentes e nunca viram
 * "desconectada" por acidente. O conteúdo privado do Cofre não sai deste módulo. */
export interface EstadoFonteInterna {
  salvo: boolean;
  conectada: boolean;
  consentimentoEm: string | null;
  indisponivel?: boolean;
}

const indisponivel = (): EstadoFonteInterna => ({
  salvo: false, conectada: false, consentimentoEm: null, indisponivel: true
});

export async function consultarStatusAgendasInterno(deps: {
  medicoId: string;
  cofreTribemd?: Pick<CofreTribemd, 'status' | 'consentimentoEm'>;
  cofreAmplimed?: Pick<CofreAmplimed, 'status'>;
  resolver: (medicoId: string, agenda: AgendaSuportada) => Promise<string>;
}): Promise<{ tribemd: EstadoFonteInterna; amplimed: EstadoFonteInterna }> {
  const [tribemd, amplimed] = await Promise.all([
    (async (): Promise<EstadoFonteInterna> => {
      if (!deps.cofreTribemd) return indisponivel();
      try {
        const referencia = await deps.resolver(deps.medicoId, 'tribemd');
        const s = await deps.cofreTribemd.status(referencia);
        const consentimentoEm = await deps.cofreTribemd.consentimentoEm(referencia);
        return {
          salvo: s.salvo,
          conectada: s.salvo && s.ativo && s.estado === 'conectado',
          consentimentoEm
        };
      } catch { return indisponivel(); }
    })(),
    (async (): Promise<EstadoFonteInterna> => {
      if (!deps.cofreAmplimed) return indisponivel();
      try {
        const referencia = await deps.resolver(deps.medicoId, 'amplimed');
        const s = await deps.cofreAmplimed.status(referencia);
        return {
          salvo: s.salvo,
          conectada: s.salvo && s.ativo && s.estado === 'conectado',
          consentimentoEm: s.consentimentoEm
        };
      } catch { return indisponivel(); }
    })()
  ]);
  return { tribemd, amplimed };
}
