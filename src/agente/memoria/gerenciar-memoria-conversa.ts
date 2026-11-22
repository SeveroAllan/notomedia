/**
 * Caso de uso da memória conversacional em duas camadas:
 * - curto prazo: conversa sanitizada do dia (mantida aberta para continuidade real);
 * - longo prazo: compactação progressiva dos dias anteriores ou excesso do dia;
 * - recuperação: busca sob demanda em resumos + mensagens sanitizadas da conta.
 */

import {
  LIMITE_MENSAGENS_CURTO_PRAZO,
  MAX_RESUMOS_CONTEXTO
} from './memoria-config.js';
import type {
  AutorMemoria,
  CompactadorTextoMemoria,
  ContextoMemoriaAgente,
  EntradaBuscaMemoria,
  MemoriaConversaRepositorio,
  ResultadoBuscaMemoria
} from './memoria-repositorio.js';
import {
  formatarResumosLongoPrazo,
  formatarTurnosCurtoPrazo,
  gerarResumoFallback,
  selecionarMensagensParaCompactar
} from './regras-compactacao.js';
import { diaReferenciaMemoria, sanitizarTextoParaMemoria } from './sanitizar-memoria.js';

export interface ServicoMemoriaConversa {
  registrarMensagem(contaId: string, autor: AutorMemoria, texto: string, agora?: Date): Promise<boolean>;
  carregarContexto(contaId: string, agora?: Date): Promise<ContextoMemoriaAgente>;
  compactarSeNecessario(contaId: string, agora?: Date): Promise<boolean>;
  buscar(entrada: EntradaBuscaMemoria): Promise<ResultadoBuscaMemoria>;
}

export function criarServicoMemoriaConversa(deps: {
  repositorio: MemoriaConversaRepositorio;
  compactador?: CompactadorTextoMemoria | null;
}): ServicoMemoriaConversa {
  async function compactarSeNecessario(contaId: string, agora = new Date()): Promise<boolean> {
    if (!contaId) return false;
    const diaAtual = diaReferenciaMemoria(agora);
    const pendentes = await deps.repositorio.listarNaoCompactadas(contaId, 120);
    const lote = selecionarMensagensParaCompactar(pendentes, diaAtual);
    if (!lote) return false;

    const compactado = await deps.compactador?.compactar(lote).catch(() => null)
      ?? gerarResumoFallback(lote.mensagens);

    await deps.repositorio.salvarResumoEMarcarCompactadas({
      contaId,
      periodoInicio: lote.periodoInicio,
      periodoFim: lote.periodoFim,
      resumo: compactado.resumo,
      fatosCombinados: compactado.fatosCombinados,
      mensagemIds: lote.mensagens.map(m => m.id)
    });
    return true;
  }

  async function registrarMensagem(
    contaId: string,
    autor: AutorMemoria,
    texto: string,
    agora = new Date()
  ): Promise<boolean> {
    if (!contaId) return false;
    const textoSeguro = sanitizarTextoParaMemoria(texto);
    if (!textoSeguro) return false;

    await deps.repositorio.registrarMensagem({
      contaId,
      autor,
      texto: textoSeguro,
      diaReferencia: diaReferenciaMemoria(agora)
    });
    return true;
  }

  async function carregarContexto(
    contaId: string,
    agora = new Date()
  ): Promise<ContextoMemoriaAgente> {
    if (!contaId) return { turnosCurtoPrazo: [], resumosLongoPrazo: [] };
    await compactarSeNecessario(contaId, agora).catch(() => false);

    const diaAtual = diaReferenciaMemoria(agora);
    const [recentes, resumos] = await Promise.all([
      deps.repositorio.listarRecentesDoDiaOuJanela(contaId, diaAtual, LIMITE_MENSAGENS_CURTO_PRAZO),
      deps.repositorio.listarResumosRecentes(contaId, MAX_RESUMOS_CONTEXTO)
    ]);

    return {
      turnosCurtoPrazo: formatarTurnosCurtoPrazo(recentes),
      resumosLongoPrazo: formatarResumosLongoPrazo(resumos),
      ultimaInteracaoEm: recentes.at(-1)?.criadoEm ?? null
    };
  }

  async function buscar(entrada: EntradaBuscaMemoria): Promise<ResultadoBuscaMemoria> {
    if (!entrada.contaId) return { resumosEncontrados: [], mensagensEncontradas: [] };
    return deps.repositorio.buscar(entrada);
  }

  return { registrarMensagem, carregarContexto, compactarSeNecessario, buscar };
}
