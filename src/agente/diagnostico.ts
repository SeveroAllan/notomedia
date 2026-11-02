import { createHmac } from 'node:crypto';

export type FerramentaNoto = 'consultar_contexto_conta' | 'consultar_status_agendas' | 'orientar_conexao_agenda' | 'descobrir_profissionais_agenda' | 'solicitar_link_seguro_agenda' | 'consultar_prontidao_onboarding' | 'orientar_certificado_seguro';
export type CodigoFerramenta =
  | 'CONTA_AUTORIZADA' | 'CONTA_NAO_ENCONTRADA'
  | 'STATUS_CONECTADO' | 'STATUS_NAO_CONECTADO' | 'STATUS_PARCIAL'
  | 'STATUS_INDISPONIVEL' | 'PROFISSIONAL_AMBIGUO'
  | 'PROFISSIONAL_NAO_ENCONTRADO' | 'DEPENDENCIA_CONTA'
  | 'DEPENDENCIA_PROFISSIONAL' | 'CONEXAO_EXISTENTE'
  | 'CONEXAO_PENDENTE' | 'FERRAMENTA_INDISPONIVEL' | 'PROFISSIONAIS_ENCONTRADOS' | 'LINK_ENVIADO' | 'PRONTIDAO_VERIFICADA' | 'CERTIFICADO_EXISTENTE' | 'CERTIFICADO_PENDENTE';
export type CodigoExecucao = 'RESPOSTA' | 'CREDENCIAL_BLOQUEADA'
  | 'SEM_MODELO' | 'LIMITE_PROFISSIONAIS' | 'FALLBACK_MODELO' | 'SEM_RESPOSTA' | 'ENTRADA_VAZIA' | 'RESPOSTA_BLOQUEADA';

export interface EventoFerramenta {
  nome: FerramentaNoto;
  codigo: CodigoFerramenta;
  duracaoMs: number;
}
export interface DiagnosticoAgente {
  codigo: CodigoExecucao;
  ferramentas: EventoFerramenta[];
  uso: {
    requisicoes: number | null;
    tokensEntrada: number | null;
    tokensSaida: number | null;
    tokensTotal: number | null;
  };
  duracaoMs: number;
}
export interface DiagnosticoMensagem {
  tipo: 'noto_agent_execucao';
  versao: 1;
  mensagemRef: string;
  respostaRef: string;
  conta: 'CADASTRADA' | 'SEM_CADASTRO';
  envio: 'ENVIADO' | 'FALHOU';
  agente: DiagnosticoAgente;
}

/** Somente correlação pseudônima com HMAC. Não armazenar telefone, ID bruto,
 * entrada, resposta, nomes, argumentos de ferramentas ou payload da IA. */
export function referenciaDiagnostica(segredo: string, tipo: 'mensagem' | 'resposta', partes: readonly string[]): string {
  const h = createHmac('sha256', segredo);
  h.update(JSON.stringify([tipo, ...partes]));
  return h.digest('hex').slice(0, 24);
}

export function semUso(): DiagnosticoAgente['uso'] {
  return { requisicoes: null, tokensEntrada: null, tokensSaida: null, tokensTotal: null };
}
