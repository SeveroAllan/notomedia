/**
 * Portas (interfaces pequenas) da memória conversacional. Mantém o caso de uso
 * desacoplado de Postgres e de OpenAI para permitir testes rápidos em memória.
 */

export type AutorMemoria = 'medico' | 'noto';

export interface MensagemMemoria {
  id: string;
  contaId: string;
  autor: AutorMemoria;
  texto: string;
  diaReferencia: string;
  criadoEm: string;
}

export interface ResumoMemoria {
  id: string;
  contaId: string;
  periodoInicio: string;
  periodoFim: string;
  resumo: string;
  fatosCombinados: string[];
  totalMensagens: number;
  criadoEm: string;
}

export interface ContextoMemoriaAgente {
  turnosCurtoPrazo: string[];
  resumosLongoPrazo: Array<{
    periodo: string;
    resumo: string;
    fatosCombinados: string[];
  }>;
  ultimaInteracaoEm?: string | null;
}

export interface EntradaBuscaMemoria {
  contaId: string;
  termo?: string | null;
  dataInicio?: string | null;
  dataFim?: string | null;
  limite?: number;
}

export interface ResultadoBuscaMemoria {
  resumosEncontrados: Array<{
    periodo: string;
    resumo: string;
    fatosCombinados: string[];
  }>;
  mensagensEncontradas: Array<{
    dia: string;
    autor: AutorMemoria;
    texto: string;
  }>;
}

export interface CompactadorTextoMemoria {
  compactar(entrada: {
    periodoInicio: string;
    periodoFim: string;
    mensagens: readonly MensagemMemoria[];
  }): Promise<{ resumo: string; fatosCombinados: string[] } | null>;
}

export interface MemoriaConversaRepositorio {
  registrarMensagem(entrada: {
    contaId: string;
    autor: AutorMemoria;
    texto: string;
    diaReferencia: string;
  }): Promise<void>;
  listarNaoCompactadas(contaId: string, limite: number): Promise<MensagemMemoria[]>;
  listarRecentesDoDiaOuJanela(
    contaId: string,
    diaAtual: string,
    limite: number
  ): Promise<MensagemMemoria[]>;
  salvarResumoEMarcarCompactadas(entrada: {
    contaId: string;
    periodoInicio: string;
    periodoFim: string;
    resumo: string;
    fatosCombinados: string[];
    mensagemIds: readonly string[];
  }): Promise<ResumoMemoria>;
  listarResumosRecentes(contaId: string, limite: number): Promise<ResumoMemoria[]>;
  buscar(entrada: EntradaBuscaMemoria): Promise<ResultadoBuscaMemoria>;
}
