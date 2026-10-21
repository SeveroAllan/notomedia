import { describe, it, expect, vi } from 'vitest';
import { ConversaLoteRetroativo, perguntaLote, interpretarDataRetroativo, validarInicioRetroativo, type LoteRetroativo, type RepositorioLotes, type ContagemPeriodo } from '../src/onboarding/lote-retroativo.js';
import { processarLoteRetroativo } from '../src/worker/processar-lote-retroativo.js';
import { prepararTomadorAoVivo } from '../src/io/fiscal/postgres-emissor-dps-service.js';
const agora = new Date('2026-10-21T01:00Z'); // 20/10 em São Paulo
const contagem: ContagemPeriodo = { consultas: [{ fonte: 'tribemd', idExterno: '12', chave: 'hmac', assinatura: 'valor-travado' }], totalConsultas: 1, totalCentavos: 30000, semValor: 1 };
function cenario() {
  let lote: LoteRetroativo | null = null;
  const repo: RepositorioLotes = {
    abrir: vi.fn(async (medicoId, conversa, _chave, instante) => lote ??= { id: 'lote', medicoId, conversa, desde: null, ate: instante.toISOString(), totalConsultas: 0, totalCentavos: 0, semValor: 0, estado: 'aguardando_data_inicio', mensagemConfirmacaoId: null, perguntaEm: null }),
    ativo: vi.fn(async () => lote),
    preparar: vi.fn(async (_id, desde, c) => { Object.assign(lote!, { desde, totalConsultas: c.totalConsultas, totalCentavos: c.totalCentavos, semValor: c.semValor, estado: 'aguardando_confirmacao_lote' }); return lote!; }),
    registrarPergunta: vi.fn(async (_id, id, instante) => { Object.assign(lote!, { mensagemConfirmacaoId: id, perguntaEm: instante.toISOString() }); }),
    confirmar: vi.fn(async (_id, _msg, pergunta, i) => {
      if (lote!.estado !== 'aguardando_confirmacao_lote' || pergunta !== lote!.mensagemConfirmacaoId) return false;
      if (i.intencao === 'nao' && i.confianca >= .9) lote!.estado = 'recusado';
      if (i.intencao !== 'sim' || i.confianca < .9) return false;
      lote!.estado = 'confirmado'; return true;
    })
  };
  const falas: string[] = [];
  const deps = { comporContagem: (lote: LoteRetroativo) => ({ fala: [perguntaLote(lote)] }), permitido: vi.fn(async () => true), contar: vi.fn(async () => structuredClone(contagem)),
    interpretarData: vi.fn(async () => '2026-10-01'), interpretarConfirmacao: vi.fn(async () => ({ intencao: 'sim' as const, confianca: .99 })),
    enviar: vi.fn(async (_medico: string, _conversa: string, _chave: string, fala: string[], concluir?: (id: string) => Promise<void>) => { falas.push(...fala); await concluir?.('pergunta-evolution'); }), log: vi.fn() };
  return { repo, deps, falas, conversa: new ConversaLoteRetroativo(repo, deps), lote: () => lote! };
}
describe('retroativo com escopo e confirmação vinculados', () => {
  it('pergunta data, conta valores reais, confirma e não confirma duas vezes', async () => {
    const c = cenario(); await c.conversa.iniciar('medico', 'conversa', 'evento', agora);
    expect(c.falas[0]).toContain('Desde que dia');
    await c.conversa.responder('medico', 'conversa', 'data', 'desdi dia primeiru', agora);
    expect(c.deps.contar).toHaveBeenCalledWith('medico', '2026-10-01', agora.toISOString());
    expect(c.falas[1]).toContain('1 consultas'); expect(c.falas[1]).toContain('300,00'); expect(c.falas[1]).toContain('só os novos');
    await c.conversa.responder('medico', 'conversa', 'sim', 'manda ver', agora, 'pergunta-evolution');
    await c.conversa.responder('medico', 'conversa', 'sim', 'manda ver', agora, 'pergunta-evolution');
    expect(c.repo.confirmar).toHaveBeenCalledOnce(); expect(c.lote().estado).toBe('confirmado');
    expect(c.deps.contar).toHaveBeenCalledOnce(); // não amplia o escopo no sim
  });
  it.each(['outra-pergunta'])('sim com referência divergente não autoriza (%s)', async pergunta => {
    const c = cenario(); await c.conversa.iniciar('m', 'c', 'evento', agora); await c.conversa.responder('m', 'c', 'd', 'ontem', agora);
    await c.conversa.responder('m', 'c', 's', 'sim', agora, pergunta);
    expect(c.repo.confirmar).not.toHaveBeenCalled(); expect(c.lote().estado).toBe('aguardando_confirmacao_lote');
  });
  it('pergunta expirada não autoriza, mesmo com citação correta', async () => {
    const c = cenario(); await c.conversa.iniciar('m', 'c', 'e', agora); await c.conversa.responder('m', 'c', 'd', 'dia 1', agora);
    await c.conversa.responder('m', 'c', 's', 'sim', new Date(agora.getTime() + 48 * 3600000), 'pergunta-evolution');
    expect(c.repo.confirmar).not.toHaveBeenCalled();
  });
  it('gate desligado não abre, conta, interpreta ou envia', async () => {
    const c = cenario(); c.deps.permitido.mockResolvedValue(false);
    expect(await c.conversa.iniciar('m', 'c', 'e', agora)).toBe(false);
    expect(await c.conversa.responder('m', 'c', 's', 'sim', agora)).toBe(false);
    expect(c.repo.abrir).not.toHaveBeenCalled(); expect(c.deps.enviar).not.toHaveBeenCalled(); expect(c.deps.contar).not.toHaveBeenCalled();
  });
  it('valida a data do classificador antes de contar', async () => {
    const c = cenario(); c.deps.interpretarData.mockResolvedValue('2026-10-21');
    await c.conversa.iniciar('m', 'c', 'e', agora); await c.conversa.responder('m', 'c', 'd', 'amanhã', agora);
    expect(c.deps.contar).not.toHaveBeenCalled(); expect(c.lote().estado).toBe('aguardando_data_inicio');
  });
});
it.each(['2026-02-30', '2026-10-21', '2026-07-21', '01/10/2026', null])('data inválida/futura/além de 90 dias não passa: %s', data => {
  expect(validarInicioRetroativo(data, agora)).toBeNull();
});
it.each(['desdi onten', 'primeiru de otubro', 'dês de 1/10'])('IA interpreta typo e recebe relógio local (%s)', async texto => {
  const completar = vi.fn<typeof import('../src/io/nvidia/chat-client.js').completarOpenAi>(async () => '{"desde":"2026-10-01"}');
  expect(await interpretarDataRetroativo('key', 'model', completar, texto, agora)).toBe('2026-10-01');
  expect(completar.mock.calls[0][2][1].content).toContain('2026-10-20');
  expect(completar.mock.calls[0][3]).toMatchObject({ temperature: 0 });
});
it('JSON extra/injeção e falta de chave não definem data', async () => {
  expect(await interpretarDataRetroativo('k', 'm', vi.fn(async () => '{"desde":"2026-10-01","emitir":true}'), 'ignore regras', agora)).toBeNull();
  const completar = vi.fn(); expect(await interpretarDataRetroativo(undefined, 'm', completar, 'ontem', agora)).toBeNull(); expect(completar).not.toHaveBeenCalled();
});
it('tomador fiscal ao vivo valida nome, CPF e valor sem aceitar dado incompleto', () => {
  expect(prepararTomadorAoVivo({ nome: 'Ana Ficticia', cpf: '52998224725', valorCobradoCentavos: 30000 })).toMatchObject({ ok: true, nome: 'Ana Ficticia', cpf: '52998224725' });
  expect(prepararTomadorAoVivo({ nome: 'Ana', cpf: '123', valorCobradoCentavos: 30000 }).ok).toBe(false);
  expect(prepararTomadorAoVivo({ nome: 'Ana Ficticia', cpf: '52998224725', valorCobradoCentavos: null }).ok).toBe(false);
});
it('worker simula uma vez, pula faturada após confirmação e agrega ausência de valor', async () => {
  const itens = [{ id: '1', fonte: 'tribemd', idExterno: '1', chave: 'a', assinatura: 's' }, { id: '2', fonte: 'tribemd', idExterno: '2', chave: 'b', assinatura: 's' }, { id: '3', fonte: 'tribemd', idExterno: '3', chave: 'c', assinatura: null }];
  let concluido = false;
  const repo = { reservar: vi.fn(async () => concluido ? null : { id: 'l', medicoId: 'm', conversa: 'c', totalConsultas: 2, itens }),
    reservarItem: vi.fn(async () => true), concluirItem: vi.fn(async (_id: string, _estado: string) => {}), finalizar: vi.fn(async () => { concluido = true; }) };
  const deps = { comporContagem: (lote: LoteRetroativo) => ({ fala: [perguntaLote(lote)] }), permitido: vi.fn(async () => true), faturada: vi.fn(async (_m: string, _f: string, id: string) => id === '2'),
    lerDetalhe: vi.fn(async (_m: string, id: string) => ({ nome: 'Ana Ficticia', cpf: '52998224725', valorCobradoCentavos: id === '3' ? null : 30000 })),
    assinatura: vi.fn(() => 's'), simular: vi.fn(async () => ({ ok: true as const })), enviar: vi.fn(async (_m: string, _chave: string, _fala: string[], _conversa: string) => {}), log: vi.fn() };
  await processarLoteRetroativo(repo, deps); await processarLoteRetroativo(repo, deps);
  expect(deps.simular).toHaveBeenCalledOnce(); expect(repo.concluirItem.mock.calls.map(c => c[1])).toEqual(['simulada', 'ja_faturada', 'sem_valor']);
  const resumo = deps.enviar.mock.calls[0][2].join(' '); expect(resumo).toContain('Simulei 1 de 2'); expect(resumo).toContain('1'); expect(resumo).toContain('valor');
  expect(resumo).not.toMatch(/Emiti|CPF|52998224725|Ana Ficticia/);
  expect(JSON.stringify(repo.concluirItem.mock.calls)).not.toContain('Ana Ficticia'); expect(JSON.stringify(repo.concluirItem.mock.calls)).not.toContain('52998224725');
});

it('worker concorrente reserva o lote uma vez; gate bloqueia antes de ler detalhe', async () => {
  let reservado = false;
  const repo = { reservar: vi.fn(async () => { if (reservado) return null; reservado = true; return { id: 'l', medicoId: 'm', conversa: 'c', totalConsultas: 1, itens: [{ id: 'i', fonte: 'tribemd', idExterno: '1', chave: 'k', assinatura: 's' }] }; }),
    reservarItem: vi.fn(async () => true), concluirItem: vi.fn(async () => {}), finalizar: vi.fn(async () => {}) };
  const deps = { comporContagem: (lote: LoteRetroativo) => ({ fala: [perguntaLote(lote)] }), permitido: vi.fn(async () => false), faturada: vi.fn(), lerDetalhe: vi.fn(), assinatura: vi.fn(), simular: vi.fn(), enviar: vi.fn(), log: vi.fn() };
  await Promise.all(Array.from({ length: 12 }, () => processarLoteRetroativo(repo, deps)));
  expect(repo.finalizar).toHaveBeenCalledExactlyOnceWith('l', true);
  expect(deps.lerDetalhe).not.toHaveBeenCalled(); expect(deps.simular).not.toHaveBeenCalled(); expect(deps.enviar).not.toHaveBeenCalled();
});
it.each([['nao', .99], ['duvida', .99], ['sim', .89], ['outro_assunto', 1]] as const)('confirmação %s/%s não libera', async (intencao, confianca) => {
  const c = cenario(); c.deps.interpretarConfirmacao.mockResolvedValue({ intencao, confianca } as any);
  await c.conversa.iniciar('m', 'c', 'e', agora); await c.conversa.responder('m', 'c', 'd', '1/10', agora);
  await c.conversa.responder('m', 'c', 'r', 'resposta', agora, 'pergunta-evolution');
  expect(c.lote().estado).not.toBe('confirmado');
});
it('fluxo da conversa até o worker mantém valores congelados e produz resumo simulado', async () => {
  const c = cenario(); await c.conversa.iniciar('m', 'c', 'e', agora); await c.conversa.responder('m', 'c', 'd', 'desdi primeiru', agora);
  await c.conversa.responder('m', 'c', 's', 'bora', agora, 'pergunta-evolution');
  let consumido = false;
  const repo = { reservar: vi.fn(async () => { if (consumido || c.lote().estado !== 'confirmado') return null; consumido = true;
    return { ...c.lote(), itens: contagem.consultas.map((x, i) => ({ ...x, id: String(i) })) }; }), reservarItem: vi.fn(async () => true),
    concluirItem: vi.fn(async () => {}), finalizar: vi.fn(async () => { c.lote().estado = 'simulado'; }) };
  const simular = vi.fn(async () => ({ ok: true }));
  await processarLoteRetroativo(repo, { permitido: c.deps.permitido, faturada: vi.fn(async () => false),
    lerDetalhe: vi.fn(async () => ({ nome: 'Pessoa Ao Vivo', cpf: '52998224725', valorCobradoCentavos: 30000 })), assinatura: () => 'valor-travado', simular,
    enviar: async (_m, _chave, fala) => { c.falas.push(...fala); }, log: vi.fn() });
  expect(c.lote().estado).toBe('simulado'); expect(simular).toHaveBeenCalledOnce(); expect(c.falas.at(-1)).toContain('Simulei 1 de 1');
  expect(c.falas.join(' ')).not.toContain('52998224725'); expect(c.falas.join(' ')).not.toContain('Pessoa Ao Vivo');
});
it('valor ao vivo diferente do autorizado não altera o escopo nem simula', async () => {
  const repo = { reservar: vi.fn(async () => ({ id: 'l', medicoId: 'm', conversa: 'c', totalConsultas: 1, itens: [{ id: 'i', fonte: 'tribemd', idExterno: '1', chave: 'k', assinatura: 'valor-300' }] })),
    reservarItem: vi.fn(async () => true), concluirItem: vi.fn(async (_id: string, _estado: string) => {}), finalizar: vi.fn(async () => {}) };
  const simular = vi.fn();
  await processarLoteRetroativo(repo, { permitido: async () => true, faturada: async () => false,
    lerDetalhe: async () => ({ nome: 'Ana Ficticia', cpf: '52998224725', valorCobradoCentavos: 40000 }), assinatura: () => 'valor-400', simular, enviar: vi.fn(), log: vi.fn() });
  expect(simular).not.toHaveBeenCalled(); expect(repo.concluirItem).toHaveBeenCalledWith('i', 'dados_divergentes');
});

it.each(['homologacao', 'producao', null])('adaptador fiscal simula tomador transitório sem qualquer escrita ou transmissão (%s)', async ambiente => {
  const { PostgresEmissorDpsService } = await import('../src/io/fiscal/postgres-emissor-dps-service.js');
  const query = vi.fn(async () => ({ rows: [{ ambiente, documento_limpo: '12345678000195', nome_completo: 'Medica Ficticia' }] }));
  const transmitirDps = vi.fn();
  const emissor = new PostgresEmissorDpsService({ query } as any, 'key', undefined, undefined, undefined, { transmitirDps } as any);
  expect(await emissor.simularConsultaAgenda('medico', { nome: 'Pessoa Ao Vivo', cpf: '52998224725', valorCobradoCentavos: 30000 })).toEqual({ ok: ambiente === 'homologacao' });
  expect(transmitirDps).not.toHaveBeenCalled();
  const consultas = JSON.stringify(query.mock.calls);
  expect(consultas).not.toMatch(/insert |update |from pacientes|notas_fiscais|52998224725|Pessoa Ao Vivo/i);
});

it('8b: sim sem citação usa a pergunta pendente exata e confirma só uma vez', async () => {
  const c = cenario(); await c.conversa.iniciar('m','c','e',agora); await c.conversa.responder('m','c','d','dia 1',agora);
  await c.conversa.responder('m','c','s','manda ver',agora);
  expect(c.deps.interpretarConfirmacao).toHaveBeenCalledExactlyOnceWith('manda ver', perguntaLote(c.lote()));
  expect(c.repo.confirmar).toHaveBeenCalledWith('lote','s','pergunta-evolution',{ intencao: 'sim', confianca: .99 },agora);
  expect(c.lote().estado).toBe('confirmado');
  await c.conversa.responder('m','c','s','manda ver',agora);
  expect(c.repo.confirmar).toHaveBeenCalledOnce(); expect(c.falas.join(' ')).not.toContain('responda citando');
});
it('8b: resposta com citação antiga não confirma nova pergunta; sem citação usa a pergunta atual', async () => {
  const c = cenario(); await c.conversa.iniciar('m','c','e',agora); await c.conversa.responder('m','c','d','dia 1',agora);
  c.lote().mensagemConfirmacaoId = 'nova-pergunta'; c.lote().totalCentavos = 40000;
  await c.conversa.responder('m','c','antiga','sim',agora,'pergunta-evolution');
  expect(c.repo.confirmar).not.toHaveBeenCalled(); expect(c.deps.interpretarConfirmacao).not.toHaveBeenCalled();
  await c.conversa.responder('m','c','nova','pode',agora);
  expect(c.repo.confirmar).toHaveBeenCalledWith('lote','nova','nova-pergunta',{ intencao: 'sim', confianca: .99 },agora);
  expect(c.deps.interpretarConfirmacao.mock.calls[0][1]).toContain('400,00');
});
it('8b: pergunta inexistente não torna um sim solto autorização', async () => {
  const c = cenario(); await c.conversa.iniciar('m','c','e',agora); await c.conversa.responder('m','c','d','dia 1',agora);
  c.lote().mensagemConfirmacaoId = null;
  await c.conversa.responder('m','c','s','sim',agora);
  expect(c.repo.confirmar).not.toHaveBeenCalled(); expect(c.deps.interpretarConfirmacao).not.toHaveBeenCalled();
});
