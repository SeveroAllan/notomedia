import { describe, expect, it } from 'vitest';
import { decidirProximaAcao, type EstadoMedicoAposOnboarding } from '../src/onboarding/regras/decidir-proxima-acao.js';
import { HistoricoComunicacaoEmMemoria } from '../src/onboarding/historico-comunicacao-repositorio.js';
import { orquestrarComunicacao } from '../src/onboarding/orquestrar-comunicacao.js';

const instante = '2026-10-18T12:00:00.000Z';
function estadoDoMedico(): Omit<EstadoMedicoAposOnboarding, 'historico'> & { agora: Date } {
  return {
    fiscal: { certificado: 'ok' as const, dadosFiscais: 'ok' as const },
    agenda: { nome: null as string | null, conectada: false },
    ultimaNota: null,
    agora: new Date(instante), intervaloReperguntaDias: 3
  };
}

describe('lembrete fiscal explícito na decisão pura', () => {
  it.each([
    [3, '2026-10-21T11:59:59.999Z', 0, 'nenhuma'],
    [3, '2026-10-21T12:00:00.000Z', 0, 'reperguntar'],
    [4, '2026-10-21T12:00:00.000Z', 0, 'nenhuma'],
    [undefined, '2027-10-21T12:00:00.000Z', 0, 'nenhuma'],
    [3, '2027-10-21T12:00:00.000Z', 1, 'nenhuma']
  ] as const)('intervalo %s, relógio %s e contador %s → %s', (intervalo, agora, repeticoes, tipo) => {
    const estado = {
      ...estadoDoMedico(), fiscal: { certificado: 'problema' as const, dadosFiscais: 'ok' as const },
      agora: new Date(agora), intervaloReperguntaDias: intervalo,
      historico: {
        problemaFiscalComunicado: true, problemaFiscal: { feitaEm: instante, repeticoes },
        boasVindasComunicadas: false,
        perguntaNota: { feitaEm: null, repeticoes: 0, resposta: null },
        perguntaAgenda: { feitaEm: null, repeticoes: 0 },
        agendasNaoAtendidasComunicadas: [], consultasListadas: false, aguardandoComprovanteComunicado: false
      }
    };
    expect(decidirProximaAcao(estado)).toEqual(tipo === 'reperguntar'
      ? { tipo, pergunta: 'problema_fiscal' } : { tipo });
  });
});

function cenario(historico = new HistoricoComunicacaoEmMemoria()) {
  const logs: Array<{ nivel: 'info' | 'erro'; mensagem: string }> = [];
  return {
    historico, logs,
    dependencias: { historico, log: (nivel: 'info' | 'erro', mensagem: string) => { logs.push({ nivel, mensagem }); } },
    entrada: { medicoId: 'medico-ficticio-a', chaveProcessamento: 'interacao-1', estado: estadoDoMedico() }
  };
}

describe('histórico por médico e modo', () => {
  it('persiste datas, contagem e resposta, que a decisão reutiliza', async () => {
    const { entrada, dependencias, historico } = cenario();
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'boas_vindas', ultimaNota: null });
    entrada.chaveProcessamento = 'interacao-2';
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'perguntar_nota_pendente' });
    let salvo = await historico.ler(entrada.medicoId, 'simulado');
    expect(salvo.boasVindasEm).toBe(instante);
    expect(salvo.perguntaNota).toEqual({ feitaEm: instante, repeticoes: 0, resposta: null });
    entrada.estado.agora = new Date('2026-10-21T12:00:00.000Z'); entrada.chaveProcessamento = 'interacao-3';
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'reperguntar', pergunta: 'nota_pendente' });
    const resposta = { temNota: false, desde: null };
    await historico.gravarResposta(entrada.medicoId, 'simulado', resposta, '2026-10-21T13:00:00.000Z');
    resposta.temNota = true;
    entrada.chaveProcessamento = 'interacao-4';
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'aguardar_comprovante' });
    salvo = await historico.ler(entrada.medicoId, 'simulado');
    expect(salvo.perguntaNota).toEqual({ feitaEm: instante, repeticoes: 1, resposta: { temNota: false, desde: null } });
    expect(salvo.respostaRecebidaEm).toBe('2026-10-21T13:00:00.000Z');
    entrada.chaveProcessamento = 'interacao-5';
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'nenhuma' });
  });

  it('isola históricos e médicos, mas respeita boas-vindas reais em modo simulado', async () => {
    const { entrada, dependencias, historico } = cenario();
    await historico.reservar(entrada.medicoId, 'real', 'fixture-real');
    await historico.gravarAcao(entrada.medicoId, 'real', 'fixture-real', { tipo: 'boas_vindas', ultimaNota: null }, instante);
    await historico.liberar(entrada.medicoId, 'real', 'fixture-real');
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'perguntar_nota_pendente' });
    const simulado = await historico.ler(entrada.medicoId, 'simulado');
    expect(simulado.registros).toEqual([{ modo: 'simulado', chaveProcessamento: 'interacao-1', tipo: 'perguntar_nota_pendente', quando: instante }]);
    expect((await historico.ler(entrada.medicoId, 'real')).registros[0].modo).toBe('real');
    expect((await historico.ler('medico-ficticio-b', 'simulado')).boasVindasEm).toBeNull();
    simulado.registros.length = 0; simulado.boasVindasComunicadas = true;
    expect((await historico.ler(entrada.medicoId, 'simulado')).registros).toHaveLength(1);
    expect((await historico.ler(entrada.medicoId, 'simulado')).boasVindasComunicadas).toBe(false);
    expect((await historico.ler(entrada.medicoId, 'real')).registros).toHaveLength(1);
    expect((await historico.ler(entrada.medicoId, 'real')).boasVindasEm).toBe(instante);
  });

  it('registra pedido de agenda e listagem sem voltar a perguntar ou listar', async () => {
    const { entrada, dependencias, historico } = cenario();
    await orquestrarComunicacao(entrada, dependencias);
    entrada.chaveProcessamento = 'pergunta'; await orquestrarComunicacao(entrada, dependencias);
    await historico.gravarResposta(entrada.medicoId, 'simulado', { temNota: true, desde: '2026-10-01' }, instante);
    entrada.chaveProcessamento = 'agenda';
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'pedir_agenda', agendaInformada: null });
    expect((await historico.ler(entrada.medicoId, 'simulado')).perguntaAgenda.feitaEm).toBe(instante);
    entrada.chaveProcessamento = 'agenda-repetida';
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'nenhuma' });
    entrada.estado.agenda = { nome: 'TribeMD', conectada: true }; entrada.chaveProcessamento = 'listar';
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'listar_consultas_sem_nota', agenda: 'tribemd', desde: '2026-10-01' });
    entrada.chaveProcessamento = 'listar-repetida';
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'nenhuma' });
  });

  it('guarda interesse em agenda não atendida e não repete o aviso', async () => {
    const { entrada, dependencias, historico } = cenario();
    await orquestrarComunicacao(entrada, dependencias);
    entrada.chaveProcessamento = 'pergunta'; await orquestrarComunicacao(entrada, dependencias);
    entrada.estado.agenda.nome = 'iClinic'; entrada.chaveProcessamento = 'aviso';
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'agenda_nao_atendida', agenda: 'iClinic', registrarInteresse: true });
    expect((await historico.ler(entrada.medicoId, 'simulado')).agendasNaoAtendidasComunicadas).toEqual(['iClinic']);
    entrada.chaveProcessamento = 'aviso-repetido';
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'nenhuma' });
  });
});

describe('orquestração seca e idempotente', () => {
  it('duas execuções iguais dão uma ação e depois nenhuma, com um único log seco', async () => {
    const { entrada, dependencias, historico, logs } = cenario();
    const antes = structuredClone(entrada);
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'boas_vindas', ultimaNota: null });
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'nenhuma' });
    expect(logs).toEqual([{ nivel: 'info', mensagem: 'enviaria boas_vindas' }]);
    expect((await historico.ler(entrada.medicoId, 'simulado')).registros).toHaveLength(1);
    expect(entrada).toEqual(antes);
  });

  it('grava antes de anunciar que enviaria, com envio real explicitamente desligado', async () => {
    const { entrada, historico } = cenario();
    const observacoes: Array<Promise<string | null>> = [];
    await orquestrarComunicacao(entrada, { historico, envioRealAtivo: false, log: () => {
      observacoes.push(historico.ler(entrada.medicoId, 'simulado').then(salvo => salvo.boasVindasEm));
    } });
    expect(await Promise.all(observacoes)).toEqual([instante]);
  });

  it('falha de gravação não gera saída nem repetição da tentativa e não vaza o erro', async () => {
    class HistoricoComFalha extends HistoricoComunicacaoEmMemoria {
      tentativas = 0;
      override async gravarAcao(): Promise<void> { this.tentativas++; throw new Error('senha-ficticia-que-nao-pode-ir-ao-log'); }
    }
    const { entrada, dependencias, historico, logs } = cenario(new HistoricoComFalha());
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'nenhuma' });
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'nenhuma' });
    expect((historico as HistoricoComFalha).tentativas).toBe(1);
    expect(logs).toEqual([{ nivel: 'erro', mensagem: 'HISTORICO_COMUNICACAO_FALHOU' }]);
    expect((await historico.ler(entrada.medicoId, 'simulado')).registros).toEqual([]);
  });

  it('falha de leitura não produz ação nem log de envio', async () => {
    class HistoricoComFalhaDeLeitura extends HistoricoComunicacaoEmMemoria {
      override async ler(): Promise<never> { throw new Error('falha-ficticia'); }
    }
    const { entrada, dependencias, logs } = cenario(new HistoricoComFalhaDeLeitura());
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'nenhuma' });
    expect(logs).toEqual([{ nivel: 'erro', mensagem: 'HISTORICO_COMUNICACAO_FALHOU' }]);
  });

  it.each(['interacao-1', 'interacao-concorrente'])('duas execuções simultâneas, segunda chave %s, têm uma única ação', async chave => {
    const { entrada, dependencias, historico, logs } = cenario();
    const resultados = await Promise.all([
      orquestrarComunicacao(entrada, dependencias),
      orquestrarComunicacao({ ...entrada, chaveProcessamento: chave }, dependencias)
    ]);
    expect(resultados).toEqual([{ tipo: 'boas_vindas', ultimaNota: null }, { tipo: 'nenhuma' }]);
    expect(logs).toEqual([{ nivel: 'info', mensagem: 'enviaria boas_vindas' }]);
    expect((await historico.ler(entrada.medicoId, 'simulado')).registros).toHaveLength(1);
  });

  it('médicos distintos podem processar simultaneamente a mesma chave', async () => {
    const { entrada, dependencias } = cenario();
    expect(await Promise.all([
      orquestrarComunicacao(entrada, dependencias),
      orquestrarComunicacao({ ...entrada, medicoId: 'medico-ficticio-b' }, dependencias)
    ])).toEqual([{ tipo: 'boas_vindas', ultimaNota: null }, { tipo: 'boas_vindas', ultimaNota: null }]);
  });
});

describe('problema fiscal persistido bloqueia avanço e só recebe um lembrete', () => {
  it('guarda data, respeita intervalo configurado e persiste a única repetição', async () => {
    const { entrada, dependencias, historico } = cenario();
    entrada.estado.fiscal.certificado = 'problema';
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'problema_fiscal', campos: ['certificado'] });
    expect((await historico.ler(entrada.medicoId, 'simulado')).problemaFiscal).toEqual({ feitaEm: instante, repeticoes: 0 });
    entrada.chaveProcessamento = 'antes-prazo'; entrada.estado.agora = new Date('2026-10-20T12:00:00Z');
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'nenhuma' });
    entrada.chaveProcessamento = 'no-prazo'; entrada.estado.agora = new Date('2026-10-21T12:00:00Z');
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'reperguntar', pergunta: 'problema_fiscal' });
    entrada.chaveProcessamento = 'muito-depois'; entrada.estado.agora = new Date('2027-10-21T12:00:00Z');
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'nenhuma' });
    const salvo = await historico.ler(entrada.medicoId, 'simulado');
    expect(salvo.problemaFiscal).toEqual({ feitaEm: instante, repeticoes: 1 });
    expect(salvo.boasVindasEm).toBeNull();
  });
});
