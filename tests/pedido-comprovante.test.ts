import { config } from '../src/config.js';
import { auditarComprovante } from '../src/atendimento/comprovante.js';
import { describe, expect, it, vi } from 'vitest';
import { decidirPedidoComprovante, type EstadoPedidoComprovante, type ExtratorComprovante,
  type ResultadoExtracaoComprovante } from '../src/atendimento/comprovante.js';
import { processarComprovante } from '../src/fluxos/processar-comprovante.js';
import { HistoricoComunicacaoEmMemoria } from '../src/onboarding/historico-comunicacao-repositorio.js';
import { processarMensagemWebhook } from '../src/fluxos/processar-mensagem-webhook.js';
import type { AtendimentoRepositorio } from '../src/atendimento/atendimento-repositorio.js';
import type { DadosMensagemEvolution } from '../src/whatsapp/payload-webhook-schema.js';

const emissaoProibida = vi.hoisted(() => vi.fn(() => { throw new Error('EMISSAO_PROIBIDA_NO_TESTE'); }));
vi.mock('../src/api/nfse/processar-solicitacao-emissao-api.js', () => ({ processarSolicitacaoEmissaoApi: emissaoProibida }));

function leitura(): ResultadoExtracaoComprovante & { tipo: 'extraido' } {
  return { tipo: 'extraido', campos: {
    valorCentavos: 35000, dataPagamento: '2026-10-18', nomePagador: 'Paciente Exemplo', nomeFavorecido: 'Medica Exemplo',
    confianca: { valorCentavos: 0.90, dataPagamento: 0.90, nomePagador: 0.90, nomeFavorecido: 0.90 }
  } };
}
function cadastro(): EstadoPedidoComprovante {
  return { medicoId: 'medico-ficticio', paciente: { nome: 'Paciente Exemplo', cpf: '52998224725' },
    ultimaConsulta: { valorConsultaCentavos: 35000 } };
}
function mensagem(): DadosMensagemEvolution {
  return { key: { id: 'mensagem-ficticia', fromMe: false, remoteJid: '5511999990000@s.whatsapp.net' },
    message: { imageMessage: { mimetype: 'image/jpeg', url: 'https://midia.invalid/comprovante.jpg' } } };
}
class ExtratorFalso implements ExtratorComprovante {
  recebidas: DadosMensagemEvolution[] = [];
  constructor(private resultado: ResultadoExtracaoComprovante | Error) {}
  async extrair(dados: DadosMensagemEvolution): Promise<ResultadoExtracaoComprovante> {
    this.recebidas.push(structuredClone(dados));
    if (this.resultado instanceof Error) throw this.resultado;
    return structuredClone(this.resultado);
  }
}
function cenario(historico = new HistoricoComunicacaoEmMemoria(), extraido: ResultadoExtracaoComprovante | Error = leitura()) {
  const logs: string[] = [];
  const extrator = new ExtratorFalso(extraido);
  return { historico, extrator, logs, deps: { historico, extrator,
    log: (_nivel: 'erro', codigo: string) => { logs.push(codigo); } } };
}

describe('pedido de nota determinístico a partir do comprovante', () => {
  it('valor igual à última consulta produz só dados do comprovante e cadastro, sem alterar entradas', () => {
    const lido = leitura(); const estado = cadastro(); const antes = structuredClone({ lido, estado });
    expect(decidirPedidoComprovante(lido, estado, [])).toEqual({ tipo: 'pedido_nota_pronto', motivo: 'VALOR_IGUAL_ULTIMA_CONSULTA',
      pedido: { medicoId: 'medico-ficticio', valorCentavos: 35000, dataPagamento: '2026-10-18',
        paciente: { nome: 'Paciente Exemplo', cpf: '52998224725' } } });
    expect({ lido, estado }).toEqual(antes);
  });
  it.each([70000, 105000])('valor %s igual a várias consultas pede confirmação de pacote', valor => {
    const lido = leitura(); lido.campos.valorCentavos = valor;
    expect(decidirPedidoComprovante(lido, cadastro(), [])).toEqual({ tipo: 'perguntar_pacote', motivo: 'VALOR_MULTIPLO_CONSULTA' });
  });
  it.each(['valorCentavos', 'dataPagamento', 'nomePagador', 'nomeFavorecido'] as const)('campo obrigatório %s ausente vai ao médico', campo => {
    const lido = leitura(); delete lido.campos[campo];
    expect(decidirPedidoComprovante(lido, cadastro(), [])).toEqual({ tipo: 'perguntar_medico', motivo: 'CAMPO_OBRIGATORIO_AUSENTE' });
  });
  it.each(['valorCentavos', 'dataPagamento', 'nomePagador', 'nomeFavorecido'] as const)('confiança abaixo de 0,90 em %s vai ao médico', campo => {
    const lido = leitura(); lido.campos.confianca![campo] = 0.8999;
    expect(decidirPedidoComprovante(lido, cadastro(), [])).toEqual({ tipo: 'perguntar_medico', motivo: 'CONFIANCA_INSUFICIENTE' });
  });
  it('confiança não informada não recebe um default', () => {
    const lido = leitura(); delete lido.campos.confianca;
    expect(decidirPedidoComprovante(lido, cadastro(), [])).toEqual({ tipo: 'perguntar_medico', motivo: 'CONFIANCA_INSUFICIENTE' });
  });
  it.each(['valorCentavos', 'dataPagamento', 'nomePagador', 'nomeFavorecido'] as const)('confiança de %s ausente não recebe default', campo => {
    const lido = leitura(); delete lido.campos.confianca![campo];
    expect(decidirPedidoComprovante(lido, cadastro(), [])).toEqual({ tipo: 'perguntar_medico', motivo: 'CONFIANCA_INSUFICIENTE' });
  });
  it.each([-0.01, 1.01, NaN, Infinity])('confiança %s fora da escala finita de 0 a 1 vai ao médico', confianca => {
    const lido = leitura(); lido.campos.confianca!.nomeFavorecido = confianca;
    expect(decidirPedidoComprovante(lido, cadastro(), [])).toEqual({ tipo: 'perguntar_medico', motivo: 'CONFIANCA_INSUFICIENTE' });
  });
  it('confiança máxima de 1 em todos os campos permite pedido pronto', () => {
    const lido = leitura(); lido.campos.confianca = { valorCentavos: 1, dataPagamento: 1, nomePagador: 1, nomeFavorecido: 1 };
    expect(decidirPedidoComprovante(lido, cadastro(), []).tipo).toBe('pedido_nota_pronto');
  });
  it('pagador diferente fica na observação estruturada, mantendo CPF do paciente', () => {
    const lido = leitura(); lido.campos.nomePagador = 'Pagador Exemplo';
    expect(decidirPedidoComprovante(lido, cadastro(), [])).toEqual({ tipo: 'pedido_nota_pronto', motivo: 'VALOR_IGUAL_ULTIMA_CONSULTA',
      pedido: { medicoId: 'medico-ficticio', valorCentavos: 35000, dataPagamento: '2026-10-18',
        paciente: { nome: 'Paciente Exemplo', cpf: '52998224725' }, observacao: { pagador: 'Pagador Exemplo' } } });
  });
  it('mesmo valor, data e pagador já processados não duplicam pedido', () => {
    expect(decidirPedidoComprovante(leitura(), cadastro(), [leitura()])).toEqual({ tipo: 'nenhuma', motivo: 'COMPROVANTE_JA_PROCESSADO' });
  });
  it.each(['ilegivel', 'nao_comprovante'] as const)('%s sempre vira dúvida para o médico', tipo => {
    expect(decidirPedidoComprovante({ tipo }, cadastro(), [])).toEqual({ tipo: 'perguntar_medico', motivo: tipo === 'ilegivel' ? 'COMPROVANTE_ILEGIVEL' : 'NAO_COMPROVANTE' });
  });
  it.each([17500, 87500])('valor %s fora das relações especificadas não é chutado', valor => {
    const lido = leitura(); lido.campos.valorCentavos = valor;
    expect(decidirPedidoComprovante(lido, cadastro(), [])).toEqual({ tipo: 'perguntar_medico', motivo: 'VALOR_DIVERGENTE' });
  });
  it('cadastro sem CPF ou consulta conhecida não recebe dado inventado', () => {
    const estado = cadastro(); estado.paciente.cpf = null;
    expect(decidirPedidoComprovante(leitura(), estado, [])).toEqual({ tipo: 'perguntar_medico', motivo: 'CADASTRO_INCOMPLETO' });
    expect(decidirPedidoComprovante(leitura(), { ...cadastro(), ultimaConsulta: null }, [])).toEqual({ tipo: 'perguntar_medico', motivo: 'CADASTRO_INCOMPLETO' });
  });
  it('reutiliza validação de CPF e não aceita CPF inválido do cadastro', () => {
    const estado = cadastro(); estado.paciente.cpf = '11111111111';
    expect(decidirPedidoComprovante(leitura(), estado, [])).toEqual({ tipo: 'perguntar_medico', motivo: 'CADASTRO_INCOMPLETO' });
  });
  it('campos extras da IA não decidem CPF, valor de nota ou emissão', () => {
    const lido = { ...leitura(), emitir: true, cpf: '11111111111', valorNotaCentavos: 1 };
    expect(decidirPedidoComprovante(lido, cadastro(), [])).toMatchObject({ tipo: 'pedido_nota_pronto',
      pedido: { valorCentavos: 35000, paciente: { cpf: '52998224725' } } });
  });
});

describe('extração e auditoria antes de devolver qualquer pedido', () => {
  it.each(['extraido', 'ilegivel', 'nao_comprovante'] as const)('audita o lido, cadastro, decisão e motivo para %s', async tipo => {
    const lido = tipo === 'extraido' ? leitura() : { tipo };
    const { deps, historico, extrator } = cenario(undefined, lido);
    const estado = cadastro(); const dados = mensagem();
    const decisao = await processarComprovante(dados, estado, deps);
    expect(extrator.recebidas).toEqual([dados]);
    expect(await historico.lerComprovantes(estado.medicoId)).toEqual([auditarComprovante(config.appPepper, estado, lido, decisao)]);
    expect(decisao.motivo).toBeTruthy();
  });
  it.each(['perguntar_medico', 'perguntar_pacote'] as const)('audita também %s', async tipo => {
    const lido = leitura();
    if (tipo === 'perguntar_medico') lido.campos.confianca!.nomePagador = 0.8999;
    else lido.campos.valorCentavos = 70000;
    const { deps, historico } = cenario(undefined, lido);
    const decisao = await processarComprovante(mensagem(), cadastro(), deps);
    expect(decisao.tipo).toBe(tipo);
    expect((await historico.lerComprovantes('medico-ficticio'))[0].decisao).toEqual(decisao);
  });
  it('cópia do mesmo comprovante em outra mensagem não gera segundo pedido e a repetição é auditada', async () => {
    const { deps, historico } = cenario();
    const primeiro = await processarComprovante(mensagem(), cadastro(), deps);
    const outra = mensagem(); outra.key.id = 'outra-mensagem';
    expect(primeiro.tipo).toBe('pedido_nota_pronto');
    expect(await processarComprovante(outra, cadastro(), deps)).toEqual({ tipo: 'nenhuma', motivo: 'COMPROVANTE_JA_PROCESSADO' });
    expect((await historico.lerComprovantes('medico-ficticio')).map(registro => registro.decisao.tipo)).toEqual(['pedido_nota_pronto', 'nenhuma']);
  });
  it('duas extrações simultâneas do mesmo comprovante geram só um pedido', async () => {
    const { deps } = cenario();
    expect((await Promise.all([processarComprovante(mensagem(), cadastro(), deps), processarComprovante(mensagem(), cadastro(), deps)]))
      .map(decisao => decisao.tipo)).toEqual(['pedido_nota_pronto', 'nenhuma']);
  });
  it('não mistura comprovantes de médicos distintos e retorna cópias da auditoria', async () => {
    const { deps, historico } = cenario();
    await processarComprovante(mensagem(), cadastro(), deps);
    expect((await processarComprovante(mensagem(), { ...cadastro(), medicoId: 'outro-medico-ficticio' }, deps)).tipo).toBe('pedido_nota_pronto');
    const registros = await historico.lerComprovantes('medico-ficticio'); const hash = registros[0].estado.pacienteHash; registros[0].estado.pacienteHash = 'alterado';
    expect((await historico.lerComprovantes('medico-ficticio'))[0].estado.pacienteHash).toBe(hash);
    expect(JSON.stringify(await historico.lerComprovantes('medico-ficticio'))).not.toContain('52998224725');
  });
  it('falha de extração não inventa campos e é auditada como dúvida', async () => {
    const { deps, historico } = cenario(undefined, new Error('falha-ficticia-privada'));
    expect(await processarComprovante(mensagem(), cadastro(), deps)).toEqual({ tipo: 'perguntar_medico', motivo: 'LEITURA_INDISPONIVEL' });
    expect((await historico.lerComprovantes('medico-ficticio'))[0].lido).toBeNull();
  });
  it('falha na auditoria não devolve pedido nem expõe dados do erro no log', async () => {
    class HistoricoComFalha extends HistoricoComunicacaoEmMemoria {
      override async registrarComprovante(): Promise<never> { throw new Error('erro-ficticio-privado'); }
    }
    const { deps, logs } = cenario(new HistoricoComFalha());
    expect(await processarComprovante(mensagem(), cadastro(), deps)).toEqual({ tipo: 'nenhuma', motivo: 'AUDITORIA_FALHOU' });
    expect(logs).toEqual(['AUDITORIA_COMPROVANTE_FALHOU']);
  });
  it('o processamento não chama a fronteira de emissão', async () => {
    const { deps } = cenario();
    expect((await processarComprovante(mensagem(), cadastro(), deps)).tipo).toBe('pedido_nota_pronto');
    expect(emissaoProibida).not.toHaveBeenCalled();
  });
});

describe('entrada de comprovante reaproveita a persistência do webhook', () => {
  it.each(['imagem', 'documento'] as const)('mensagem %s recebida chega ao extrator e não emite', async tipo => {
    const { deps, historico, extrator } = cenario(); const salvas: unknown[] = [];
    const conversa = { id: 'conversa-ficticia', medicoId: 'medico-ficticio', pacienteId: 'paciente-ficticio' };
    const repositorio = {
      async buscarInstanciaPorNome() { return { id: 'instancia-ficticia', medicoId: 'medico-ficticio', oficial: false }; },
      async buscarMedicoPorTelefone() { return null; }, async buscarOuCriarConversa() { return conversa; },
      async criarPacienteMinimo() { return { id: 'paciente-ficticio' }; },
      async salvarMensagem(registro: unknown) { salvas.push(registro); }
    };
    const dados = mensagem();
    if (tipo === 'documento') dados.message = { documentMessage: { mimetype: 'application/pdf', url: 'https://midia.invalid/comprovante.pdf' } };
    expect(await processarMensagemWebhook({ event: 'messages.upsert', instance: 'clinica-ficticia', data: dados }, 'segredo-ficticio', {
      repositorio: repositorio as unknown as AtendimentoRepositorio, segredoConfigurado: 'segredo-ficticio', pepper: 'pepper-ficticio',
      aoReceberComprovante: async contexto => {
        expect(contexto.medicoId).toBe('medico-ficticio'); expect(contexto.pacienteId).toBe('paciente-ficticio');
        return processarComprovante(contexto.mensagem, cadastro(), deps);
      }
    })).toEqual({ ok: true, acao: 'mensagem_registrada' });
    expect(salvas).toHaveLength(1); expect(extrator.recebidas).toEqual([dados]);
    expect((await historico.lerComprovantes('medico-ficticio'))[0].decisao.tipo).toBe('pedido_nota_pronto');
    expect(emissaoProibida).not.toHaveBeenCalled();
  });
});
