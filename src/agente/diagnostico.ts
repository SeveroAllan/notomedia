import { createHmac } from 'node:crypto';

export type FerramentaNoto = 'continuar_onboarding' | 'registrar_periodo_conferencia' | 'consultar_contexto_conta' | 'consultar_status_agendas' | 'orientar_conexao_agenda' | 'descobrir_profissionais_agenda' | 'solicitar_link_seguro_agenda' | 'consultar_status_entrega_link_agenda' | 'consultar_prontidao_onboarding' | 'orientar_certificado_seguro' | 'confirmar_profissionais_descobertos' | 'confirmar_dados_profissionais' | 'revisar_registro_profissional' | 'solicitar_link_seguro_registro' | 'consultar_panorama_operacional' | 'conferir_atendimentos_e_notas';
export type CodigoFerramenta =
  | 'CONTINUIDADE_SEM_ACAO' | 'CONTINUIDADE_PROCESSADA' | 'PERIODO_REGISTRADO' | 'CONTA_AUTORIZADA' | 'CONTA_NAO_ENCONTRADA'
  | 'STATUS_CONECTADO' | 'STATUS_NAO_CONECTADO' | 'STATUS_PARCIAL'
  | 'STATUS_INDISPONIVEL' | 'INTEGRACAO_NAO_CONFIGURADA' | 'PROFISSIONAL_AMBIGUO'
  | 'PROFISSIONAL_NAO_ENCONTRADO' | 'PROFISSIONAIS_NAO_IDENTIFICADOS' | 'DEPENDENCIA_CONTA'
  | 'DEPENDENCIA_PROFISSIONAL' | 'CONEXAO_EXISTENTE'
  | 'CONEXAO_PENDENTE' | 'FERRAMENTA_INDISPONIVEL' | 'PROFISSIONAIS_ENCONTRADOS'
  | 'SEM_DESCOBERTA' | 'OUTRA_AGENDA' | 'ALVO_AMBIGUO' | 'NOME_NAO_COMPROVADO'
  | 'NAO_AUTORIZOU' | 'ESCLARECIMENTO' | 'LINK_ACEITO_PARA_ENVIO' | 'ENTREGA_CONSULTADA' | 'LINK_ENTREGUE' | 'LINK_LIDO' | 'PRONTIDAO_VERIFICADA' | 'CERTIFICADO_EXISTENTE' | 'CERTIFICADO_PENDENTE' | 'PROFISSIONAIS_CONFIRMADOS' | 'AGENDA_RECUSADA' | 'AGENDA_FORA_DO_FOCO' | 'DEPENDENCIA_CONFIRMACAO' | 'DADOS_PROFISSIONAIS_SALVOS' | 'PANORAMA_FISCAL_CONSULTADO' | 'PANORAMA_FISCAL_INDISPONIVEL' | 'CONFERENCIA_REALIZADA' | 'CONFERENCIA_PENDENTE' | 'TRABALHO_REGISTRADO' | 'TRABALHO_INDISPONIVEL';
export type CodigoExecucao = 'FALA_FORA_CONTRATO' | 'PERIODO_SEM_FERRAMENTA' | 'RESPOSTA_POR_ESTADO' | 'RESPOSTA' | 'CREDENCIAL_BLOQUEADA'
  | 'SEM_MODELO' | 'LIMITE_PROFISSIONAIS' | 'FALLBACK_MODELO' | 'SEM_RESPOSTA' | 'ENTRADA_VAZIA' | 'RESPOSTA_BLOQUEADA' | 'CONFIRMACAO_SEM_FERRAMENTA';

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
  contratoFala?:'VALIDO'|'INVALIDO';
  rejeicaoFala?:'JSON_INVALIDO'|'FORMATO_INVALIDO'|'FATOS_DIVERGENTES'|'ACOES_DIVERGENTES'|'FATOS_E_ACOES_DIVERGENTES'|'RUNNER_INTERROMPIDO';
  continuidade?:{
    intencoes:string[];
    camposConfirmados:('crm'|'rqe')[];
    alvoValido:boolean;
    comparacaoCrm:'NAO_INFORMADO'|'NAO_AVALIADO'|'COINCIDE'|'DIVERGE';
    comparacaoRqe:'NAO_INFORMADO'|'NAO_AVALIADO'|'COINCIDE'|'DIVERGE';
    revisao:'NAO_SOLICITADA'|'ALVO_INVALIDO'|'INTENCOES_CONFLITANTES'|'CRM_NAO_AUTORIZADO'|'REGISTRO_DIVERGENTE'|'JA_CONFIRMADO'|'EXECUTADA_SUCESSO'|'EXECUTADA_FALHA';
    certificado:'NAO_SOLICITADO'|'ALVO_INVALIDO'|'PREPARADO'|'VALIDO'|'RECUSADO';
    acoesConcluidas:string[];
  };
  falha?: { natureza: 'ABORT_SIGNAL'|'MAX_TURNS'|'FALHA_RUNNER' };
  /** Snapshot de entrada usado pelo agente, sem nomes, datas, IDs ou conteúdo livre. */
  estadoOnboarding?:{
    vinculoConfirmadoNaConta:boolean;
    perguntaPendente:'AUSENTE'|'agenda'|'profissional'|'confirmar_profissional'|'periodo'|null;
    periodoRegistrado:boolean;
    crmAdiado:boolean;
    ferramentaPeriodoObrigatoria:boolean;
    ferramentaContinuidadeObrigatoria:boolean;
  };
  /** Apenas forma verificada da pendência: sem nomes, telefone ou IDs. */
  estadoVinculo?: {
    fase:'AUSENTE'|'DESCOBERTA_PENDENTE'|'CONFIRMACAO_PENDENTE'|'VINCULO_CONFIRMADO';
    fonte:'AUSENTE'|'tribemd'|'amplimed';
    quantidadeNomes:number;
    ferramentaObrigatoria:boolean;
  };
}
export interface DiagnosticoMensagem {
  tipo: 'noto_agent_execucao';
  versao: 1;
  mensagemRef: string;
  respostaRef: string;
  linkCertificado?:{produzidos:number;nosBaloes:number;aceitosApi:number};
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
