import { config } from '../config.js';
import type { ResultadoFonteAgenda } from '../agenda/fonte-agenda.js';
import type { EstadoMedicoAposOnboarding, ProximaAcaoNoto } from './regras/decidir-proxima-acao.js';
import { auditarComprovante, chaveComprovante, decidirPedidoComprovante, type AuditoriaComprovante, type EstadoPedidoComprovante,
  type ResultadoExtracaoComprovante, type DecisaoPedidoComprovante } from '../atendimento/comprovante.js';

export type ModoComunicacao = 'simulado' | 'real';
type RespostaNota = NonNullable<EstadoMedicoAposOnboarding['historico']['perguntaNota']['resposta']>;
export type HistoricoComunicacao = EstadoMedicoAposOnboarding['historico'] & {
  boasVindasEm: string | null;
  respostaRecebidaEm: string | null;
  problemaFiscal: { feitaEm: string | null; repeticoes: number };
  registros: Array<{
    modo: ModoComunicacao;
    chaveProcessamento: string;
    tipo: ProximaAcaoNoto['tipo'];
    pergunta?: 'nota_pendente' | 'agenda' | 'problema_fiscal';
    quando: string;
    estado?: 'enviado';
  }>;
  envios: Array<{ chaveProcessamento: string; tipo: ProximaAcaoNoto['tipo']; baloesEnviados: number[] }>;
};

export interface HistoricoComunicacaoRepositorio {
  ler(medicoId: string, modo: ModoComunicacao): Promise<HistoricoComunicacao>;
  /** Reserva exclusiva por médico/modo; a chave fica consumida mesmo se uma gravação posterior falhar. */
  reservar(medicoId: string, modo: ModoComunicacao, chaveProcessamento: string): Promise<boolean>;
  gravarAcao(medicoId: string, modo: ModoComunicacao, chaveProcessamento: string, acao: ProximaAcaoNoto, quando: string): Promise<void>;
  gravarResposta(medicoId: string, modo: ModoComunicacao, resposta: RespostaNota, quando: string): Promise<void>;
  liberar(medicoId: string, modo: ModoComunicacao, chaveProcessamento: string): Promise<void>;
  reservarEnvio(medicoId: string, chaveProcessamento: string, acao: ProximaAcaoNoto): Promise<boolean>;
  confirmarBalao(medicoId: string, chaveProcessamento: string, indice: number): Promise<void>;
  lerComprovantes(medicoId: string): Promise<AuditoriaComprovante[]>;
  registrarComprovante(estado: EstadoPedidoComprovante, lido: ResultadoExtracaoComprovante | null, agenda?: ResultadoFonteAgenda): Promise<DecisaoPedidoComprovante>;
}

export interface EntradaMedico {
  historico: HistoricoComunicacao;
  processamentos: Set<string>;
  reserva: string | null;
}

/** Implementação local: não fornece persistência entre reinícios nem trava entre processos. */
export class HistoricoComunicacaoEmMemoria implements HistoricoComunicacaoRepositorio {
  constructor(private medicos = new Map<string, EntradaMedico>(), private readonly pepper = config.appPepper) {}
  private comprovantes = new Map<string, AuditoriaComprovante[]>();

  async lerComprovantes(medicoId: string): Promise<AuditoriaComprovante[]> {
    return structuredClone(this.comprovantes.get(medicoId) ?? []);
  }

  async registrarComprovante(estado: EstadoPedidoComprovante, lido: ResultadoExtracaoComprovante | null, agenda?: ResultadoFonteAgenda): Promise<DecisaoPedidoComprovante> {
    const anteriores = this.comprovantes.get(estado.medicoId) ?? [];
    // Sem await entre leitura, deduplicação e gravação: decisão e auditoria são atômicas nesta memória.
    const decisao = decidirPedidoComprovante(lido, estado, anteriores.some(r => r.lido?.tipo === 'extraido' && r.lido.campos.comprovanteHash === chaveComprovante(this.pepper, lido)) ? [lido] : [], agenda);
    this.comprovantes.set(estado.medicoId, [...anteriores, structuredClone(auditarComprovante(this.pepper, estado, lido, decisao))]);
    return structuredClone(decisao);
  }

  async ler(medicoId: string, modo: ModoComunicacao): Promise<HistoricoComunicacao> {
    return structuredClone(this.obterMedico(medicoId, modo).historico);
  }

  async reservar(medicoId: string, modo: ModoComunicacao, chaveProcessamento: string): Promise<boolean> {
    const medico = this.obterMedico(medicoId, modo);
    if (medico.reserva !== null || medico.processamentos.has(chaveProcessamento)) return false;
    medico.reserva = chaveProcessamento;
    medico.processamentos.add(chaveProcessamento);
    return true;
  }

  async gravarAcao(medicoId: string, modo: ModoComunicacao, chaveProcessamento: string, acao: ProximaAcaoNoto, quando: string): Promise<void> {
    const medico = this.obterMedico(medicoId, modo);
    if (medico.reserva !== chaveProcessamento) throw new Error('COMUNICACAO_SEM_RESERVA');
    if (acao.tipo === 'nenhuma' || medico.historico.registros.some(registro => registro.chaveProcessamento === chaveProcessamento)) return;
    const historico = structuredClone(medico.historico);
    switch (acao.tipo) {
      case 'boas_vindas':
        historico.boasVindasComunicadas = true; historico.boasVindasEm = quando; break;
      case 'perguntar_nota_pendente':
        historico.perguntaNota.feitaEm = quando; break;
      case 'pedir_agenda':
        historico.perguntaAgenda.feitaEm = quando; break;
      case 'problema_fiscal':
        historico.problemaFiscalComunicado = true; historico.problemaFiscal = { feitaEm: quando, repeticoes: 0 }; break;
      case 'agenda_nao_atendida':
        historico.agendasNaoAtendidasComunicadas.push(acao.agenda); break;
      case 'listar_consultas_sem_nota':
        historico.consultasListadas = true; break;
      case 'aguardar_comprovante':
        historico.aguardandoComprovanteComunicado = true; break;
      case 'reperguntar': {
        const pergunta = acao.pergunta === 'problema_fiscal' ? 'problemaFiscal'
          : acao.pergunta === 'agenda' ? 'perguntaAgenda' : 'perguntaNota';
        historico[pergunta].repeticoes++; break;
      }
    }
    historico.registros.push({ modo, chaveProcessamento, tipo: acao.tipo, quando,
      ...(modo === 'real' ? { estado: 'enviado' as const } : {}),
      ...(acao.tipo === 'reperguntar' ? { pergunta: acao.pergunta } : {}) });
    medico.historico = historico;
  }

  async gravarResposta(medicoId: string, modo: ModoComunicacao, resposta: RespostaNota, quando: string): Promise<void> {
    const historico = this.obterMedico(medicoId, modo).historico;
    historico.perguntaNota.resposta = structuredClone(resposta);
    historico.respostaRecebidaEm = quando;
  }

  async liberar(medicoId: string, modo: ModoComunicacao, chaveProcessamento: string): Promise<void> {
    const medico = this.obterMedico(medicoId, modo);
    if (medico.reserva === chaveProcessamento) medico.reserva = null;
  }

  async reservarEnvio(medicoId: string, chaveProcessamento: string, acao: ProximaAcaoNoto): Promise<boolean> {
    const medico = this.obterMedico(medicoId, 'real');
    if (medico.reserva !== chaveProcessamento) throw new Error('COMUNICACAO_SEM_RESERVA');
    // Mantém a ação reservada após falha: entrega incerta não autoriza reenvio.
    if (medico.historico.envios.some(envio => envio.tipo === acao.tipo)) return false;
    medico.historico.envios.push({ chaveProcessamento, tipo: acao.tipo, baloesEnviados: [] });
    return true;
  }

  async confirmarBalao(medicoId: string, chaveProcessamento: string, indice: number): Promise<void> {
    const medico = this.obterMedico(medicoId, 'real');
    const envio = medico.historico.envios.find(item => item.chaveProcessamento === chaveProcessamento);
    if (medico.reserva !== chaveProcessamento || !envio || indice !== envio.baloesEnviados.length) {
      throw new Error('COMUNICACAO_CONFIRMACAO_INVALIDA');
    }
    envio.baloesEnviados.push(indice);
  }

  private obterMedico(medicoId: string, modo: ModoComunicacao): EntradaMedico {
    const chave = JSON.stringify([medicoId, modo]);
    let medico = this.medicos.get(chave);
    if (medico) return medico;
    medico = {
      reserva: null, processamentos: new Set(),
      historico: {
        boasVindasEm: null, respostaRecebidaEm: null,
        boasVindasComunicadas: false, problemaFiscalComunicado: false,
        problemaFiscal: { feitaEm: null, repeticoes: 0 },
        perguntaNota: { feitaEm: null, repeticoes: 0, resposta: null },
        perguntaAgenda: { feitaEm: null, repeticoes: 0 },
        agendasNaoAtendidasComunicadas: [], consultasListadas: false, aguardandoComprovanteComunicado: false,
        registros: [], envios: []
      }
    };
    this.medicos.set(chave, medico);
    return medico;
  }
}
