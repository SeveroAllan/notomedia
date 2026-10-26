import { describe, expect, it } from 'vitest';
import type { EnviarMensagemPaciente, EnviarMensagemPacienteParams } from '../src/whatsapp/enviar-mensagem-paciente.js';
import { HistoricoComunicacaoEmMemoria } from '../src/onboarding/historico-comunicacao-repositorio.js';
import { orquestrarComunicacao } from '../src/onboarding/orquestrar-comunicacao.js';
import { montarBoasVindas } from '../src/onboarding/regras/decidir-proxima-acao.js';

class TransporteFalso implements EnviarMensagemPaciente {
  tentativas: EnviarMensagemPacienteParams[] = [];
  confirmadas: EnviarMensagemPacienteParams[] = [];
  emAndamento = 0;
  maximoEmAndamento = 0;
  constructor(private falharNoBalao?: number) {}
  async enviarTexto(params: EnviarMensagemPacienteParams) {
    this.tentativas.push(structuredClone(params));
    this.emAndamento++;
    this.maximoEmAndamento = Math.max(this.maximoEmAndamento, this.emAndamento);
    await Promise.resolve();
    this.emAndamento--;
    if (this.tentativas.length === this.falharNoBalao) return { sucesso: false, erro: 'erro-ficticio-privado' };
    this.confirmadas.push(structuredClone(params));
    return { sucesso: true, mensagemId: `falso-${this.confirmadas.length}` };
  }
}

const instante = '2026-10-18T12:00:00.000Z';
const nota = { paciente: 'Paciente Exemplo', dataEmissao: '2026-10-18', valorCentavos: 35000, diasDesdeEmissao: 0 };
function cenario(historico = new HistoricoComunicacaoEmMemoria(), transporte = new TransporteFalso()) {
  const logs: Array<{ nivel: 'info' | 'erro'; mensagem: string }> = [];
  void historico.semearPerguntaAgendaFeita('medico-ficticio', 'real', '2026-01-01T00:00:00.000Z'); void historico.semearPerguntaAgendaFeita('medico-ficticio', 'simulado', '2026-01-01T00:00:00.000Z'); 
  return {
    historico, transporte, logs,
    entrada: {
      medicoId: 'medico-ficticio', chaveProcessamento: 'evento-ficticio', nomeMedico: 'Ana Exemplo',
      instanciaNome: 'instancia-ficticia', contatoTelefone: 'destino-ficticio',
      estado: {
        fiscal: { certificado: 'ok' as const, dadosFiscais: 'ok' as const },
        agenda: { nome: null, conectada: false }, ultimaNota: nota,
        agora: new Date(instante), intervaloReperguntaDias: 3
      }
    },
    dependencias: { historico, transporte, envioRealAtivo: true,
      log: (nivel: 'info' | 'erro', mensagem: string) => { logs.push({ nivel, mensagem }); } }
  };
}

describe('envio habilitado apenas com transporte falso nos testes', () => {
  it('envia os cinco balões em ordem e só registra enviado após todas as confirmações', async () => {
    const historico = new HistoricoComunicacaoEmMemoria();
    const observacoes: Array<{ boasVindasEm: string | null; registros: number; baloes: number[] }> = [];
    class TransporteObservado extends TransporteFalso {
      override async enviarTexto(params: EnviarMensagemPacienteParams) {
        const salvo = await historico.ler('medico-ficticio', 'real');
        observacoes.push({ boasVindasEm: salvo.boasVindasEm, registros: salvo.registros.length,
          baloes: [...salvo.envios[0].baloesEnviados] });
        return super.enviarTexto(params);
      }
    }
    const { entrada, dependencias, transporte } = cenario(historico, new TransporteObservado());
    expect((await orquestrarComunicacao(entrada, dependencias)).tipo).toBe('boas_vindas');
    expect(transporte.confirmadas).toEqual(montarBoasVindas('Ana Exemplo', nota).map(texto => ({
      instanciaNome: 'instancia-ficticia', contatoTelefone: 'destino-ficticio', texto
    })));
    expect(transporte.maximoEmAndamento).toBe(1);
    expect(observacoes).toEqual([[], [0], [0, 1], [0, 1, 2], [0, 1, 2, 3]].map(baloes => ({ boasVindasEm: null, registros: 0, baloes })));
    const salvo = await historico.ler(entrada.medicoId, 'real');
    expect(salvo.boasVindasEm).toBe(instante);
    expect(salvo.registros).toEqual([{ modo: 'real', estado: 'enviado', chaveProcessamento: entrada.chaveProcessamento,
      tipo: 'boas_vindas', quando: instante }]);
    expect(salvo.envios[0].baloesEnviados).toEqual([0, 1, 2, 3, 4]);
    expect((await historico.ler(entrada.medicoId, 'simulado')).registros).toEqual([]);
  });

  it('envia quatro balões com pergunta final quando não há última nota', async () => {
    const { entrada, dependencias, transporte } = cenario();
    await orquestrarComunicacao({ ...entrada, estado: { ...entrada.estado, ultimaNota: null } }, dependencias);
    expect(transporte.confirmadas.map(params => params.texto)).toEqual(montarBoasVindas('Ana Exemplo', null));
  });

  it.each([2, 3, 5])('falha no balão %s interrompe e não reenvia os anteriores com nenhuma chave', async falharNoBalao => {
    const { entrada, dependencias, transporte, historico, logs } = cenario(undefined, new TransporteFalso(falharNoBalao));
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'nenhuma' });
    const salvo = await historico.ler(entrada.medicoId, 'real');
    expect(salvo.boasVindasEm).toBeNull();
    expect(salvo.registros).toEqual([]);
    expect(salvo.envios[0].baloesEnviados).toEqual(Array.from({ length: falharNoBalao - 1 }, (_, indice) => indice));
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'nenhuma' });
    expect(await orquestrarComunicacao({ ...entrada, chaveProcessamento: 'outro-evento' }, dependencias)).toEqual({ tipo: 'nenhuma' });
    expect(transporte.tentativas).toHaveLength(falharNoBalao);
    expect(transporte.confirmadas).toHaveLength(falharNoBalao - 1);
    expect(logs).toEqual([{ nivel: 'erro', mensagem: 'COMUNICACAO_TRANSPORTE_FALHOU' }]);
  });

  it('exceção no transporte não marca confirmação nem repete a ação', async () => {
    class TransporteComExcecao extends TransporteFalso {
      override async enviarTexto(): Promise<never> { throw new Error('erro-ficticio-privado'); }
    }
    const { entrada, dependencias, historico, logs } = cenario(undefined, new TransporteComExcecao());
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'nenhuma' });
    expect((await historico.ler(entrada.medicoId, 'real')).envios[0].baloesEnviados).toEqual([]);
    expect(logs).toEqual([{ nivel: 'erro', mensagem: 'COMUNICACAO_TRANSPORTE_FALHOU' }]);
    expect(await orquestrarComunicacao({ ...entrada, chaveProcessamento: 'novo-evento' }, dependencias)).toEqual({ tipo: 'nenhuma' });
  });

  it('duas execuções seguidas enviam uma única vez', async () => {
    const { entrada, dependencias, transporte } = cenario();
    await orquestrarComunicacao(entrada, dependencias);
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'nenhuma' });
    expect(transporte.confirmadas).toHaveLength(5);
  });

  it('duas execuções simultâneas enviam uma única vez', async () => {
    const { entrada, dependencias, transporte } = cenario();
    const resultados = await Promise.all([
      orquestrarComunicacao(entrada, dependencias),
      orquestrarComunicacao({ ...entrada, chaveProcessamento: 'outro-evento' }, dependencias)
    ]);
    expect(resultados.map(acao => acao.tipo)).toEqual(['boas_vindas', 'nenhuma']);
    expect(transporte.confirmadas).toHaveLength(5);
  });

  it('falha na reserva do envio impede qualquer chamada ao transporte', async () => {
    class HistoricoComFalha extends HistoricoComunicacaoEmMemoria {
      override async reservarEnvio(): Promise<never> { throw new Error('falha-ficticia'); }
    }
    const { entrada, dependencias, transporte, logs } = cenario(new HistoricoComFalha());
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'nenhuma' });
    expect(transporte.tentativas).toEqual([]);
    expect(logs).toEqual([{ nivel: 'erro', mensagem: 'HISTORICO_COMUNICACAO_FALHOU' }]);
  });

  it('falha ao gravar a confirmação interrompe e não permite reenvio', async () => {
    class HistoricoComFalha extends HistoricoComunicacaoEmMemoria {
      override async confirmarBalao(): Promise<never> { throw new Error('falha-ficticia'); }
    }
    const { entrada, dependencias, transporte, historico, logs } = cenario(new HistoricoComFalha());
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'nenhuma' });
    expect(await orquestrarComunicacao({ ...entrada, chaveProcessamento: 'outra-chave' }, dependencias)).toEqual({ tipo: 'nenhuma' });
    expect(transporte.confirmadas).toHaveLength(1);
    const salvo = await historico.ler(entrada.medicoId, 'real');
    expect(salvo.boasVindasEm).toBeNull(); expect(salvo.registros).toEqual([]);
    expect(logs).toEqual([{ nivel: 'erro', mensagem: 'HISTORICO_COMUNICACAO_FALHOU' }]);
  });

  it('falha na gravação final não reenvia balões já confirmados', async () => {
    class HistoricoComFalha extends HistoricoComunicacaoEmMemoria {
      override async gravarAcao(): Promise<never> { throw new Error('falha-ficticia'); }
    }
    const { entrada, dependencias, transporte, historico, logs } = cenario(new HistoricoComFalha());
    expect(await orquestrarComunicacao(entrada, dependencias)).toEqual({ tipo: 'nenhuma' });
    expect(await orquestrarComunicacao({ ...entrada, chaveProcessamento: 'outra-chave' }, dependencias)).toEqual({ tipo: 'nenhuma' });
    expect(transporte.confirmadas).toHaveLength(5);
    expect((await historico.ler(entrada.medicoId, 'real')).registros).toEqual([]);
    expect(logs).toEqual([{ nivel: 'erro', mensagem: 'HISTORICO_COMUNICACAO_FALHOU' }]);
  });

  it('não inventa texto nem marca enviada uma ação sem balões aprovados', async () => {
    const { entrada, dependencias, transporte, historico } = cenario();
    await orquestrarComunicacao(entrada, dependencias);
    const acao = await orquestrarComunicacao({ ...entrada, chaveProcessamento: 'pergunta-seguinte' }, dependencias);
    expect(acao).toEqual({ tipo: 'perguntar_nota_pendente' });
    expect(transporte.confirmadas).toHaveLength(5);
    expect((await historico.ler(entrada.medicoId, 'real')).perguntaNota.feitaEm).toBeNull();
  });
});

describe('flag desligada preserva modo seco independentemente do transporte configurado', () => {
  it.each([false, undefined])('envioRealAtivo=%s não consulta nem chama a porta do transporte', async envioRealAtivo => {
    const { entrada, dependencias, transporte, historico, logs } = cenario();
    let acessos = 0;
    await orquestrarComunicacao(entrada, { ...dependencias, envioRealAtivo,
      get transporte() { acessos++; return transporte; } });
    expect(acessos).toBe(0);
    expect(transporte.tentativas).toEqual([]);
    expect(logs).toEqual([{ nivel: 'info', mensagem: 'enviaria boas_vindas' }]);
    expect((await historico.ler(entrada.medicoId, 'simulado')).boasVindasEm).toBe(instante);
    expect((await historico.ler(entrada.medicoId, 'real')).registros).toEqual([]);
  });
});

it.each(['orquestrador real', 'outro caminho real'])('boas-vindas recebidas via %s não são reenviadas pelo modo simulado', async caminho => {
  const c = cenario();
  if (caminho === 'orquestrador real') await orquestrarComunicacao(c.entrada, c.dependencias);
  else {
    await c.historico.reservar(c.entrada.medicoId, 'real', 'externo');
    await c.historico.gravarAcao(c.entrada.medicoId, 'real', 'externo', { tipo: 'boas_vindas', ultimaNota: nota }, instante);
    await c.historico.liberar(c.entrada.medicoId, 'real', 'externo');
  }
  const antes = c.transporte.confirmadas.length;
  expect((await c.historico.ler(c.entrada.medicoId, 'simulado')).boasVindasComunicadas).toBe(false);
  expect(await orquestrarComunicacao({ ...c.entrada, chaveProcessamento: 'conversa-livre' }, { ...c.dependencias, envioRealAtivo: false }))
    .toEqual({ tipo: 'perguntar_nota_pendente' });
  expect(c.transporte.confirmadas).toHaveLength(antes);
  expect((await c.historico.ler(c.entrada.medicoId, 'simulado')).registros.map(r => r.tipo)).toEqual(['perguntar_nota_pendente']);
});
it('boas-vindas apenas simuladas não suprimem o primeiro envio real', async () => {
  const c = cenario();
  await orquestrarComunicacao(c.entrada, { ...c.dependencias, envioRealAtivo: false });
  expect(await orquestrarComunicacao({ ...c.entrada, chaveProcessamento: 'real' }, c.dependencias)).toEqual({ tipo: 'boas_vindas', ultimaNota: nota });
  expect(c.transporte.confirmadas).toHaveLength(5);
});
