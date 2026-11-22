/**
 * Orquestrador dos fluxos de emissão via WhatsApp (comprovantes de pacientes,
 * comprovantes encaminhados pelo médico, pedidos diretos, coleta de CPF,
 * aprendizado de pagadores secundários e entrega da DANFSE autorizada).
 * Depende apenas de portas injetadas para permanecer 100% testável em memória.
 */

import type { AtendimentoAgendaResumo } from '../agenda/filtrar-atendimentos-agenda.js';
import { formatarDataBr } from '../agenda/filtrar-atendimentos-agenda.js';
import type { PreferenciasEmissaoConta } from '../conta/preferencias-emissao.js';
import type { DadosComprovanteExtraido } from '../midia/midia-tipos.js';
import { gerarHashCpf } from '../paciente/hash-cpf.js';
import { validarCpf } from '../paciente/validar-cpf.js';
import type {
  CasoEmissaoRegistro,
  CasoEmissaoRepositorio,
  ChaveMensagemCaso,
  EstadoCasoEmissao
} from './caso-emissao-repositorio.js';
import {
  gerarChaveIdempotenciaComprovante,
  gerarChaveIdempotenciaPedido,
  resumirCasoParaAgente
} from './chave-idempotencia-emissao.js';
import {
  cruzarComprovanteComAgenda,
  JANELA_DIAS_BUSCA_COMPROVANTE,
  normalizarNomeParaBusca
} from './cruzar-comprovante-agenda.js';
import {
  decidirProximoPassoEmissao,
  type ProntidaoFiscalEmissao
} from './decidir-proximo-passo-emissao.js';
import {
  extrairCpfValidoDaMensagem,
  formatarValorReais
} from './extrair-cpf-mensagem.js';
import type { DadosPacienteConhecido } from './buscar-historico-paciente-conta.js';
import type { ResultadoEnfileirarEmissaoWhatsapp } from './enfileirar-emissao-whatsapp.js';
import {
  deslocarDiasIso,
  hojeSp,
  mapearEstadoDecisao,
  montarAvisoEnfileiradaMedico,
  montarAvisoMedicoPendente,
  montarMensagemPedidoCpfPaciente,
  montarResumoEntregaNotaMedico
} from './regras/formatar-mensagens-emissao.js';

export interface DetalheAtendimentoAoVivo {
  nome?: string | null;
  cpf?: string | null;
  telefone?: string | null;
  valorCentavos?: number | null;
}

export interface ContextoOperacionalConta {
  medicoPadraoId: string | null;
  telefoneMedico: string | null;
  instanciaConsultorio: string | null;
  preferencias: PreferenciasEmissaoConta;
  prontidaoFiscal: ProntidaoFiscalEmissao;
}

export interface OrquestradorEmissaoDeps {
  repositorio: CasoEmissaoRepositorio;
  pepper: string;
  obterContextoConta: (contaId: string) => Promise<ContextoOperacionalConta>;
  obterAtendimentosAgenda: (contaId: string, inicioIso: string, fimIso: string) => Promise<AtendimentoAgendaResumo[]>;
  obterDetalheAtendimento?: (contaId: string, atendimentoId: string) => Promise<DetalheAtendimentoAoVivo | null>;
  buscarPacienteConhecido?: (entrada: {
    contaId: string;
    pacienteNome?: string | null;
    pacienteTelefone?: string | null;
  }) => Promise<DadosPacienteConhecido | null>;
  enfileirarEmissao: (caso: CasoEmissaoRegistro) => Promise<ResultadoEnfileirarEmissaoWhatsapp>;
  enviarTextoMedico: (contaId: string, telefone: string, texto: string) => Promise<boolean>;
  enviarPdfMedico?: (contaId: string, telefone: string, pdfBase64: string, nomeArquivo: string, legenda: string) => Promise<boolean>;
  enviarTextoConsultorio?: (instancia: string, telefonePaciente: string, texto: string) => Promise<boolean>;
  enviarPdfConsultorio?: (instancia: string, telefonePaciente: string, pdfBase64: string, nomeArquivo: string, legenda: string) => Promise<boolean>;
  reagirMensagemMedico?: (chave: ChaveMensagemCaso, emoji: '✅') => Promise<boolean>;
  agora?: () => Date;
}

export interface ResultadoOperacaoEmissao {
  ok: boolean;
  acao:
    | 'duplicado'
    | 'esclarecer_com_medico'
    | 'solicitar_cpf_paciente'
    | 'solicitar_cpf_medico'
    | 'aguardar_aprovacao_medico'
    | 'aguardar_prontidao_fiscal'
    | 'enfileirada'
    | 'cancelada'
    | 'erro';
  motivo?: string;
  caso?: ReturnType<typeof resumirCasoParaAgente>;
  candidatos?: Array<{ paciente: string; data: string; valorFormatado: string }>;
  pagadorSecundarioSugerido?: { pagadorNome: string };
  valorSugeridoCentavos?: number;
  valorSugeridoFormatado?: string;
  reenfileirados?: number;
  pacientesReenfileirados?: string[];
}

export function criarOrquestradorEmissaoConta(deps: OrquestradorEmissaoDeps) {
  const agoraFn = () => deps.agora?.() ?? new Date();

  async function finalizarDecisao(
    caso: CasoEmissaoRegistro,
    ctx: ContextoOperacionalConta,
    opcoes: {
      matchAmbiguoOuDivergente?: boolean;
      notificarMedico?: boolean;
      valorSugeridoCentavos?: number | null;
    } = {}
  ): Promise<ResultadoOperacaoEmissao> {
    const decisao = decidirProximoPassoEmissao({
      pacienteNome: caso.pacienteNome,
      pacienteCpf: caso.pacienteCpf,
      pacienteTelefone: caso.pacienteTelefone,
      valorCentavos: caso.valorCentavos,
      dataConsulta: caso.dataConsulta,
      matchAmbiguoOuDivergente: Boolean(opcoes.matchAmbiguoOuDivergente),
      aprovadoPeloMedico: caso.aprovadoPeloMedico,
      instanciaConsultorioConectada: Boolean(ctx.instanciaConsultorio),
      preferencias: ctx.preferencias,
      prontidaoFiscal: ctx.prontidaoFiscal
    });

    if (decisao.acao === 'pronto_para_enfileirar') {
      const enf = await deps.enfileirarEmissao(caso);
      if (!enf.ok) {
        const estadoFalha: EstadoCasoEmissao = enf.motivo === 'CERTIFICADO_A1_PENDENTE'
          || enf.motivo === 'DADOS_FISCAIS_PENDENTES'
          || enf.motivo === 'PRODUCAO_NAO_LIBERADA'
          ? 'aguardando_prontidao_fiscal'
          : 'erro';
        const atualizado = (await deps.repositorio.atualizar(caso.contaId, caso.id, { estado: estadoFalha, erroMotivo: enf.motivo })) ?? caso;
        return {
          ok: estadoFalha === 'aguardando_prontidao_fiscal',
          acao: estadoFalha === 'aguardando_prontidao_fiscal' ? 'aguardar_prontidao_fiscal' : 'erro',
          motivo: enf.motivo,
          caso: resumirCasoParaAgente(atualizado)
        };
      }
      const atualizado = (await deps.repositorio.atualizar(caso.contaId, caso.id, {
        estado: 'enfileirada',
        solicitacaoId: enf.solicitacaoId,
        aprovadoPeloMedico: true
      })) ?? caso;
      if (opcoes.notificarMedico && ctx.telefoneMedico) {
        await deps.enviarTextoMedico(
          caso.contaId,
          ctx.telefoneMedico,
          montarAvisoEnfileiradaMedico(atualizado, enf.ambiente)
        );
      }
      return { ok: true, acao: 'enfileirada', caso: resumirCasoParaAgente(atualizado) };
    }

    const novoEstado = mapearEstadoDecisao(decisao);
    const atualizado = (await deps.repositorio.atualizar(caso.contaId, caso.id, { estado: novoEstado })) ?? caso;

    if (decisao.acao === 'solicitar_cpf_paciente' && ctx.instanciaConsultorio && atualizado.pacienteTelefone && deps.enviarTextoConsultorio) {
      await deps.enviarTextoConsultorio(
        ctx.instanciaConsultorio,
        atualizado.pacienteTelefone,
        montarMensagemPedidoCpfPaciente(atualizado.pacienteNome)
      );
      if (opcoes.notificarMedico && ctx.telefoneMedico) {
        await deps.enviarTextoMedico(
          caso.contaId,
          ctx.telefoneMedico,
          `Recebi o comprovante de ${formatarValorReais(atualizado.valorCentavos)} de ${atualizado.pacienteNome}. Como faltava o CPF, já pedi direto para o paciente no seu WhatsApp.`
        );
      }
      return { ok: true, acao: 'solicitar_cpf_paciente', caso: resumirCasoParaAgente(atualizado) };
    }

    if (opcoes.notificarMedico && ctx.telefoneMedico) {
      const msg = montarAvisoMedicoPendente(decisao, atualizado);
      if (msg) await deps.enviarTextoMedico(caso.contaId, ctx.telefoneMedico, msg);
    }

    return {
      ok: true,
      acao: decisao.acao,
      ...('motivo' in decisao ? { motivo: decisao.motivo } : {}),
      ...(opcoes.valorSugeridoCentavos && decisao.acao === 'esclarecer_com_medico' && decisao.motivo === 'VALOR_AUSENTE'
        ? {
            valorSugeridoCentavos: opcoes.valorSugeridoCentavos,
            valorSugeridoFormatado: formatarValorReais(opcoes.valorSugeridoCentavos)
          }
        : {}),
      caso: resumirCasoParaAgente(atualizado)
    };
  }

  return {
    async processarComprovanteRecebido(entrada: {
      contaId: string;
      origem: 'comprovante_paciente' | 'comprovante_medico';
      comprovante: DadosComprovanteExtraido;
      mensagemId: string;
      telefoneRemetente?: string | null;
      chaveMensagemMedico?: ChaveMensagemCaso | null;
    }): Promise<ResultadoOperacaoEmissao> {
      const chave = gerarChaveIdempotenciaComprovante(entrada.comprovante, entrada.mensagemId);
      const jaExiste = await deps.repositorio.buscarPorChaveIdempotencia(entrada.contaId, chave);
      if (jaExiste && ['enfileirada', 'emitida'].includes(jaExiste.estado)) {
        return { ok: true, acao: 'duplicado', motivo: 'COMPROVANTE_JA_PROCESSADO', caso: resumirCasoParaAgente(jaExiste) };
      }

      const ctx = await deps.obterContextoConta(entrada.contaId);
      const hoje = hojeSp(agoraFn());
      const dataBase = entrada.comprovante.dataPagamento ?? hoje;
      const inicioBusca = deslocarDiasIso(dataBase, -JANELA_DIAS_BUSCA_COMPROVANTE);
      const [atendimentos, emitidas, secundarios] = await Promise.all([
        deps.obterAtendimentosAgenda(entrada.contaId, inicioBusca, hoje).catch(() => []),
        deps.repositorio.listarChavesConsultasComNota(entrada.contaId),
        deps.repositorio.listarPagadoresSecundarios(entrada.contaId)
      ]);
      const cpfPagadorHash = entrada.comprovante.cpfPagador
        ? gerarHashCpf(entrada.comprovante.cpfPagador, deps.pepper)
        : null;

      const cruzamento = cruzarComprovanteComAgenda({
        comprovante: entrada.comprovante,
        dataReferenciaIso: hoje,
        atendimentosAgenda: atendimentos,
        chavesJaEmitidas: emitidas,
        pagadoresSecundarios: secundarios,
        telefoneRemetente: entrada.telefoneRemetente,
        cpfPagadorHash
      });

      const notificarMedico = entrada.origem === 'comprovante_paciente';

      if (cruzamento.tipo !== 'encontrado_unico') {
        const caso = await deps.repositorio.criar({
          contaId: entrada.contaId,
          medicoId: ctx.medicoPadraoId,
          origem: entrada.origem,
          chaveIdempotencia: chave,
          estado: 'aguardando_esclarecimento',
          pacienteTelefone: entrada.origem === 'comprovante_paciente' ? entrada.telefoneRemetente : null,
          pagadorNome: entrada.comprovante.nomePagador,
          pagadorCpf: entrada.comprovante.cpfPagador,
          dataConsulta: entrada.comprovante.dataPagamento,
          valorCentavos: entrada.comprovante.valorCentavos,
          ambiente: ctx.prontidaoFiscal.ambiente,
          origemMensagemChave: entrada.chaveMensagemMedico ?? null
        });
        const candidatos = (cruzamento.tipo === 'ambiguo' ? cruzamento.candidatos : cruzamento.consultasRecentesSemNota)
          .map(c => ({ paciente: c.paciente, data: formatarDataBr(c.data), valorFormatado: formatarValorReais(c.valorCentavos) }));
        if (notificarMedico && ctx.telefoneMedico) {
          const nomePag = entrada.comprovante.nomePagador || 'um pagador';
          await deps.enviarTextoMedico(
            entrada.contaId,
            ctx.telefoneMedico,
            `Recebi um comprovante de ${formatarValorReais(entrada.comprovante.valorCentavos)} de ${nomePag}, mas não achei uma consulta sem nota com esse nome nos últimos dias. De qual paciente é esse pagamento? Se quiser, já salvo como pagador secundário.`
          );
        }
        return {
          ok: true,
          acao: 'esclarecer_com_medico',
          motivo: cruzamento.motivo,
          caso: resumirCasoParaAgente(caso),
          candidatos,
          ...(entrada.comprovante.nomePagador ? { pagadorSecundarioSugerido: { pagadorNome: entrada.comprovante.nomePagador } } : {})
        };
      }

      const atend = cruzamento.atendimento;
      const detalhe = atend.atendimentoId && deps.obterDetalheAtendimento
        ? await deps.obterDetalheAtendimento(entrada.contaId, atend.atendimentoId).catch(() => null)
        : null;
      const usarCpfPagador = cruzamento.pagadorSecundarioUsado?.emitirNoCpfDe === 'pagador'
        || cruzamento.origemMatch === 'nome_pagador';
      let cpfResolvido = detalhe?.cpf && validarCpf(detalhe.cpf)
        ? detalhe.cpf.replace(/\D/g, '')
        : usarCpfPagador && entrada.comprovante.cpfPagador
          ? entrada.comprovante.cpfPagador
          : null;
      let telefoneResolvido = detalhe?.telefone
        || cruzamento.pagadorSecundarioUsado?.pacienteTelefone
        || (entrada.origem === 'comprovante_paciente' ? entrada.telefoneRemetente : null)
        || null;
      const nomeResolvido = detalhe?.nome || atend.paciente;
      if ((!cpfResolvido || !telefoneResolvido) && deps.buscarPacienteConhecido) {
        const conhecido = await deps.buscarPacienteConhecido({
          contaId: entrada.contaId,
          pacienteNome: nomeResolvido,
          pacienteTelefone: telefoneResolvido
        }).catch(() => null);
        if (!cpfResolvido && conhecido?.cpf && validarCpf(conhecido.cpf)) cpfResolvido = conhecido.cpf;
        if (!telefoneResolvido && conhecido?.telefone) telefoneResolvido = conhecido.telefone;
      }

      const caso = await deps.repositorio.criar({
        contaId: entrada.contaId,
        medicoId: ctx.medicoPadraoId,
        origem: entrada.origem,
        chaveIdempotencia: chave,
        estado: 'aguardando_aprovacao_medico',
        pacienteNome: nomeResolvido,
        pacienteTelefone: telefoneResolvido,
        pacienteCpf: cpfResolvido,
        pagadorNome: entrada.comprovante.nomePagador,
        pagadorCpf: entrada.comprovante.cpfPagador,
        atendimentoExternoId: atend.atendimentoId ?? null,
        dataConsulta: atend.data.slice(0, 10),
        valorCentavos: entrada.comprovante.valorCentavos ?? detalhe?.valorCentavos ?? atend.valorCentavos ?? null,
        aprovadoPeloMedico: false,
        ambiente: ctx.prontidaoFiscal.ambiente,
        origemMensagemChave: entrada.chaveMensagemMedico ?? null
      });

      return finalizarDecisao(caso, ctx, { matchAmbiguoOuDivergente: cruzamento.valorDivergente, notificarMedico });
    },

    async prepararEmissaoPeloMedico(entrada: {
      contaId: string;
      pacienteNome: string;
      dataConsulta?: string | null;
      valorCentavos?: number | null;
      pacienteCpf?: string | null;
      pacienteTelefone?: string | null;
      atendimentoExternoId?: string | null;
      jaDetalhado?: boolean;
      aprovadoAgora?: boolean;
      chaveMensagemMedico?: ChaveMensagemCaso | null;
    }): Promise<ResultadoOperacaoEmissao> {
      const ctx = await deps.obterContextoConta(entrada.contaId);
      const hoje = hojeSp(agoraFn());
      let alvo: AtendimentoAgendaResumo | null = null;
      let detalhe: DetalheAtendimentoAoVivo | null = null;

      if (!entrada.jaDetalhado) {
        const inicioBusca = deslocarDiasIso(entrada.dataConsulta ?? hoje, -JANELA_DIAS_BUSCA_COMPROVANTE);
        const [atendimentos, emitidas] = await Promise.all([
          deps.obterAtendimentosAgenda(entrada.contaId, inicioBusca, hoje).catch(() => []),
          deps.repositorio.listarChavesConsultasComNota(entrada.contaId)
        ]);
        const busca = normalizarNomeParaBusca(entrada.pacienteNome);
        alvo = atendimentos
          .filter(a => normalizarNomeParaBusca(a.paciente).includes(busca) || busca.includes(normalizarNomeParaBusca(a.paciente)))
          .filter(a => !entrada.dataConsulta || a.data.slice(0, 10) === entrada.dataConsulta.slice(0, 10))
          .filter(a => !(a.atendimentoId && emitidas.has(a.atendimentoId)))
          .sort((a, b) => b.data.localeCompare(a.data))[0] ?? null;

        if (alvo?.atendimentoId && deps.obterDetalheAtendimento && (!entrada.pacienteCpf || !entrada.valorCentavos)) {
          detalhe = await deps.obterDetalheAtendimento(entrada.contaId, alvo.atendimentoId).catch(() => null);
        }
      }

      const dataConsulta = entrada.dataConsulta?.slice(0, 10) ?? alvo?.data.slice(0, 10) ?? hoje;
      const valorCentavos = entrada.valorCentavos ?? detalhe?.valorCentavos ?? alvo?.valorCentavos ?? null;
      let cpfLimpo = entrada.pacienteCpf?.replace(/\D/g, '') || detalhe?.cpf?.replace(/\D/g, '') || alvo?.cpf?.replace(/\D/g, '') || null;
      let telefoneFinal = entrada.pacienteTelefone ?? detalhe?.telefone ?? alvo?.telefone ?? null;
      const nomeFinal = detalhe?.nome || alvo?.paciente || entrada.pacienteNome.trim();
      const atendimentoExternoId = entrada.atendimentoExternoId ?? alvo?.atendimentoId ?? null;
      let valorSugeridoCentavos: number | null = null;

      if ((!cpfLimpo || !validarCpf(cpfLimpo) || !telefoneFinal || !valorCentavos) && deps.buscarPacienteConhecido) {
        const conhecido = await deps.buscarPacienteConhecido({
          contaId: entrada.contaId,
          pacienteNome: nomeFinal,
          pacienteTelefone: telefoneFinal
        }).catch(() => null);
        if ((!cpfLimpo || !validarCpf(cpfLimpo)) && conhecido?.cpf && validarCpf(conhecido.cpf)) {
          cpfLimpo = conhecido.cpf;
        }
        if (!telefoneFinal && conhecido?.telefone) telefoneFinal = conhecido.telefone;
        if (!valorCentavos && conhecido?.ultimoValorCentavos) valorSugeridoCentavos = conhecido.ultimoValorCentavos;
      }

      const chave = gerarChaveIdempotenciaPedido({
        atendimentoExternoId,
        pacienteNome: nomeFinal,
        dataConsulta,
        valorCentavos: valorCentavos ?? 0
      });
      const caso = await deps.repositorio.criar({
        contaId: entrada.contaId,
        medicoId: ctx.medicoPadraoId,
        origem: 'pedido_medico',
        chaveIdempotencia: chave,
        estado: 'aguardando_aprovacao_medico',
        pacienteNome: nomeFinal,
        pacienteTelefone: telefoneFinal,
        pacienteCpf: cpfLimpo && validarCpf(cpfLimpo) ? cpfLimpo : null,
        atendimentoExternoId,
        dataConsulta,
        valorCentavos,
        aprovadoPeloMedico: Boolean(entrada.aprovadoAgora),
        ambiente: ctx.prontidaoFiscal.ambiente,
        origemMensagemChave: entrada.chaveMensagemMedico ?? null
      });

      return finalizarDecisao(caso, ctx, { notificarMedico: false, valorSugeridoCentavos });
    },

    async confirmarOuCancelarEmissao(entrada: {
      contaId: string;
      casoId?: string | null;
      decisao: 'aprovar' | 'cancelar' | 'atualizar_dados';
      pacienteNome?: string | null;
      pacienteCpf?: string | null;
      valorCentavos?: number | null;
      dataConsulta?: string | null;
    }): Promise<ResultadoOperacaoEmissao> {
      const abertos = await deps.repositorio.listarAbertosOuRecentes(entrada.contaId, 15);
      if (
        entrada.decisao === 'aprovar' &&
        !entrada.casoId &&
        !entrada.pacienteNome &&
        !entrada.pacienteCpf &&
        !entrada.valorCentavos
      ) {
        const loteElegivel = abertos.filter(c =>
          c.estado === 'erro' || c.estado === 'aguardando_aprovacao_medico'
        );
        if (loteElegivel.length > 1) {
          const ctx = await deps.obterContextoConta(entrada.contaId);
          let ultimoRes: ResultadoOperacaoEmissao | null = null;
          const pacientesReenfileirados: string[] = [];
          for (const item of loteElegivel) {
            const atualizado = (await deps.repositorio.atualizar(entrada.contaId, item.id, {
              aprovadoPeloMedico: true
            })) ?? item;
            const r = await finalizarDecisao(atualizado, ctx, { notificarMedico: false });
            ultimoRes = r;
            if (r.acao === 'enfileirada' && item.pacienteNome) {
              pacientesReenfileirados.push(item.pacienteNome);
            }
          }
          if (ultimoRes) {
            return {
              ...ultimoRes,
              reenfileirados: pacientesReenfileirados.length,
              pacientesReenfileirados
            };
          }
        }
      }

      const alvo = entrada.casoId
        ? abertos.find(c => c.id === entrada.casoId) ?? await deps.repositorio.buscarPorId(entrada.contaId, entrada.casoId)
        : abertos.find(c => !['emitida', 'cancelada', 'enfileirada'].includes(c.estado));
      if (!alvo) return { ok: false, acao: 'erro', motivo: 'CASO_EMISSAO_NAO_ENCONTRADO' };

      if (entrada.decisao === 'cancelar') {
        const canc = (await deps.repositorio.atualizar(entrada.contaId, alvo.id, { estado: 'cancelada' })) ?? alvo;
        return { ok: true, acao: 'cancelada', caso: resumirCasoParaAgente(canc) };
      }

      const cpfLimpo = entrada.pacienteCpf?.replace(/\D/g, '') || undefined;
      if (cpfLimpo && !validarCpf(cpfLimpo)) {
        return { ok: false, acao: 'solicitar_cpf_medico', motivo: 'CPF_INVALIDO', caso: resumirCasoParaAgente(alvo) };
      }

      const atualizado = (await deps.repositorio.atualizar(entrada.contaId, alvo.id, {
        ...(entrada.pacienteNome ? { pacienteNome: entrada.pacienteNome.trim() } : {}),
        ...(cpfLimpo ? { pacienteCpf: cpfLimpo } : {}),
        ...(entrada.valorCentavos && entrada.valorCentavos > 0 ? { valorCentavos: entrada.valorCentavos } : {}),
        ...(entrada.dataConsulta ? { dataConsulta: entrada.dataConsulta.slice(0, 10) } : {}),
        ...(entrada.decisao === 'aprovar' ? { aprovadoPeloMedico: true } : {})
      })) ?? alvo;

      const ctx = await deps.obterContextoConta(entrada.contaId);
      return finalizarDecisao(atualizado, ctx, { notificarMedico: false });
    },

    async vincularPagadorSecundario(entrada: {
      contaId: string;
      pagadorNome: string;
      pacienteNome: string;
      emitirNoCpfDe?: 'paciente' | 'pagador';
      pacienteCpf?: string | null;
      dataConsulta?: string | null;
      casoId?: string | null;
    }): Promise<ResultadoOperacaoEmissao & { pagadorSalvo: { pagadorNome: string; pacienteNome: string; emitirNoCpfDe: 'paciente' | 'pagador' } }> {
      const salvo = await deps.repositorio.salvarPagadorSecundario({
        contaId: entrada.contaId,
        pagadorNome: entrada.pagadorNome,
        pacienteNome: entrada.pacienteNome,
        emitirNoCpfDe: entrada.emitirNoCpfDe ?? 'paciente'
      });

      const abertos = await deps.repositorio.listarAbertosOuRecentes(entrada.contaId, 10);
      const casoPendente = entrada.casoId
        ? abertos.find(c => c.id === entrada.casoId)
        : abertos.find(c => c.estado === 'aguardando_esclarecimento');

      if (!casoPendente) {
        return {
          ok: true,
          acao: 'aguardar_aprovacao_medico',
          pagadorSalvo: { pagadorNome: entrada.pagadorNome, pacienteNome: salvo.pacienteNome, emitirNoCpfDe: salvo.emitirNoCpfDe }
        };
      }

      const ctx = await deps.obterContextoConta(entrada.contaId);
      const hoje = hojeSp(agoraFn());
      const inicioBusca = deslocarDiasIso(entrada.dataConsulta ?? casoPendente.dataConsulta ?? hoje, -JANELA_DIAS_BUSCA_COMPROVANTE);
      const [atendimentos, emitidas] = await Promise.all([
        deps.obterAtendimentosAgenda(entrada.contaId, inicioBusca, hoje).catch(() => []),
        deps.repositorio.listarChavesConsultasComNota(entrada.contaId)
      ]);
      const busca = normalizarNomeParaBusca(entrada.pacienteNome);
      const consulta = atendimentos
        .filter(a => normalizarNomeParaBusca(a.paciente).includes(busca) || busca.includes(normalizarNomeParaBusca(a.paciente)))
        .filter(a => !(a.atendimentoId && emitidas.has(a.atendimentoId)))
        .sort((a, b) => b.data.localeCompare(a.data))[0];

      const detalhe = consulta?.atendimentoId && deps.obterDetalheAtendimento
        ? await deps.obterDetalheAtendimento(entrada.contaId, consulta.atendimentoId).catch(() => null)
        : null;
      const cpfLimpo = entrada.pacienteCpf?.replace(/\D/g, '') || detalhe?.cpf?.replace(/\D/g, '') || undefined;

      const atualizado = (await deps.repositorio.atualizar(entrada.contaId, casoPendente.id, {
        pacienteNome: detalhe?.nome || consulta?.paciente || entrada.pacienteNome.trim(),
        ...(detalhe?.telefone ? { pacienteTelefone: detalhe.telefone } : {}),
        ...(cpfLimpo && validarCpf(cpfLimpo) ? { pacienteCpf: cpfLimpo } : {}),
        ...(consulta?.atendimentoId ? { atendimentoExternoId: consulta.atendimentoId } : {}),
        ...(entrada.dataConsulta || consulta?.data ? { dataConsulta: (entrada.dataConsulta ?? consulta!.data).slice(0, 10) } : {})
      })) ?? casoPendente;

      const resultado = await finalizarDecisao(atualizado, ctx, { notificarMedico: false });
      return {
        ...resultado,
        pagadorSalvo: { pagadorNome: entrada.pagadorNome, pacienteNome: salvo.pacienteNome, emitirNoCpfDe: salvo.emitirNoCpfDe }
      };
    },

    async tratarRespostaCpfPaciente(entrada: {
      contaId: string;
      instanciaConsultorio: string;
      telefonePaciente: string;
      texto: string;
    }): Promise<{ tratado: boolean; resultado?: ResultadoOperacaoEmissao }> {
      const caso = await deps.repositorio.buscarAbertoPorTelefonePaciente(entrada.contaId, entrada.telefonePaciente);
      if (!caso) return { tratado: false };

      const cpf = extrairCpfValidoDaMensagem(entrada.texto);
      if (!cpf) return { tratado: false };

      const atualizado = (await deps.repositorio.atualizar(entrada.contaId, caso.id, { pacienteCpf: cpf })) ?? caso;
      await deps.enviarTextoConsultorio?.(
        entrada.instanciaConsultorio,
        entrada.telefonePaciente,
        'Obrigado! Recebi seu CPF e já vou dar andamento na sua nota fiscal.'
      );
      const ctx = await deps.obterContextoConta(entrada.contaId);
      const resultado = await finalizarDecisao(atualizado, ctx, { notificarMedico: true });
      return { tratado: true, resultado };
    },

    async consultarEmissoesConta(contaId: string) {
      const lista = await deps.repositorio.listarAbertosOuRecentes(contaId, 10);
      return lista.map(resumirCasoParaAgente);
    },

    /** Retoma automaticamente casos que estavam parados aguardando A1/parâmetros fiscais. */
    async retomarCasosAguardandoProntidaoFiscal(contaId: string): Promise<{
      retomados: number;
      enfileirados: number;
      pacientesEnfileirados: string[];
    }> {
      const ctx = await deps.obterContextoConta(contaId);
      if (!ctx.prontidaoFiscal.certificadoValido || !ctx.prontidaoFiscal.dadosFiscaisProntos) {
        return { retomados: 0, enfileirados: 0, pacientesEnfileirados: [] };
      }
      const recentes = await deps.repositorio.listarAbertosOuRecentes(contaId, 20);
      const travados = recentes.filter(c => c.estado === 'aguardando_prontidao_fiscal');
      const pacientesEnfileirados: string[] = [];
      let retomados = 0;

      for (const caso of travados) {
        const res = await finalizarDecisao(caso, ctx, { notificarMedico: false });
        if (res.acao !== 'aguardar_prontidao_fiscal') {
          retomados++;
          if (res.acao === 'enfileirada' && caso.pacienteNome) {
            pacientesEnfileirados.push(caso.pacienteNome);
          }
        }
      }
      return { retomados, enfileirados: pacientesEnfileirados.length, pacientesEnfileirados };
    },

    async entregarNotaAutorizada(entrada: {
      solicitacaoId: string;
      notaFiscalId?: string | null;
      numeroNota?: number | string | null;
      pdfBase64?: string | null;
      contingenciaHomologacao?: boolean;
    }): Promise<boolean> {
      const caso = await deps.repositorio.buscarPorSolicitacaoId(entrada.solicitacaoId);
      if (!caso) return false;

      const atualizado = (await deps.repositorio.atualizar(caso.contaId, caso.id, {
        estado: 'emitida',
        notaFiscalId: entrada.notaFiscalId ?? null
      })) ?? caso;
      const ctx = await deps.obterContextoConta(caso.contaId);
      const contingencia = Boolean(entrada.contingenciaHomologacao && atualizado.ambiente === 'homologacao');
      const nomeArq = contingencia
        ? `NFS-e-HOMOLOG-CONTINGENCIA-${entrada.numeroNota ?? 'nota'}.pdf`
        : `NFS-e-${entrada.numeroNota ?? 'nota'}.pdf`;
      const { avisoHomolog, resumoMedico } = montarResumoEntregaNotaMedico(atualizado, {
        contingenciaHomologacao: contingencia
      });

      if (ctx.preferencias.enviarNotaParaPaciente === true && ctx.instanciaConsultorio && atualizado.pacienteTelefone && entrada.pdfBase64) {
        await deps.enviarPdfConsultorio?.(
          ctx.instanciaConsultorio,
          atualizado.pacienteTelefone,
          entrada.pdfBase64,
          nomeArq,
          `Olá! Segue a nota fiscal da sua consulta${avisoHomolog}.`
        );
      }

      if (ctx.telefoneMedico) {
        if (entrada.pdfBase64 && deps.enviarPdfMedico) {
          await deps.enviarPdfMedico(caso.contaId, ctx.telefoneMedico, entrada.pdfBase64, nomeArq, resumoMedico);
        } else {
          await deps.enviarTextoMedico(caso.contaId, ctx.telefoneMedico, resumoMedico);
        }
      }

      if (atualizado.origemMensagemChave && deps.reagirMensagemMedico) {
        await deps.reagirMensagemMedico(atualizado.origemMensagemChave, '✅').catch(() => false);
      }
      return true;
    }
  };
}
