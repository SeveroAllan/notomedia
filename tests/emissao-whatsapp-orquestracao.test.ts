import { describe, expect, it, vi } from 'vitest';
import {
  chaveAtendimentoSemNota,
  cruzarComprovanteComAgenda,
  normalizarNomeParaBusca,
  type PagadorSecundarioSalvo
} from '../src/emissao/cruzar-comprovante-agenda.js';
import { decidirProximoPassoEmissao } from '../src/emissao/decidir-proximo-passo-emissao.js';
import { criarOrquestradorEmissaoConta, type ContextoOperacionalConta } from '../src/emissao/orquestrar-emissao-conta.js';
import {
  formatarResumoLoteWhatsApp,
  prepararEmissaoLotePeriodo
} from '../src/emissao/preparar-emissao-lote-periodo.js';
import type { CasoEmissaoRegistro, CasoEmissaoRepositorio } from '../src/emissao/caso-emissao-repositorio.js';
import { gerarHashCpf } from '../src/paciente/hash-cpf.js';

function criarRepositorioFalso(): CasoEmissaoRepositorio & {
  casos: CasoEmissaoRegistro[];
  secundarios: PagadorSecundarioSalvo[];
  chavesEmitidas: Set<string>;
} {
  let seq = 1;
  const casos: CasoEmissaoRegistro[] = [];
  const secundarios: PagadorSecundarioSalvo[] = [];
  const chavesEmitidas = new Set<string>();

  return {
    casos,
    secundarios,
    chavesEmitidas,
    async buscarPorChaveIdempotencia(contaId, chave) {
      return casos.find(c => c.contaId === contaId && c.chaveIdempotencia === chave) ?? null;
    },
    async buscarPorId(contaId, casoId) {
      return casos.find(c => c.contaId === contaId && c.id === casoId) ?? null;
    },
    async buscarPorSolicitacaoId(solicitacaoId) {
      return casos.find(c => c.solicitacaoId === solicitacaoId) ?? null;
    },
    async buscarAbertoPorTelefonePaciente(contaId, telefone) {
      const limpo = telefone.replace(/\D/g, '');
      return casos.find(c => c.contaId === contaId && c.estado === 'aguardando_cpf_paciente' && c.pacienteTelefone?.replace(/\D/g, '') === limpo) ?? null;
    },
    async listarAbertosOuRecentes(contaId, limite = 12) {
      return casos.filter(c => c.contaId === contaId).slice(-limite).reverse();
    },
    async criar(entrada) {
      const existente = casos.find(c => c.contaId === entrada.contaId && c.chaveIdempotencia === entrada.chaveIdempotencia);
      if (existente) return existente;
      const now = new Date().toISOString();
      const novo: CasoEmissaoRegistro = {
        id: `caso-${seq++}`,
        contaId: entrada.contaId,
        medicoId: entrada.medicoId,
        origem: entrada.origem,
        chaveIdempotencia: entrada.chaveIdempotencia,
        estado: entrada.estado,
        pacienteNome: entrada.pacienteNome ?? null,
        pacienteTelefone: entrada.pacienteTelefone ?? null,
        pacienteCpf: entrada.pacienteCpf ?? null,
        pagadorNome: entrada.pagadorNome ?? null,
        pagadorCpfHash: entrada.pagadorCpf ? gerarHashCpf(entrada.pagadorCpf, 'pepper') : null,
        atendimentoExternoId: entrada.atendimentoExternoId ?? null,
        dataConsulta: entrada.dataConsulta ?? null,
        valorCentavos: entrada.valorCentavos ?? null,
        aprovadoPeloMedico: Boolean(entrada.aprovadoPeloMedico),
        ambiente: entrada.ambiente ?? 'homologacao',
        origemMensagemChave: entrada.origemMensagemChave ?? null,
        solicitacaoId: null,
        notaFiscalId: null,
        erroMotivo: null,
        criadoEm: now,
        atualizadoEm: now
      };
      casos.push(novo);
      return novo;
    },
    async atualizar(contaId, casoId, delta) {
      const alvo = casos.find(c => c.contaId === contaId && c.id === casoId);
      if (!alvo) return null;
      Object.assign(alvo, { ...delta, atualizadoEm: new Date().toISOString() });
      return alvo;
    },
    async listarChavesConsultasComNota(contaId) {
      const set = new Set(chavesEmitidas);
      for (const c of casos) {
        if (c.contaId === contaId && ['enfileirada', 'emitida'].includes(c.estado)) {
          if (c.atendimentoExternoId) set.add(c.atendimentoExternoId);
          if (c.pacienteNome && c.dataConsulta) set.add(chaveAtendimentoSemNota(c.pacienteNome, c.dataConsulta));
        }
      }
      return set;
    },
    async listarPagadoresSecundarios() {
      return [...secundarios];
    },
    async salvarPagadorSecundario(entrada) {
      const norm = normalizarNomeParaBusca(entrada.pagadorNome);
      const existente = secundarios.find(s => s.pagadorNomeNormalizado === norm);
      if (existente) {
        existente.pacienteNome = entrada.pacienteNome;
        existente.emitirNoCpfDe = entrada.emitirNoCpfDe ?? 'paciente';
        return existente;
      }
      const novo: PagadorSecundarioSalvo = {
        id: `pag-${seq++}`,
        pagadorNomeNormalizado: norm,
        pagadorCpfHash: entrada.pagadorCpf ? gerarHashCpf(entrada.pagadorCpf, 'pepper') : null,
        pacienteNome: entrada.pacienteNome,
        pacienteTelefone: entrada.pacienteTelefone ?? null,
        emitirNoCpfDe: entrada.emitirNoCpfDe ?? 'paciente'
      };
      secundarios.push(novo);
      return novo;
    }
  };
}

function contextoBase(override?: Partial<ContextoOperacionalConta>): ContextoOperacionalConta {
  return {
    medicoPadraoId: 'med-1',
    telefoneMedico: '555199990001',
    instanciaConsultorio: 'medico_1234567890ab',
    preferencias: {
      emitirApenasComComprovante: true,
      revisaoDiariaAgenda: false,
      enviarNotaParaPaciente: false,
      pedirAprovacaoAntesDeEmitir: false,
      solicitarCpfDiretoPaciente: true
    },
    prontidaoFiscal: {
      certificadoValido: true,
      dadosFiscaisProntos: true,
      ambiente: 'homologacao',
      producaoLiberadaNaConta: false
    },
    ...override
  };
}

describe('orquestração de comprovantes, pagadores secundários e emissão WhatsApp', () => {
  it('busca consultas nos dias anteriores ao comprovante ignorando consultas que já possuem nota emitida', () => {
    const emitidas = new Set([chaveAtendimentoSemNota('Maria Silva', '2026-11-10')]);
    const res = cruzarComprovanteComAgenda({
      comprovante: {
        ehComprovante: true,
        confianca: 'alta',
        valorCentavos: 35000,
        dataPagamento: '2026-11-20',
        nomePagador: 'Maria Silva',
        cpfPagador: null,
        meioPagamento: 'pix',
        identificadorTransacao: 'E2E-1'
      },
      dataReferenciaIso: '2026-11-20',
      atendimentosAgenda: [
        { data: '2026-11-10', paciente: 'Maria Silva', valorCentavos: 35000, atendimentoId: 'at-1' },
        { data: '2026-11-17', paciente: 'Maria Silva', valorCentavos: 35000, atendimentoId: 'at-2' }
      ],
      chavesJaEmitidas: emitidas,
      pagadoresSecundarios: []
    });

    expect(res.tipo).toBe('encontrado_unico');
    if (res.tipo === 'encontrado_unico') {
      expect(res.atendimento.data).toBe('2026-11-17');
      expect(res.atendimento.atendimentoId).toBe('at-2');
    }
  });

  it('aplica trava de Certificado A1 e trava de produção antes de enfileirar', () => {
    const semA1 = decidirProximoPassoEmissao({
      pacienteNome: 'Maria Silva',
      pacienteCpf: '52998224725',
      pacienteTelefone: '5551999998888',
      valorCentavos: 35000,
      dataConsulta: '2026-11-18',
      matchAmbiguoOuDivergente: false,
      aprovadoPeloMedico: true,
      instanciaConsultorioConectada: true,
      preferencias: contextoBase().preferencias,
      prontidaoFiscal: { certificadoValido: false, dadosFiscaisProntos: false, ambiente: 'homologacao', producaoLiberadaNaConta: false }
    });
    expect(semA1).toEqual({ acao: 'aguardar_prontidao_fiscal', motivo: 'CERTIFICADO_A1_PENDENTE' });

    const prodBloqueada = decidirProximoPassoEmissao({
      pacienteNome: 'Maria Silva',
      pacienteCpf: '52998224725',
      pacienteTelefone: '5551999998888',
      valorCentavos: 35000,
      dataConsulta: '2026-11-18',
      matchAmbiguoOuDivergente: false,
      aprovadoPeloMedico: true,
      instanciaConsultorioConectada: true,
      preferencias: contextoBase().preferencias,
      prontidaoFiscal: { certificadoValido: true, dadosFiscaisProntos: true, ambiente: 'producao', producaoLiberadaNaConta: false }
    });
    expect(prodBloqueada).toEqual({ acao: 'aguardar_prontidao_fiscal', motivo: 'PRODUCAO_NAO_LIBERADA' });
  });

  it('pede CPF ao paciente no WhatsApp do consultório quando falta, captura a resposta e enfileira automaticamente (com idempotência)', async () => {
    const repo = criarRepositorioFalso();
    const mensagensConsultorio: string[] = [];
    const mensagensMedico: string[] = [];
    const enfileirarEmissao = vi.fn().mockResolvedValue({
      ok: true as const, solicitacaoId: 'sol-1', jaExistia: false, ambiente: 'homologacao' as const
    });

    const orq = criarOrquestradorEmissaoConta({
      repositorio: repo,
      pepper: 'pepper',
      obterContextoConta: async () => contextoBase(),
      obterAtendimentosAgenda: async () => [
        { data: '2026-11-17', paciente: 'Maria Silva', valorCentavos: 35000, atendimentoId: 'at-17' }
      ],
      obterDetalheAtendimento: async () => ({ nome: 'Maria Silva', cpf: null, telefone: '5551999998888', valorCentavos: 35000 }),
      enfileirarEmissao,
      enviarTextoMedico: async (_c, _t, txt) => { mensagensMedico.push(txt); return true; },
      enviarTextoConsultorio: async (_i, _t, txt) => { mensagensConsultorio.push(txt); return true; },
      agora: () => new Date('2026-11-20T15:00:00Z')
    });

    // 1. Comprovante chega 3 dias depois da consulta, sem CPF -> pede ao paciente no WhatsApp do consultório.
    const r1 = await orq.processarComprovanteRecebido({
      contaId: 'conta-1',
      origem: 'comprovante_paciente',
      mensagemId: 'msg-p-1',
      telefoneRemetente: '5551999998888',
      comprovante: {
        ehComprovante: true, confianca: 'alta', valorCentavos: 35000, dataPagamento: '2026-11-20',
        nomePagador: 'Maria Silva', cpfPagador: null, meioPagamento: 'pix', identificadorTransacao: 'E2E-MARIA'
      }
    });
    expect(r1.acao).toBe('solicitar_cpf_paciente');
    expect(mensagensConsultorio[0]).toContain('confirmar seu CPF');

    // 2. Mensagem comum de outro paciente sem caso aberto -> silêncio absoluto.
    const silencio = await orq.tratarRespostaCpfPaciente({
      contaId: 'conta-1', instanciaConsultorio: 'medico_1234567890ab',
      telefonePaciente: '5551988887777', texto: 'Bom dia, que horas é minha consulta?'
    });
    expect(silencio.tratado).toBe(false);

    // 3. Maria responde com CPF válido -> enfileira automaticamente (pedirAprovacaoAntesDeEmitir=false).
    const rCpf = await orq.tratarRespostaCpfPaciente({
      contaId: 'conta-1', instanciaConsultorio: 'medico_1234567890ab',
      telefonePaciente: '5551999998888', texto: 'Claro, é 529.982.247-25'
    });
    expect(rCpf.tratado).toBe(true);
    expect(rCpf.resultado?.acao).toBe('enfileirada');
    expect(enfileirarEmissao).toHaveBeenCalledTimes(1);

    // 4. Mesmo comprovante (mesmo E2EID) reenviado -> detecta duplicidade e NÃO emite de novo.
    const dup = await orq.processarComprovanteRecebido({
      contaId: 'conta-1',
      origem: 'comprovante_paciente',
      mensagemId: 'msg-p-2',
      telefoneRemetente: '5551999998888',
      comprovante: {
        ehComprovante: true, confianca: 'alta', valorCentavos: 35000, dataPagamento: '2026-11-20',
        nomePagador: 'Maria Silva', cpfPagador: null, meioPagamento: 'pix', identificadorTransacao: 'E2E-MARIA'
      }
    });
    expect(dup.acao).toBe('duplicado');
    expect(enfileirarEmissao).toHaveBeenCalledTimes(1);
  });

  it('aprende pagador secundário após esclarecimento do médico e reconhece sozinho nos próximos comprovantes', async () => {
    const repo = criarRepositorioFalso();
    const enfileirarEmissao = vi.fn().mockResolvedValue({
      ok: true as const, solicitacaoId: 'sol-sec-1', jaExistia: false, ambiente: 'homologacao' as const
    });
    const atendimentos = [
      { data: '2026-11-15', paciente: 'João Pedro', valorCentavos: 40000, atendimentoId: 'at-jp-1' },
      { data: '2026-11-19', paciente: 'João Pedro', valorCentavos: 40000, atendimentoId: 'at-jp-2' }
    ];

    const orq = criarOrquestradorEmissaoConta({
      repositorio: repo,
      pepper: 'pepper',
      obterContextoConta: async () => contextoBase(),
      obterAtendimentosAgenda: async () => atendimentos,
      obterDetalheAtendimento: async () => ({ nome: 'João Pedro', cpf: '52998224725', telefone: '5551999990000', valorCentavos: 40000 }),
      enfileirarEmissao,
      enviarTextoMedico: async () => true,
      agora: () => new Date('2026-11-20T15:00:00Z')
    });

    // 1ª vez: comprovante vem de "Carlos Souza" (pai do João Pedro) -> pergunta ao médico.
    const primeiro = await orq.processarComprovanteRecebido({
      contaId: 'conta-1',
      origem: 'comprovante_medico',
      mensagemId: 'm-sec-1',
      comprovante: {
        ehComprovante: true, confianca: 'alta', valorCentavos: 40000, dataPagamento: '2026-11-16',
        nomePagador: 'Carlos Souza', cpfPagador: null, meioPagamento: 'pix', identificadorTransacao: 'E2E-SEC-1'
      }
    });
    expect(primeiro.acao).toBe('esclarecer_com_medico');
    expect(primeiro.pagadorSecundarioSugerido?.pagadorNome).toBe('Carlos Souza');

    // Médico esclarece: "Carlos Souza é o pai do João Pedro" -> salva pagador secundário e enfileira a consulta pendente!
    const vinculado = await orq.vincularPagadorSecundario({
      contaId: 'conta-1',
      pagadorNome: 'Carlos Souza',
      pacienteNome: 'João Pedro',
      emitirNoCpfDe: 'paciente'
    });
    expect(vinculado.pagadorSalvo.pacienteNome).toBe('João Pedro');
    expect(vinculado.acao).toBe('enfileirada');

    // 2ª vez: novo comprovante de "Carlos Souza" -> reconhece automaticamente como pagador secundário de João Pedro
    // e casa com a consulta de 19/11 (ignorando a de 15/11 já enfileirada)!
    const segundo = await orq.processarComprovanteRecebido({
      contaId: 'conta-1',
      origem: 'comprovante_medico',
      mensagemId: 'm-sec-2',
      comprovante: {
        ehComprovante: true, confianca: 'alta', valorCentavos: 40000, dataPagamento: '2026-11-20',
        nomePagador: 'Carlos Souza', cpfPagador: null, meioPagamento: 'pix', identificadorTransacao: 'E2E-SEC-2'
      }
    });
    expect(segundo.acao).toBe('enfileirada');
    expect(segundo.caso?.pacienteNome).toBe('João Pedro');
    expect(enfileirarEmissao).toHaveBeenCalledTimes(2);
  });

  it('entrega DANFSE respeitando enviarNotaParaPaciente e reage ✅ na mensagem original', async () => {
    const repo = criarRepositorioFalso();
    const caso = await repo.criar({
      contaId: 'conta-1', medicoId: 'med-1', origem: 'pedido_medico', chaveIdempotencia: 'k1',
      estado: 'enfileirada', pacienteNome: 'Maria Silva', pacienteTelefone: '5551999998888',
      pacienteCpf: '52998224725', dataConsulta: '2026-11-18', valorCentavos: 35000,
      origemMensagemChave: { id: 'msg-orig-1', remoteJid: '555199990001@s.whatsapp.net', fromMe: false }
    });
    await repo.atualizar('conta-1', caso.id, { solicitacaoId: 'sol-99' });

    const enviarPdfMedico = vi.fn().mockResolvedValue(true);
    const enviarPdfConsultorio = vi.fn().mockResolvedValue(true);
    const reagir = vi.fn().mockResolvedValue(true);

    const orq = criarOrquestradorEmissaoConta({
      repositorio: repo,
      pepper: 'pepper',
      obterContextoConta: async () => contextoBase({
        preferencias: { ...contextoBase().preferencias, enviarNotaParaPaciente: true }
      }),
      obterAtendimentosAgenda: async () => [],
      enfileirarEmissao: vi.fn(),
      enviarTextoMedico: vi.fn().mockResolvedValue(true),
      enviarPdfMedico,
      enviarPdfConsultorio,
      reagirMensagemMedico: reagir
    });

    const ok = await orq.entregarNotaAutorizada({
      solicitacaoId: 'sol-99',
      notaFiscalId: 'nf-99',
      numeroNota: 42,
      pdfBase64: Buffer.from('pdf-ok').toString('base64')
    });
    expect(ok).toBe(true);
    expect(enviarPdfConsultorio).toHaveBeenCalledTimes(1);
    expect(enviarPdfMedico).toHaveBeenCalledTimes(1);
    expect(reagir).toHaveBeenCalledWith({ id: 'msg-orig-1', remoteJid: '555199990001@s.whatsapp.net', fromMe: false }, '✅');
    expect((await repo.buscarPorId('conta-1', caso.id))?.estado).toBe('emitida');
  });

  it('emite em lote todos os atendimentos elegíveis de um dia (pulando já emitidas e listando pendências)', async () => {
    const repo = criarRepositorioFalso();
    repo.chavesEmitidas.add('at-1');
    const enfileirarEmissao = vi.fn().mockResolvedValue({
      ok: true as const, solicitacaoId: 'sol-lote', jaExistia: false, ambiente: 'homologacao' as const
    });
    const orq = criarOrquestradorEmissaoConta({
      repositorio: repo,
      pepper: 'pepper',
      obterContextoConta: async () => contextoBase({ instanciaConsultorio: null }),
      obterAtendimentosAgenda: async () => [],
      enfileirarEmissao,
      enviarTextoMedico: async () => true
    });

    const res = await prepararEmissaoLotePeriodo({
      contaId: 'conta-1',
      dataInicio: '2026-09-28',
      dataFim: '2026-09-28',
      aprovadoAgora: true
    }, {
      repositorio: repo,
      obterAtendimentosDetalhados: async () => [
        { data: '2026-09-28', paciente: 'Paciente Já Emitido', valorCentavos: 30000, atendimentoId: 'at-1', cpf: '52998224725' },
        { data: '2026-09-28', paciente: 'Marina Castro', valorCentavos: 45000, atendimentoId: 'at-2', cpf: '52998224725' },
        { data: '2026-09-28', paciente: 'Pedro Sem Cpf', valorCentavos: 35000, atendimentoId: 'at-3', cpf: null }
      ],
      prepararIndividual: item => orq.prepararEmissaoPeloMedico(item)
    });

    expect(res.totalEncontrados).toBe(3);
    expect(res.jaEmitidas).toBe(1);
    expect(res.enfileiradas).toBe(1);
    expect(res.pendentes).toBe(1);
    expect(enfileirarEmissao).toHaveBeenCalledTimes(1);
    const resumo = formatarResumoLoteWhatsApp(res);
    expect(resumo).toContain('Marina Castro');
    expect(resumo).toContain('Pedro Sem Cpf');
    expect(resumo).toContain('falta CPF');
  });
});
