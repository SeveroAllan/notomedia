import { describe, expect, it, vi } from 'vitest';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import { responderAgente } from '../src/agente/agente.js';
import { humanizarSaidaWhatsApp, repararMojibakeUtf8 } from '../src/agente/humanizar-saida-whatsapp.js';
import { higienizarComunicacaoProfissional } from '../src/agente/regras/higienizar-comunicacao-profissional.js';
import { criarFilaTurnosConversa } from '../src/agente/fila-turnos-conversa.js';
import {
  combinarConteudoBloco,
  montarBlocoEstadoVivo,
  sanitizarConteudoBloco,
  type BlocoMemoriaNucleo,
  type RotuloBlocoMemoria
} from '../src/agente/memoria/blocos-memoria-config.js';
import type { BlocosMemoriaRepositorio } from '../src/agente/memoria/blocos-memoria-repositorio.js';
import { criarServicoBlocosMemoria } from '../src/agente/memoria/gerenciar-blocos-memoria.js';
import { criarConsolidadorSleepTime } from '../src/agente/memoria/sleep-time-consolidacao.js';
import type { EstadoProntidaoConta } from '../src/agente/estado-prontidao-conta.js';

function criarRepoBlocosMemoriaEmMemoria(): BlocosMemoriaRepositorio & {
  dados: Map<string, BlocoMemoriaNucleo>;
} {
  const dados = new Map<string, BlocoMemoriaNucleo>();
  const chave = (contaId: string, rotulo: RotuloBlocoMemoria) => `${contaId}:${rotulo}`;
  return {
    dados,
    async listarBlocos(contaId) {
      return [...dados.values()].filter(b => b.contaId === contaId);
    },
    async salvarBloco(entrada) {
      const k = chave(entrada.contaId, entrada.rotulo);
      const anterior = dados.get(k);
      const bloco: BlocoMemoriaNucleo = {
        contaId: entrada.contaId,
        rotulo: entrada.rotulo,
        conteudo: sanitizarConteudoBloco(entrada.conteudo),
        versao: (anterior?.versao ?? 0) + 1,
        atualizadoPor: entrada.atualizadoPor,
        atualizadoEm: new Date().toISOString()
      };
      dados.set(k, bloco);
      return bloco;
    }
  };
}

describe('humanizarSaidaWhatsApp (filtro PT-BR anti-robô)', () => {
  it('remove encerramentos de call center sem alterar fatos, valores, datas ou nomes', () => {
    const entrada1 = 'Certificado da Alice Xavier já está em dia e os dados fiscais estão prontos.\nPosso ajudar com mais alguma coisa agora?';
    expect(humanizarSaidaWhatsApp(entrada1)).toBe(
      'Certificado da Alice Xavier já está em dia e os dados fiscais estão prontos.'
    );

    const entrada2 = 'Coloquei na fila a nota de Marina Costa (R$ 800,00, 28/09/2026). Quer que eu confira novamente ou ajudo com outra coisa?';
    expect(humanizarSaidaWhatsApp(entrada2)).toBe(
      'Coloquei na fila a nota de Marina Costa (R$ 800,00, 28/09/2026).'
    );

    const entrada3 = 'Beleza, anotei que você prefere resumo curtinho. Qualquer dúvida, estou à disposição!';
    expect(humanizarSaidaWhatsApp(entrada3)).toBe(
      'Beleza, anotei que você prefere resumo curtinho.'
    );

    const entrada4 = 'Pronto, ficou salvo aqui.\nSe precisar, só chamar.';
    expect(humanizarSaidaWhatsApp(entrada4)).toBe('Pronto, ficou salvo aqui.');

    const entrada5 = 'Beleza, Dra. Alice. Já anotei aqui a revisão toda sexta. O que quer fazer agora?';
    expect(humanizarSaidaWhatsApp(entrada5)).toBe('Beleza, Dra. Alice. Já anotei aqui a revisão toda sexta.');
  });

  it('remove gerundismo, conectivos burocráticos e negrito markdown preservando URLs e JSON', () => {
    const texto = 'Vale ressaltar que vou estar verificando a nota de **Marina** (R$ 800,00) e estarei enviando pelo link https://exemplo.com/a/b.';
    expect(humanizarSaidaWhatsApp(texto)).toBe(
      'Vou verificar a nota de Marina (R$ 800,00) e vou enviar pelo link https://exemplo.com/a/b.'
    );

    const json = '{"texto":"Oi","fatos":{"vinculo":"confirmado"}}';
    expect(humanizarSaidaWhatsApp(json)).toBe(json);
  });

  it('elimina redundância, espaços colados, pergunta dupla, pleonasmo, gerundismo, muletas e cacofonia', () => {
    const casoReal2215 =
      'As notas das 4 consultas de 28/09 deram erro na homologação. Vou investigar o problema e aviso você assim que souber o motivo.As notas do dia 28/09 que deram erro na homologação ainda estão em análise técnica.Se quiser, posso tentar reenviar assim que resolver.Quer que eu faça isso?';
    const limpo = humanizarSaidaWhatsApp(casoReal2215);
    expect(limpo).toBe(
      'As notas das 4 consultas de 28/09 deram erro na homologação. Vou investigar o problema e aviso você assim que souber o motivo. Se quiser, posso tentar reenviar assim que resolver.'
    );
    expect(limpo).not.toContain('análise técnica');
    expect(limpo).not.toContain('Quer que eu faça isso?');

    const multilinhas = 'Se quiser, posso tentar reenviar agora.\nQuer que eu faça isso?';
    expect(higienizarComunicacaoProfissional(multilinhas)).toBe('Se quiser, posso tentar reenviar agora.');

    const vicios =
      'Na verdade, tipo assim, vou estar transferindo a consulta há 2 anos atrás para entrar para dentro do elo de ligação por cada atendimento né?';
    expect(higienizarComunicacaoProfissional(vicios)).toBe(
      'Vou transferir a consulta há 2 anos para entrar do elo a cada atendimento'
    );

    expect(higienizarComunicacaoProfissional('Eu vi ela ontem na clínica da Dra.Alice.')).toBe(
      'Eu a vi ontem na clínica da Dra.Alice.'
    );
  });

  it('preserva fatos distintos (pacientes, valores e datas diferentes) sem deduplicar indevidamente', () => {
    const listaPacientes = [
      'Marina (R$ 800,00 em 28/09/2026): nota autorizada.',
      'Lucas (R$ 800,00 em 28/09/2026): nota autorizada.'
    ].join('\n');
    expect(humanizarSaidaWhatsApp(listaPacientes)).toBe(listaPacientes);
  });

  it('preserva ofertas reais de próximo passo e nunca deixa mensagem vazia', () => {
    const oferta = 'O link expirou. Quer que eu mande outro link seguro para o certificado?';
    expect(humanizarSaidaWhatsApp(oferta)).toBe(oferta);

    const soMuleta = 'Posso ajudar com mais alguma coisa?';
    expect(humanizarSaidaWhatsApp(soMuleta)).toBe(soMuleta);
  });
});

describe('blocos de memória núcleo (Letta Core Memory)', () => {
  it('sanitiza CPFs, links de cofre e credenciais, e deduplica linhas', () => {
    const sujo = [
      'Gosta de ser chamada de Dra. Alice',
      'gosta de ser chamada de dra. alice',
      'CPF do paciente: 123.456.789-01 e outro 98765432100',
      'Link antigo https://noto.app/c/tokensecreto123',
      'senha: minhaSenhaSecreta123'
    ].join('\n');

    const limpo = sanitizarConteudoBloco(sujo);
    expect(limpo).toContain('Gosta de ser chamada de Dra. Alice');
    expect(limpo.split('\n').filter(l => l.toLowerCase().includes('dra. alice'))).toHaveLength(1);
    expect(limpo).not.toContain('123.456.789-01');
    expect(limpo).not.toContain('98765432100');
    expect(limpo).not.toContain('tokensecreto123');
    expect(limpo).not.toContain('minhaSenhaSecreta123');
  });

  it('monta estado_vivo_consultorio lidando com etapas fora de ordem e casos abertos', () => {
    const estadoForaDeOrdem: EstadoProntidaoConta = {
      agenda: { conectada: true, provedor: 'tribemd', nomeAgenda: 'TribeMD' },
      profissionais: [{
        id: 'med-1',
        nomeCompleto: 'Alice Xavier',
        crm: '12345/RS',
        rqe: null,
        certificadoValido: false,
        dadosFiscaisProntos: false
      }],
      proximaEtapa: 'enviar_certificados',
      profissionaisSemCertificado: [{ id: 'med-1', nome: 'Alice Xavier' }],
      profissionaisSemFiscal: [],
      preferenciasEmissao: {
        valores: {
          emitirApenasComComprovante: true,
          revisaoDiariaAgenda: false,
          enviarNotaParaPaciente: false,
          pedirAprovacaoAntesDeEmitir: true,
          solicitarCpfDiretoPaciente: false
        },
        pendentes: [],
        completas: true,
        proximoAssunto: null,
        comoFuncionaNaPratica: null,
        resumoCombinado: ['emitir só com comprovante', 'pedir ok antes']
      }
    };

    const bloco = montarBlocoEstadoVivo(estadoForaDeOrdem, [{
      estado: 'aguardando_prontidao_fiscal',
      pacienteNome: 'Marina Costa',
      dataConsulta: '28/09/2026',
      valorFormatado: 'R$ 800,00',
      ambiente: 'homologacao'
    }]);

    expect(bloco).toContain('Agenda conectada: TribeMD');
    expect(bloco).toContain('Alice Xavier (CRM 12345/RS): sem A1, fiscal pendente');
    expect(bloco).toContain('Preferências de emissão (completas');
    expect(bloco).toContain('emitir só com comprovante; pedir ok antes');
    expect(bloco).toContain('Próxima etapa operacional: enviar_certificados');
    expect(bloco).toContain('Marina Costa (R$ 800,00 28/09/2026): aguardando_prontidao_fiscal [homologacao]');
  });

  it('combina bloco com acrescentar/substituir e sincroniza estado vivo no serviço', async () => {
    expect(combinarConteudoBloco({
      atual: 'Chamar de Dra. Alice',
      novo: 'Resumo sempre curto',
      operacao: 'acrescentar'
    })).toBe('Chamar de Dra. Alice\nResumo sempre curto');

    const repo = criarRepoBlocosMemoriaEmMemoria();
    const servico = criarServicoBlocosMemoria({
      repositorio: repo,
      obterEstadoVivo: async () => 'Agenda conectada: TribeMD\nPróxima etapa operacional: pronto'
    });

    await servico.atualizarPeloAgente('conta-1', {
      rotulo: 'perfil_medico',
      operacao: 'acrescentar',
      conteudo: 'Chamar de Dra. Alice'
    });
    const prompt = await servico.carregarParaPrompt('conta-1');

    expect(prompt).toEqual({
      perfil_medico: 'Chamar de Dra. Alice',
      estado_vivo_consultorio: 'Agenda conectada: TribeMD\nPróxima etapa operacional: pronto',
      pendencias_e_combinados: ''
    });
  });

  it('injeta memoriaNucleo no agente, executa atualizar_memoria_nucleo e humaniza a resposta', async () => {
    const repo = criarRepoBlocosMemoriaEmMemoria();
    const servico = criarServicoBlocosMemoria({
      repositorio: repo,
      obterEstadoVivo: async () => 'Agenda conectada: TribeMD\nAlice Xavier: A1 válido, fiscal pronto'
    });
    const memoriaNucleo = await servico.carregarParaPrompt('conta-1');

    const modelo = new ScriptedModel([
      [functionCall('atualizar_memoria_nucleo', {
        rotulo: 'perfil_medico',
        operacao: 'acrescentar',
        conteudo: 'Prefere ser chamada de Dra. Alice e receber resumos curtos'
      }, { callId: 'mem-1' })],
      [assistantMessage('Combinado, Dra. Alice! Vou deixar sempre bem curtinho por aqui.\nPosso ajudar com mais alguma coisa agora?')]
    ]);
    const diagnostico = vi.fn();

    const resposta = await responderAgente({
      texto: 'Pode me chamar de Dra. Alice e mandar tudo bem curtinho',
      profissionais: [{ id: 'med-1', nome: 'Alice Xavier' }],
      memoriaNucleo: memoriaNucleo ?? undefined
    }, {
      modeloTeste: modelo,
      consultarStatus: vi.fn().mockResolvedValue({
        tribemd: { salvo: true, conectada: true },
        amplimed: { salvo: false, conectada: false }
      }),
      aoDiagnostico: diagnostico,
      onboardingAutonomo: {
        atualizarMemoriaNucleo: entrada => servico.atualizarPeloAgente('conta-1', entrada)
      }
    });

    expect(resposta).toBe('Combinado, Dra. Alice! Vou deixar sempre bem curtinho por aqui.');
    expect(JSON.stringify(modelo.lastCall?.request.input)).toContain('estado_vivo_consultorio');
    expect(JSON.stringify(modelo.lastCall?.request.input)).toContain('A1 válido, fiscal pronto');
    expect(diagnostico).toHaveBeenCalledWith(expect.objectContaining({
      codigo: 'RESPOSTA',
      ferramentas: [expect.objectContaining({
        nome: 'atualizar_memoria_nucleo',
        codigo: 'MEMORIA_NUCLEO_ATUALIZADA'
      })]
    }));
    const blocosSalvos = await repo.listarBlocos('conta-1');
    expect(blocosSalvos.find(b => b.rotulo === 'perfil_medico')?.conteudo).toContain('Dra. Alice');
    modelo.assertComplete();
  });
});

describe('Sleep-Time Consolidator (Letta background memory refactor)', () => {
  it('remove pendências já resolvidas pelo estado vivo, deduplica perfil e respeita cooldown', async () => {
    const repo = criarRepoBlocosMemoriaEmMemoria();
    await repo.salvarBloco({
      contaId: 'conta-1',
      rotulo: 'pendencias_e_combinados',
      conteudo: 'Certificado A1 da Alice ainda pendente\nAvisar quando nota da Marina sair',
      atualizadoPor: 'agente'
    });

    const consolidarMock = vi.fn().mockResolvedValue({
      perfilMedico: 'Prefere ser chamada de Dra. Alice\nResumos curtos',
      pendenciasECombinados: 'Avisar quando nota da Marina sair'
    });

    let relogio = 100_000;
    const sleepTime = criarConsolidadorSleepTime({
      blocosRepo: repo,
      memoriaConversa: {
        carregarContexto: vi.fn().mockResolvedValue({
          turnosCurtoPrazo: [
            'Médico: Me chama de Dra. Alice',
            'Noto: Combinado, Dra. Alice!'
          ],
          resumosLongoPrazo: []
        })
      },
      obterEstadoVivo: vi.fn().mockResolvedValue('Alice Xavier: A1 válido, fiscal pronto'),
      consolidadorIa: { consolidar: consolidarMock },
      cooldownMs: 60_000,
      minNovasMensagens: 2,
      agora: () => relogio
    });

    const salvou = await sleepTime.executarAgora('conta-1');
    expect(salvou).toBe(true);
    expect(consolidarMock).toHaveBeenCalledOnce();

    const blocos = await repo.listarBlocos('conta-1');
    expect(blocos.find(b => b.rotulo === 'perfil_medico')).toMatchObject({
      conteudo: 'Prefere ser chamada de Dra. Alice\nResumos curtos',
      atualizadoPor: 'sleep_time'
    });
    expect(blocos.find(b => b.rotulo === 'pendencias_e_combinados')).toMatchObject({
      conteudo: 'Avisar quando nota da Marina sair',
      atualizadoPor: 'sleep_time'
    });

    // 1 turno dentro do cooldown NÃO deve disparar nova chamada.
    relogio += 5_000;
    sleepTime.notificarTurno('conta-1');
    await Promise.resolve();
    expect(consolidarMock).toHaveBeenCalledTimes(1);

    // 2º turno atinge minNovasMensagens e dispara em background.
    sleepTime.notificarTurno('conta-1');
    await new Promise(r => setTimeout(r, 20));
    expect(consolidarMock).toHaveBeenCalledTimes(2);
  });

  it('falha silenciosamente sem lançar exceção quando a IA falha', async () => {
    const repo = criarRepoBlocosMemoriaEmMemoria();
    const sleepTime = criarConsolidadorSleepTime({
      blocosRepo: repo,
      memoriaConversa: {
        carregarContexto: vi.fn().mockResolvedValue({
          turnosCurtoPrazo: ['Médico: oi'],
          resumosLongoPrazo: []
        })
      },
      obterEstadoVivo: vi.fn().mockResolvedValue(''),
      consolidadorIa: { consolidar: vi.fn().mockRejectedValue(new Error('timeout')) }
    });

    await expect(sleepTime.executarAgora('conta-1')).resolves.toBe(false);
  });

  it('repara automaticamente mojibake UTF-8 lido como Latin-1/Windows-1252 antes do envio', () => {
    const corrompido = Buffer.from(
      'Olá! Vou te ajudar a organizar as notas do consultório. A emissão ainda depende das informações e autorizações necessárias. Qual agenda você usa?',
      'utf8'
    ).toString('latin1');
    expect(corrompido).toContain('Ol\u00C3\u00A1!');
    expect(repararMojibakeUtf8(corrompido)).toBe(
      'Olá! Vou te ajudar a organizar as notas do consultório. A emissão ainda depende das informações e autorizações necessárias. Qual agenda você usa?'
    );
    expect(humanizarSaidaWhatsApp(corrompido)).toBe(
      'Olá! Vou te ajudar a organizar as notas do consultório. A emissão ainda depende das informações e autorizações necessárias. Qual agenda você usa?'
    );
  });

  it('expõe a causa real dos erros em estado_vivo_consultorio uma única vez sem repetição', () => {
    const estadoMinimo: EstadoProntidaoConta = {
      agenda: { conectada: true, provedor: 'tribemd', nomeAgenda: 'TribeMD' },
      profissionais: [],
      proximaEtapa: 'pronto',
      profissionaisSemCertificado: [],
      profissionaisSemFiscal: []
    };
    const bloco = montarBlocoEstadoVivo(estadoMinimo, [
      {
        estado: 'erro',
        pacienteNome: 'Marina Costa',
        dataConsulta: '28/09/2026',
        valorFormatado: 'R$ 800,00',
        ambiente: 'homologacao',
        erroMotivo: 'Resposta HTTP 403 da SEFIN homologação (IIS)'
      },
      {
        estado: 'erro',
        pacienteNome: 'Lucas',
        dataConsulta: '28/09/2026',
        valorFormatado: 'R$ 800,00',
        ambiente: 'homologacao',
        erroMotivo: 'Resposta HTTP 403 da SEFIN homologação (IIS)'
      }
    ]);
    expect(bloco).toContain('Causa real dos erros abertos: bloqueio HTTP 403 no gateway IIS da SEFIN homologação');
    expect(bloco.split('Causa real dos erros abertos:')).toHaveLength(2);
  });

  it('serializa turnos concorrentes da mesma conversa para impedir duas respostas paralelas', async () => {
    const fila = criarFilaTurnosConversa();
    const ordem: string[] = [];
    let liberarPrimeiro!: () => void;
    const bloqueioPrimeiro = new Promise<void>(resolve => { liberarPrimeiro = resolve; });

    const t1 = fila.executar('conta-1:5551999', async aguardou => {
      ordem.push(`t1:inicio:${aguardou}`);
      await bloqueioPrimeiro;
      ordem.push('t1:fim');
      return 1;
    });
    const t2 = fila.executar('conta-1:5551999', async aguardou => {
      ordem.push(`t2:inicio:${aguardou}`);
      return 2;
    });
    const tOutraConta = fila.executar('conta-2:5551888', async aguardou => {
      ordem.push(`outra:${aguardou}`);
      return 3;
    });

    await new Promise(r => setTimeout(r, 15));
    expect(ordem).toEqual(['t1:inicio:false', 'outra:false']);

    liberarPrimeiro();
    expect(await Promise.all([t1, t2, tOutraConta])).toEqual([1, 2, 3]);
    expect(ordem).toEqual(['t1:inicio:false', 'outra:false', 't1:fim', 't2:inicio:true']);
  });
});
