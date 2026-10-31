/**
 * Caso de uso: Processamento individual de um item da fila de emissão de NFS-e.
 * Orquestra tentativas, gravação de nota autorizada, envio do PDF ao paciente
 * e notificações de falha ao médico ou desenvolvedor (seção 3.2, itens 5 a 8).
 */

import { sanitizarErroFiscal } from '../observabilidade/erros.js';
import type { DadosProfissionaisService } from '../conta/dados-profissionais-service.js';
import {
  excedeuTentativasEmissao,
  calcularProximaTentativa
} from './calcular-proxima-tentativa.js';
import type { ItemFilaComTentativas, FilaRepositorio } from './fila-repositorio.js';
import type { EmissorDpsService } from './emissor-dps-service.js';
import type { EnviarPdfDanfse } from '../whatsapp/enviar-pdf-danfse.js';
import type { NotificadorAlertas } from './notificar-erro-medico.js';

export interface ProcessarItemFilaDeps {
  filaRepositorio: FilaRepositorio;
  emissorDps: EmissorDpsService;
  enviarPdfDanfse: EnviarPdfDanfse;
  notificadorAlertas: NotificadorAlertas;
  agora?: () => Date;
  aoAutorizarComprovante?: (item: ItemFilaComTentativas) => Promise<void>;
  dadosProfissionais?: DadosProfissionaisService;
}

export type ResultadoProcessarItem =
  | { ok: true; status: 'emitida'; chaveAcesso: string }
  | { ok: false; status: 'reagendada' | 'erro_definitivo' | 'erro_inesperado' | 'necessita_intervencao' | 'aguardando_dados_profissionais'; motivo?: string };

export async function processarItemFila(
  item: ItemFilaComTentativas,
  deps: ProcessarItemFilaDeps
): Promise<ResultadoProcessarItem> {
  if (item.emissaoComprovante) return processarComprovante(item, deps);
  const dataAtual = deps.agora ? deps.agora() : new Date();
  const tentativaAtual = item.tentativas + 1;

  try {
    const emissao = await deps.emissorDps.emitir(item);
    if (emissao.sucesso) {
      await tratarSucessoEmissao(item, emissao, deps);
      return { ok: true, status: 'emitida', chaveAcesso: emissao.chaveAcesso };
    }
    if (emissao.dadosProfissionaisPendentes) return aguardarDadosProfissionais(item, deps);
    return tratarFalhaEmissao(item, tentativaAtual, emissao.erro, dataAtual, deps, emissao.codigoErroSefin ?? (emissao.httpStatus === 504 || emissao.httpStatus === 408 ? 'SEFIN_TIMEOUT' : emissao.httpStatus && emissao.httpStatus >= 500 || emissao.falhaAntesDoEnvio ? 'SEFIN_INDISPONIVEL' : undefined));
  } catch (erro: any) {
    return tratarExcecaoInesperada(item, tentativaAtual, erro, dataAtual, deps);
  }
}

async function tratarSucessoEmissao(item: ItemFilaComTentativas, emissao: any, deps: ProcessarItemFilaDeps): Promise<void> {
  await deps.filaRepositorio.registrarSucesso({
    solicitacaoId: item.id,
    medicoId: item.medicoId,
    chaveAcesso: emissao.chaveAcesso,
    ndps: emissao.ndps,
    serie: emissao.serie,
    competencia: emissao.competencia,
    dataEmissao: emissao.dataEmissao,
    valorServicosCentavos: emissao.valorServicosCentavos,
    xmlStoragePath: emissao.xmlStoragePath,
    pdfStoragePath: emissao.pdfStoragePath,
    respostaSefinRaw: emissao.respostaSefinRaw,
    ...(item.emissaoComprovante ? { emissaoComprovante: true as const } : {})
  });

  if (item.emissaoComprovante) {
    try { await deps.aoAutorizarComprovante?.(item); } catch { /* Falha de comunicação não desfaz a nota nem libera nova emissão. */ }
    return;
  }
  const contexto = await deps.filaRepositorio.buscarContextoEnvio(item.id);
  if (contexto) {
    await deps.enviarPdfDanfse.enviarPdf({
      instanciaNome: contexto.instanciaNome,
      contatoTelefone: contexto.contatoTelefone,
      pdfPathOuUrl: emissao.pdfStoragePath,
      nomeArquivo: `DANFSe-${emissao.ndps}.pdf`
    });
  }
}

async function tratarFalhaEmissao(
  item: ItemFilaComTentativas,
  tentativaAtual: number,
  erro: string,
  dataAtual: Date,
  deps: ProcessarItemFilaDeps, codigoErro?: string
): Promise<ResultadoProcessarItem> {
  if (excedeuTentativasEmissao(tentativaAtual)) {
    await deps.filaRepositorio.marcarFalhaDefinitiva({ solicitacaoId: item.id, tentativas: tentativaAtual, erro });
    const contexto = await deps.filaRepositorio.buscarContextoEnvio(item.id);
    if (contexto) {
      await deps.notificadorAlertas.notificarMedicoWhatsApp({
        telefoneMedico: contexto.telefoneMedico, medicoId:item.medicoId, solicitacaoId:item.id,
        nomePaciente: contexto.nomePaciente,
        valorCentavos: item.valorServicoCentavos,
        motivoErro: erro, codigoErro
      });
    }
    return { ok: false, status: 'erro_definitivo', motivo: erro };
  }

  const proximaTentativaEm = calcularProximaTentativa(tentativaAtual, dataAtual);
  await deps.filaRepositorio.reagendarTentativa({ solicitacaoId: item.id, tentativas: tentativaAtual, proximaTentativaEm, erro });
  return { ok: false, status: 'reagendada', motivo: erro };
}

async function tratarExcecaoInesperada(
  item: ItemFilaComTentativas,
  tentativaAtual: number,
  erro: any,
  dataAtual: Date,
  deps: ProcessarItemFilaDeps
): Promise<ResultadoProcessarItem> {
  const mensagemErro = erro?.message || 'Erro inesperado';
  await deps.notificadorAlertas.notificarDesenvolvedorEmail({
    assunto: `[NFS-e Alerta] Exceção no processamento da solicitação ${item.id}`,
    detalhesErro: String(erro?.stack || erro),
    solicitacaoId: item.id,
    medicoId: item.medicoId
  });
  return tratarFalhaEmissao(item, tentativaAtual, mensagemErro, dataAtual, deps);
}

async function aguardarDadosProfissionais(item: ItemFilaComTentativas, deps: ProcessarItemFilaDeps): Promise<ResultadoProcessarItem> {
  if (!deps.filaRepositorio.suspenderPorDadosProfissionais) throw new Error('Controle de dados profissionais indisponível.');
  await deps.filaRepositorio.suspenderPorDadosProfissionais(item.id);
  await deps.dadosProfissionais?.retomar(item.medicoId);
  return { ok: false, status: 'aguardando_dados_profissionais' };
}

async function processarComprovante(item: ItemFilaComTentativas, deps: ProcessarItemFilaDeps): Promise<ResultadoProcessarItem> {
  let autorizada = false;
  try {
    const inicio = await deps.filaRepositorio.iniciarEmissaoComprovante?.(item.id);
    if (inicio === 'ocupada') return { ok: false, status: 'necessita_intervencao' };
    if (inicio !== 'iniciada') {
      await avisarFalhaComprovante(item, 'AMBIENTE_FISCAL_BLOQUEADO', deps);
      return { ok: false, status: 'necessita_intervencao', motivo: 'AMBIENTE_FISCAL_BLOQUEADO' };
    }
    const emissao = await deps.emissorDps.emitir(item);
    if (!emissao.sucesso) {
      const codigo = emissao.codigoErroSefin === 'AMBIENTE_FISCAL_BLOQUEADO' ? 'AMBIENTE_FISCAL_BLOQUEADO' : 'EMISSAO_COMPROVANTE_RECUSADA';
      const original = typeof emissao.codigoErroSefin === 'string' ? sanitizarErroFiscal(emissao.codigoErroSefin, [item.tomadorAoVivo?.nome]).slice(0,80) : '';
      await deps.filaRepositorio.registrarFalhaComprovante?.({ solicitacaoId: item.id, erroCodigo: original && original !== codigo ? `${codigo}: ${original}` : codigo });
      await avisarFalhaComprovante(item, codigo, deps, emissao.codigoErroSefin ?? (emissao.httpStatus === 504 || emissao.httpStatus === 408 ? 'SEFIN_TIMEOUT' : emissao.httpStatus && emissao.httpStatus >= 500 || emissao.falhaAntesDoEnvio ? 'SEFIN_INDISPONIVEL' : codigo), item.origemLote ? sanitizarErroFiscal(emissao.erro, [item.tomadorAoVivo?.nome]) : undefined);
      return { ok: false, status: 'necessita_intervencao', motivo: codigo };
    }
    autorizada = true;
    await tratarSucessoEmissao(item, emissao, deps);
    return { ok: true, status: 'emitida', chaveAcesso: emissao.chaveAcesso };
  } catch {
    // Após autorização, conservar a reserva para conciliação, sem nova transmissão.
    const codigo = autorizada ? 'PERSISTENCIA_COMPROVANTE_PENDENTE' : 'EMISSAO_COMPROVANTE_FALHOU';
    if (!autorizada) {
      try { await deps.filaRepositorio.registrarFalhaComprovante?.({ solicitacaoId: item.id, erroCodigo: codigo }); } catch { /* A reserva emitindo impede reenvio. */ }
    }
    try { await avisarFalhaComprovante(item, codigo, deps); } catch { /* A notificação não libera a reserva. */ }
    return { ok: false, status: 'necessita_intervencao', motivo: codigo };
  }
}

async function avisarFalhaComprovante(item: ItemFilaComTentativas, codigo: string, deps: ProcessarItemFilaDeps, codigoErro = codigo, motivoInterno?: string): Promise<void> {
  await deps.notificadorAlertas.notificarMedicoWhatsApp({
    telefoneMedico: '', medicoId: item.medicoId, solicitacaoId: item.id,
    nomePaciente: null, valorCentavos: item.valorServicoCentavos,
    codigoErro, motivoErro: item.origemLote && motivoInterno ? motivoInterno : `${codigo}. Doutor(a), pode revisar os dados fiscais e orientar como prosseguir?`
  });
}
