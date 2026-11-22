import { describe, expect, it, vi } from 'vitest';
import {
  ehFalhaTransitoriaSefin,
  explicarErroEmissaoHumano,
  resolverEPersistirPdfDanfse
} from '../src/emissao/worker-casos-emissao.js';
import { criarOrquestradorEmissaoConta } from '../src/emissao/orquestrar-emissao-conta.js';
import type { CasoEmissaoRegistro, CasoEmissaoRepositorio } from '../src/emissao/caso-emissao-repositorio.js';
import { criarCoalescedorMensagens } from '../src/agente/coalescer-mensagens.js';
import {
  formatarAvisoProativoConsultas,
  identificarCasosCpfTravados,
  planejarHorariosDoDia,
  reagendarSlotNaoFinalizado,
  selecionarSlotsParaVerificarAgora
} from '../src/agente/rotina-proativa-regras.js';
import { criarMotorRotinaProativa } from '../src/agente/rotina-proativa-worker.js';
import {
  notificarAgendaConectadaEIniciarProfissionais,
  notificarCertificadoSalvoEProximoPasso,
  type PortaEnvioOrquestracao
} from '../src/agente/orquestrar-pos-cofre.js';
import { separarBaloes } from '../src/agente/baloes.js';
import {
  avaliarCortesiaTemporal,
  envolverMensagemProativaComCortesia
} from '../src/agente/regras/cortesia-retomada-conversa.js';
import { extrairHorariosDoDiaTribemd } from '../src/desenvolvedor/tribemd-agenda.js';

function criarRepoCasosEmMemoria(): CasoEmissaoRepositorio & { casos: CasoEmissaoRegistro[] } {
  const casos: CasoEmissaoRegistro[] = [];
  let seq = 1;
  return {
    casos,
    async buscarPorChaveIdempotencia(contaId, chave) {
      return casos.find(c => c.contaId === contaId && c.chaveIdempotencia === chave) ?? null;
    },
    async buscarPorId(contaId, casoId) {
      return casos.find(c => c.contaId === contaId && c.id === casoId) ?? null;
    },
    async buscarPorSolicitacaoId(solId) {
      return casos.find(c => c.solicitacaoId === solId) ?? null;
    },
    async buscarAbertoPorTelefonePaciente() { return null; },
    async listarAbertosOuRecentes(contaId, limite = 12) {
      return casos.filter(c => c.contaId === contaId).slice(0, limite);
    },
    async criar(e) {
      const ja = casos.find(c => c.contaId === e.contaId && c.chaveIdempotencia === e.chaveIdempotencia);
      if (ja) return ja;
      const agora = new Date().toISOString();
      const reg: CasoEmissaoRegistro = {
        id: `caso-${seq++}`,
        contaId: e.contaId,
        medicoId: e.medicoId,
        origem: e.origem,
        chaveIdempotencia: e.chaveIdempotencia,
        estado: e.estado,
        pacienteNome: e.pacienteNome ?? null,
        pacienteTelefone: e.pacienteTelefone ?? null,
        pacienteCpf: e.pacienteCpf ?? null,
        pagadorNome: e.pagadorNome ?? null,
        pagadorCpfHash: null,
        atendimentoExternoId: e.atendimentoExternoId ?? null,
        dataConsulta: e.dataConsulta ?? null,
        valorCentavos: e.valorCentavos ?? null,
        aprovadoPeloMedico: Boolean(e.aprovadoPeloMedico),
        ambiente: e.ambiente ?? 'homologacao',
        origemMensagemChave: e.origemMensagemChave ?? null,
        solicitacaoId: null,
        notaFiscalId: null,
        erroMotivo: null,
        criadoEm: agora,
        atualizadoEm: agora
      };
      casos.unshift(reg);
      return reg;
    },
    async atualizar(contaId, casoId, delta) {
      const idx = casos.findIndex(c => c.contaId === contaId && c.id === casoId);
      if (idx < 0) return null;
      const atual = casos[idx]!;
      const novo: CasoEmissaoRegistro = {
        ...atual,
        ...(delta.estado !== undefined ? { estado: delta.estado } : {}),
        ...(delta.pacienteNome !== undefined ? { pacienteNome: delta.pacienteNome } : {}),
        ...(delta.pacienteTelefone !== undefined ? { pacienteTelefone: delta.pacienteTelefone } : {}),
        ...(delta.pacienteCpf !== undefined ? { pacienteCpf: delta.pacienteCpf } : {}),
        ...(delta.valorCentavos !== undefined ? { valorCentavos: delta.valorCentavos } : {}),
        ...(delta.aprovadoPeloMedico !== undefined ? { aprovadoPeloMedico: delta.aprovadoPeloMedico } : {}),
        ...(delta.solicitacaoId !== undefined ? { solicitacaoId: delta.solicitacaoId } : {}),
        ...(delta.notaFiscalId !== undefined ? { notaFiscalId: delta.notaFiscalId } : {}),
        ...(delta.erroMotivo !== undefined ? { erroMotivo: delta.erroMotivo } : {}),
        atualizadoEm: new Date().toISOString()
      };
      casos[idx] = novo;
      return novo;
    },
    async listarChavesConsultasComNota() { return new Set<string>(); },
    async listarPagadoresSecundarios() { return []; },
    async salvarPagadorSecundario(e) {
      return {
        id: 'pag-1',
        pagadorNome: e.pagadorNome,
        pagadorNomeNormalizado: e.pagadorNome.toLowerCase(),
        pacienteNome: e.pacienteNome,
        pacienteTelefone: e.pacienteTelefone ?? null,
        emitirNoCpfDe: e.emitirNoCpfDe ?? 'paciente'
      };
    }
  };
}

describe('Fase 1 — Entrega de PDF da DANFSE e autocorreção SEFIN', () => {
  it('extrai pdfBase64 de data URI e persiste arquivo limpo no Storage sem gravar base64 na coluna', async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const storageMock = { storage: { from: () => ({ upload }) } } as any;
    const b64 = Buffer.from('%PDF-1.4 fake danfse').toString('base64');

    const res = await resolverEPersistirPdfDanfse({
      pdfRetornado: `data:application/pdf;base64,${b64}`,
      storage: storageMock,
      caminhoDestino: 'notas/med-1/2026-11/chave123.pdf'
    });

    expect(res.pdfBase64).toBe(b64);
    expect(res.pdfStoragePath).toBe('notas/med-1/2026-11/chave123.pdf');
    expect(upload).toHaveBeenCalledOnce();
  });

  it('classifica falhas transitórias da SEFIN e gera mensagens humanas para erros definitivos', () => {
    expect(ehFalhaTransitoriaSefin({ sucesso: false, erro: 'timeout', codigoErroSefin: 'SEFIN_TIMEOUT' })).toBe(true);
    expect(ehFalhaTransitoriaSefin({ sucesso: false, erro: '503', httpStatus: 503 })).toBe(true);
    expect(ehFalhaTransitoriaSefin({ sucesso: false, erro: 'CPF inválido', codigoErroSefin: 'PACIENTE_CPF_INVALIDO' })).toBe(false);

    expect(explicarErroEmissaoHumano({
      codigoErro: 'PACIENTE_CPF_INVALIDO',
      erroSanitizado: 'CPF inválido',
      pacienteNome: 'Marina Castro'
    })).toContain('CPF cadastrado está inválido');
  });
});

describe('Fase 2 — Resolução autônoma (histórico de paciente, sugestão de valor e retomada A1)', () => {
  it('reaproveita CPF salvo em consulta anterior sem incomodar médico ou paciente, e sugere último valor sem inventar', async () => {
    const repo = criarRepoCasosEmMemoria();
    const enfileirarEmissao = vi.fn().mockResolvedValue({
      ok: true, solicitacaoId: 'sol-1', jaExistia: false, ambiente: 'homologacao'
    });
    const orq = criarOrquestradorEmissaoConta({
      repositorio: repo,
      pepper: 'pep',
      obterContextoConta: async () => ({
        medicoPadraoId: 'med-1',
        telefoneMedico: '5551999990001',
        instanciaConsultorio: 'med_1',
        preferencias: {
          emitirApenasComComprovante: false,
          revisaoDiariaAgenda: true,
          enviarNotaParaPaciente: false,
          pedirAprovacaoAntesDeEmitir: false,
          solicitarCpfDiretoPaciente: true
        },
        prontidaoFiscal: {
          certificadoValido: true,
          dadosFiscaisProntos: true,
          ambiente: 'homologacao',
          producaoLiberadaNaConta: false
        }
      }),
      obterAtendimentosAgenda: async () => [],
      buscarPacienteConhecido: async ({ pacienteNome }) => ({
        nome: pacienteNome ?? null,
        cpf: '52998224725',
        telefone: '5551999990000',
        ultimoValorCentavos: 70000
      }),
      enfileirarEmissao,
      enviarTextoMedico: vi.fn().mockResolvedValue(true)
    });

    // 1. Sem CPF na agenda, mas com valor: reaproveita CPF do histórico e enfileira direto!
    const r1 = await orq.prepararEmissaoPeloMedico({
      contaId: 'c1',
      pacienteNome: 'Marina Castro',
      dataConsulta: '2026-11-20',
      valorCentavos: 80000,
      jaDetalhado: true,
      aprovadoAgora: true
    });
    expect(r1.acao).toBe('enfileirada');
    expect(enfileirarEmissao).toHaveBeenCalledOnce();

    // 2. Sem valor na agenda: NÃO inventa valor, mas devolve sugestão do último valor cobrado!
    const r2 = await orq.prepararEmissaoPeloMedico({
      contaId: 'c1',
      pacienteNome: 'Marina Castro',
      dataConsulta: '2026-11-21',
      valorCentavos: null,
      jaDetalhado: true,
      aprovadoAgora: true
    });
    expect(r2.acao).toBe('esclarecer_com_medico');
    expect(r2.motivo).toBe('VALOR_AUSENTE');
    expect(r2.valorSugeridoCentavos).toBe(70000);
    expect(r2.valorSugeridoFormatado).toContain('700,00');
  });

  it('retoma automaticamente casos aguardando_prontidao_fiscal quando A1 e dados fiscais ficam prontos', async () => {
    const repo = criarRepoCasosEmMemoria();
    let pronto = false;
    const enfileirarEmissao = vi.fn().mockResolvedValue({
      ok: true, solicitacaoId: 'sol-retomada', jaExistia: false, ambiente: 'homologacao'
    });
    const orq = criarOrquestradorEmissaoConta({
      repositorio: repo,
      pepper: 'pep',
      obterContextoConta: async () => ({
        medicoPadraoId: 'med-1',
        telefoneMedico: '5551999990001',
        instanciaConsultorio: null,
        preferencias: {
          emitirApenasComComprovante: true,
          revisaoDiariaAgenda: false,
          enviarNotaParaPaciente: false,
          pedirAprovacaoAntesDeEmitir: false,
          solicitarCpfDiretoPaciente: false
        },
        prontidaoFiscal: {
          certificadoValido: pronto,
          dadosFiscaisProntos: pronto,
          ambiente: 'homologacao',
          producaoLiberadaNaConta: false
        }
      }),
      obterAtendimentosAgenda: async () => [],
      enfileirarEmissao,
      enviarTextoMedico: vi.fn().mockResolvedValue(true)
    });

    const pendente = await orq.prepararEmissaoPeloMedico({
      contaId: 'c1',
      pacienteNome: 'Denise Horta',
      dataConsulta: '2026-11-21',
      valorCentavos: 70000,
      pacienteCpf: '52998224725',
      jaDetalhado: true,
      aprovadoAgora: true
    });
    expect(pendente.acao).toBe('aguardar_prontidao_fiscal');

    pronto = true;
    const mensagens: string[] = [];
    const porta: PortaEnvioOrquestracao = {
      enviarTexto: async (_tel, txt) => { mensagens.push(txt); return true; },
      criarLinkProfissionais: vi.fn(),
      criarLinkCertificado: vi.fn(),
      criarLinkXml: vi.fn(),
      listarProfissionaisSemCertificado: async () => [],
      obterNomeAgendaConectada: async () => 'TribeMD',
      preferenciasJaConfiguradas: async () => true,
      retomarCasosPendentes: contaId => orq.retomarCasosAguardandoProntidaoFiscal(contaId)
    };

    await notificarCertificadoSalvoEProximoPasso(porta, {
      contaId: 'c1',
      medicoId: 'med-1',
      nomeProfissional: 'Alice Xavier',
      telefone: '5551999990001',
      fiscalImportado: true,
      resumoFiscal: 'RS'
    });

    expect(enfileirarEmissao).toHaveBeenCalledOnce();
    expect(mensagens.some(m => m.includes('Denise Horta') && m.includes('coloquei na fila'))).toBe(true);
  });
});

describe('Fase 3 — Proatividade (manhã + 10 min pós-consulta + follow-up 24h) e Cadência WhatsApp', () => {
  it('mapeia agenda pela manhã, verifica 10 min após consulta, reagenda se atrasou e avisa quando finalizar', async () => {
    // 08:00 BRT de 21/11/2026
    let agora = new Date('2026-11-21T08:00:00-03:00');
    let finalizou = false;
    const mensagens: string[] = [];
    const prepararProativa = vi.fn().mockResolvedValue({
      ok: true,
      acao: 'enfileirada',
      caso: { pacienteNome: 'Lucas Bulcão', valorCentavos: 70000, ambiente: 'homologacao' }
    });

    const motor = criarMotorRotinaProativa({
      pool: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('revisao_diaria_agenda')) {
            return { rows: [{ conta_id: 'c1', telefone: '5551999990001' }] };
          }
          return { rows: [] };
        })
      } as any,
      repositorioCasos: {
        listarChavesConsultasComNota: async () => new Set<string>(),
        listarAbertosOuRecentes: async () => []
      },
      lerHorariosDoDia: async () => [{
        atendimentoId: 'at-1',
        paciente: 'Lucas Bulcão',
        inicioIso: '2026-11-21T09:00:00-03:00',
        fimIso: '2026-11-21T09:30:00-03:00',
        finalizado: false
      }],
      lerFinalizadosDoDiaDetalhado: async () => finalizou
        ? [{ data: '2026-11-21T09:00:00-03:00', paciente: 'Lucas Bulcão', valorCentavos: 70000, cpf: '52998224725', atendimentoId: 'at-1' }]
        : [],
      prepararEmissaoProativa: prepararProativa,
      enviarTextoMedico: async (_c, _t, txt) => { mensagens.push(txt); return true; },
      agora: () => agora
    });

    // 08:00: mapeia o horário (09:30 + 10 min = 09:40), não chama emissão ainda
    await motor.executarCiclo();
    expect(motor.obterAgendaPlanejada('c1')?.slots).toHaveLength(1);
    expect(prepararProativa).not.toHaveBeenCalled();

    // 09:40 (+10 min): médico ainda não clicou finalizar -> reagenda +20 min sem mandar spam
    agora = new Date('2026-11-21T09:40:00-03:00');
    await motor.executarCiclo();
    expect(prepararProativa).not.toHaveBeenCalled();
    expect(mensagens).toHaveLength(0);

    // 10:00 (+20 min de retentativa): médico finalizou -> prepara e avisa de forma humana!
    finalizou = true;
    agora = new Date('2026-11-21T10:00:00-03:00');
    await motor.executarCiclo();
    expect(prepararProativa).toHaveBeenCalledOnce();
    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]).toContain('Lucas Bulcão');
    expect(mensagens[0]).toContain('coloquei a nota na fila');
  });

  it('regras puras: reagendamento limitado, follow-up de CPF >24h e extração de horários TribeMD', () => {
    const slots = planejarHorariosDoDia({
      horariosHoje: [
        { atendimentoId: '1', paciente: 'Ana', inicioIso: '2026-11-21T10:00:00-03:00', fimIso: '2026-11-21T10:30:00-03:00', finalizado: false }
      ],
      chavesJaEmitidas: new Set(),
      diaIso: '2026-11-21',
      agoraMs: Date.parse('2026-11-21T08:00:00-03:00')
    });
    expect(selecionarSlotsParaVerificarAgora(slots, Date.parse('2026-11-21T10:39:00-03:00'))).toHaveLength(0);
    expect(selecionarSlotsParaVerificarAgora(slots, Date.parse('2026-11-21T10:40:00-03:00'))).toHaveLength(1);

    const r1 = reagendarSlotNaoFinalizado(slots[0]!, Date.parse('2026-11-21T10:40:00-03:00'));
    const r2 = reagendarSlotNaoFinalizado(r1, r1.proximaVerificacaoMs);
    const r3 = reagendarSlotNaoFinalizado(r2, r2.proximaVerificacaoMs);
    expect(r1.concluido).toBe(false);
    expect(r2.concluido).toBe(false);
    expect(r3.concluido).toBe(true);

    const travados = identificarCasosCpfTravados({
      casos: [{
        id: 'caso-cpf-1', contaId: 'c1', medicoId: 'm1', origem: 'comprovante_paciente',
        chaveIdempotencia: 'k', estado: 'aguardando_cpf_paciente', pacienteNome: 'Ana',
        pacienteTelefone: '5551999990000', pacienteCpf: null, pagadorNome: null, pagadorCpfHash: null,
        atendimentoExternoId: null, dataConsulta: '2026-11-20', valorCentavos: 50000,
        aprovadoPeloMedico: false, ambiente: 'homologacao', origemMensagemChave: null,
        solicitacaoId: null, notaFiscalId: null, erroMotivo: null,
        criadoEm: '2026-11-20T09:00:00-03:00', atualizadoEm: '2026-11-20T09:00:00-03:00'
      }],
      agoraMs: Date.parse('2026-11-21T11:00:00-03:00'),
      jaAvisados: new Set()
    });
    expect(travados).toHaveLength(1);

    expect(formatarAvisoProativoConsultas([{
      paciente: 'Ana', valorCentavos: null, acao: 'esclarecer_com_medico', valorSugeridoFormatado: 'R$ 600,00'
    }])).toContain('como na última consulta');

    const horariosTribemd = extrairHorariosDoDiaTribemd({
      atendimentos: [
        { id: 101, status: 1, datahora_marcada: '2026-11-21 14:00:00', pacientes: { nome: 'João Agendado' } },
        { id: 102, status: 3, datahora_marcada: '2026-11-21 15:00:00', pacientes: { nome: 'Cancelado' } },
        { id: 103, status: 10, datahora_atendimento: '2026-11-21 11:00:00', pacientes: { nome: 'Maria Finalizada' } }
      ]
    }, '2026-11-21');
    expect(horariosTribemd).toHaveLength(2);
    expect(horariosTribemd[0]).toMatchObject({ paciente: 'João Agendado', finalizado: false });
    expect(horariosTribemd[1]).toMatchObject({ paciente: 'Maria Finalizada', finalizado: true });
  });

  it('agrupa rajada de 3 mensagens curtas consecutivas em uma única execução unificada', async () => {
    const coalescedor = criarCoalescedorMensagens({ janelaMs: 40 });
    const p1 = coalescedor.aguardar('c1:tel', 'Oi');
    await new Promise(r => setTimeout(r, 15));
    const p2 = coalescedor.aguardar('c1:tel', 'emite a nota');
    await new Promise(r => setTimeout(r, 15));
    const p3 = coalescedor.aguardar('c1:tel', 'da Marina');

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.executar).toBe(false);
    expect(r2.executar).toBe(false);
    expect(r3.executar).toBe(true);
    expect(r3.textoUnificado).toBe('Oi\nemite a nota\nda Marina');
  });

  it('não reenvia link de cadastro de profissionais quando a agenda conecta depois do cadastro/A1/preferências já estarem prontos', async () => {
    const mensagens: string[] = [];
    const criarLinkProfissionais = vi.fn().mockResolvedValue({ ok: true, url: 'https://noto.test/c/profissionais/tok' });
    const porta: PortaEnvioOrquestracao = {
      enviarTexto: async (_tel, txt) => { mensagens.push(txt); return true; },
      criarLinkProfissionais,
      criarLinkCertificado: vi.fn(),
      criarLinkXml: vi.fn(),
      listarProfissionaisCadastrados: async () => [{
        id: 'med-1',
        nome: 'Alice Xavier',
        certificadoValido: true,
        dadosFiscaisProntos: true
      }],
      listarProfissionaisSemCertificado: async () => [],
      preferenciasJaConfiguradas: async () => true
    };

    await notificarAgendaConectadaEIniciarProfissionais(porta, {
      contaId: 'c1',
      nomeAgenda: 'TribeMD',
      conectado: true,
      telefone: '5551999990001'
    });

    expect(criarLinkProfissionais).not.toHaveBeenCalled();
    expect(mensagens.some(m => m.includes('/c/profissionais/'))).toBe(false);
    expect(mensagens[0]).toContain('Conexão com a agenda TribeMD confirmada');
    expect(mensagens[0]).toContain('100% pronto');
  });

  it('mantém frases naturais com vírgula inteiras no mesmo balão sem picotar no meio', () => {
    const baloes = separarBaloes(
      'Combinado! Quando o paciente mandar o comprovante no WhatsApp, eu já vejo a consulta na agenda e preparo a nota. Você prefere revisar e aprovar cada nota antes dela sair, ou quer que eu emita direto?'
    );
    expect(baloes).toEqual([
      'Combinado!',
      'Quando o paciente mandar o comprovante no WhatsApp, eu já vejo a consulta na agenda e preparo a nota.',
      'Você prefere revisar e aprovar cada nota antes dela sair, ou quer que eu emita direto?'
    ]);
  });

  it('aplica cortesia humana (Bom dia/Boa tarde/Boa noite, tudo bem? Desculpa incomodar...) após horas sem conversar e mantém direto na conversa ativa', () => {
    const noite = new Date('2026-11-21T21:30:00-03:00');
    const ultimaHa5Horas = new Date('2026-11-21T16:10:00-03:00').toISOString();

    const avHiato = avaliarCortesiaTemporal({
      agora: noite,
      ultimaInteracaoIso: ultimaHa5Horas,
      nomeProfissional: 'Dra. Alice Xavier'
    });
    expect(avHiato.hiatoLongo).toBe(true);
    expect(avHiato.saudacao).toBe('Boa noite');
    expect(avHiato.orientacaoCortesiaTurno).toContain('Boa noite, Alice! Tudo bem?');

    const msgProativaNoite = envolverMensagemProativaComCortesia({
      texto: 'Faltou o CPF da paciente Marina para eu fechar a nota. Você consegue me confirmar?',
      agora: noite,
      ultimaInteracaoIso: ultimaHa5Horas,
      nomeProfissional: 'Alice Xavier',
      ehPedidoDeAjudaOuDado: true
    });
    expect(msgProativaNoite).toContain('Boa noite, Alice! Tudo bem? Desculpa te incomodar a essa hora');
    expect(msgProativaNoite).toContain('você consegue me ajudar rapidinho');

    // Em conversa ativa (há 5 minutos), não repete saudação
    const ultimaHa5Min = new Date('2026-11-21T21:25:00-03:00').toISOString();
    const msgAtiva = envolverMensagemProativaComCortesia({
      texto: 'A nota da Marina entrou na fila.',
      agora: noite,
      ultimaInteracaoIso: ultimaHa5Min,
      nomeProfissional: 'Alice Xavier'
    });
    expect(msgAtiva).toBe('A nota da Marina entrou na fila.');
  });
});
