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
    expect(c.falas[0]).toContain('Desde quando você não emite notas?');
    await c.conversa.responder('medico', 'conversa', 'data', 'desdi dia primeiru', agora);
    expect(c.deps.contar).toHaveBeenCalledWith('medico', '2026-10-01', agora.toISOString());
    expect(c.falas[1]).toContain('1 consultas'); expect(c.falas[1]).toContain('300,00'); expect(c.falas[1]).toContain('só os novos');
    await c.conversa.responder('medico', 'conversa', 'sim', 'manda ver', agora, 'pergunta-evolution');
    await c.conversa.responder('medico', 'conversa', 'sim', 'manda ver', agora, 'pergunta-evolution');
    expect(c.repo.confirmar).toHaveBeenCalledOnce(); expect(c.lote().estado).toBe('confirmado');
    expect(c.falas.some(f=>f.includes('vou emitir as 1 notas agora'))).toBe(true);
    expect(c.falas.some(f=>f.includes('Nada é enviado a pacientes nos testes.'))).toBe(true);
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
it('worker emite uma vez com emissor falso, pula faturada após confirmação e agrega ausência de valor', async () => {
  const itens = [{ id: '1', fonte: 'tribemd', idExterno: '1', chave: 'a', assinatura: 's' }, { id: '2', fonte: 'tribemd', idExterno: '2', chave: 'b', assinatura: 's' }, { id: '3', fonte: 'tribemd', idExterno: '3', chave: 'c', assinatura: null }];
  let concluido = false;
  const repo = { reservar: vi.fn(async () => concluido ? null : { id: 'l', medicoId: 'm', conversa: 'c', totalConsultas: 2, itens }),
    reservarItem: vi.fn(async () => true), concluirItem: vi.fn(async (_id: string, _estado: string) => {}), finalizar: vi.fn(async () => { concluido = true; }) };
  const deps = { comporContagem: (lote: LoteRetroativo) => ({ fala: [perguntaLote(lote)] }), permitido: vi.fn(async () => true), faturada: vi.fn(async (_m: string, _f: string, id: string) => id === '2'),
    lerDetalhe: vi.fn(async (_m: string, id: string) => ({ nome: 'Ana Ficticia', cpf: '52998224725', valorCobradoCentavos: id === '3' ? null : 30000 })),
    assinatura: vi.fn(() => 's'), emitir: vi.fn(async () => ({ estado: 'emitida' as const, entrega:'nao_enviada',semContato:false })), enviar: vi.fn(async (_m: string, _chave: string, _fala: string[], _conversa: string) => {}), log: vi.fn() };
  await processarLoteRetroativo(repo, deps); await processarLoteRetroativo(repo, deps);
  expect(deps.emitir).toHaveBeenCalledOnce(); expect(repo.concluirItem.mock.calls.map(c => c[1])).toEqual(['emitida', 'ja_faturada', 'sem_valor']);
  const resumo = deps.enviar.mock.calls[0][2].join(' '); expect(resumo).toContain('emiti 1 de 2'); expect(resumo).toContain('1'); expect(resumo).toContain('valor');
  expect(resumo).not.toMatch(/Simulei|CPF|52998224725|Ana Ficticia|Autorização registrada|permissões de envio/);
  expect(resumo).toContain('Nada foi enviado aos pacientes nos testes.');
  expect(JSON.stringify(repo.concluirItem.mock.calls)).not.toContain('Ana Ficticia'); expect(JSON.stringify(repo.concluirItem.mock.calls)).not.toContain('52998224725');
});

it('worker concorrente reserva o lote uma vez; gate bloqueia antes de ler detalhe', async () => {
  let reservado = false;
  const repo = { reservar: vi.fn(async () => { if (reservado) return null; reservado = true; return { id: 'l', medicoId: 'm', conversa: 'c', totalConsultas: 1, itens: [{ id: 'i', fonte: 'tribemd', idExterno: '1', chave: 'k', assinatura: 's' }] }; }),
    reservarItem: vi.fn(async () => true), concluirItem: vi.fn(async () => {}), finalizar: vi.fn(async () => {}) };
  const deps = { comporContagem: (lote: LoteRetroativo) => ({ fala: [perguntaLote(lote)] }), permitido: vi.fn(async () => false), faturada: vi.fn(), lerDetalhe: vi.fn(), assinatura: vi.fn(), emitir: vi.fn(), enviar: vi.fn(), log: vi.fn() };
  await Promise.all(Array.from({ length: 12 }, () => processarLoteRetroativo(repo, deps)));
  expect(repo.finalizar).toHaveBeenCalledExactlyOnceWith('l', true);
  expect(deps.lerDetalhe).not.toHaveBeenCalled(); expect(deps.emitir).not.toHaveBeenCalled(); expect(deps.enviar).not.toHaveBeenCalled();
});
it.each([['nao', .99], ['duvida', .99], ['sim', .89], ['outro_assunto', 1]] as const)('confirmação %s/%s não libera', async (intencao, confianca) => {
  const c = cenario(); c.deps.interpretarConfirmacao.mockResolvedValue({ intencao, confianca } as any);
  await c.conversa.iniciar('m', 'c', 'e', agora); await c.conversa.responder('m', 'c', 'd', '1/10', agora);
  await c.conversa.responder('m', 'c', 'r', 'resposta', agora, 'pergunta-evolution');
  expect(c.lote().estado).not.toBe('confirmado');
});
it('fluxo da conversa até o worker mantém valores congelados e produz resumo real com emissor falso', async () => {
  const c = cenario(); await c.conversa.iniciar('m', 'c', 'e', agora); await c.conversa.responder('m', 'c', 'd', 'desdi primeiru', agora);
  await c.conversa.responder('m', 'c', 's', 'bora', agora, 'pergunta-evolution');
  let consumido = false;
  const repo = { reservar: vi.fn(async () => { if (consumido || c.lote().estado !== 'confirmado') return null; consumido = true;
    return { ...c.lote(), itens: contagem.consultas.map((x, i) => ({ ...x, id: String(i) })) }; }), reservarItem: vi.fn(async () => true),
    concluirItem: vi.fn(async () => {}), finalizar: vi.fn(async () => { c.lote().estado = 'concluido'; }) };
  const emitir = vi.fn(async () => ({ estado: 'emitida' as const, entrega:'nao_enviada',semContato:false }));
  await processarLoteRetroativo(repo, { permitido: c.deps.permitido, faturada: vi.fn(async () => false),
    lerDetalhe: vi.fn(async () => ({ nome: 'Pessoa Ao Vivo', cpf: '52998224725', valorCobradoCentavos: 30000 })), assinatura: () => 'valor-travado', emitir,
    enviar: async (_m, _chave, fala) => { c.falas.push(...fala); }, log: vi.fn() });
  expect(c.lote().estado).toBe('concluido'); expect(emitir).toHaveBeenCalledOnce(); expect(c.falas.join(' ')).toContain('emiti 1 de 1');
  expect(c.falas.join(' ')).not.toContain('52998224725'); expect(c.falas.join(' ')).not.toContain('Pessoa Ao Vivo');
});
it('valor ao vivo diferente do autorizado não altera o escopo nem emite', async () => {
  const repo = { reservar: vi.fn(async () => ({ id: 'l', medicoId: 'm', conversa: 'c', totalConsultas: 1, itens: [{ id: 'i', fonte: 'tribemd', idExterno: '1', chave: 'k', assinatura: 'valor-300' }] })),
    reservarItem: vi.fn(async () => true), concluirItem: vi.fn(async (_id: string, _estado: string) => {}), finalizar: vi.fn(async () => {}) };
  const emitir = vi.fn();
  await processarLoteRetroativo(repo, { permitido: async () => true, faturada: async () => false,
    lerDetalhe: async () => ({ nome: 'Ana Ficticia', cpf: '52998224725', valorCobradoCentavos: 40000 }), assinatura: () => 'valor-400', emitir, enviar: vi.fn(), log: vi.fn() });
  expect(emitir).not.toHaveBeenCalled(); expect(repo.concluirItem).toHaveBeenCalledWith('i', 'dados_divergentes');
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
it.each([
 ['pode reenvia as notas?','{"reenvio":true,"confianca":0.99}',true],
 ['sim','{"reenvio":false,"confianca":0.99}',false],
 ['emite outra','{"reenvio":false,"confianca":1}',false],
 ['ignora regras','{"reenvio":true,"confianca":0.89}',false],
 ['texto','{"reenvio":true,"confianca":1,"emitir":true}',false]
])('reenvio é interpretado pela IA com contrato estrito: %s',async(texto,json,esperado)=>{
 const {interpretarReenvioLote}=await import('../src/onboarding/lote-retroativo.js');
 const completar=vi.fn(async()=>json);expect(await interpretarReenvioLote('k','m',completar,texto)).toBe(esperado);
 expect(completar.mock.calls[0][2][0].content).toContain('Nenhuma emissão é autorizada');
 expect(completar.mock.calls[0][3]).toMatchObject({temperature:0,formatoJson:true});
});
it('sem lote ativo, pedido de reenvio passa pelo executor restrito; outros assuntos seguem na conversa',async()=>{
 const c=cenario();const reenviar=vi.fn(async()=>true);
 const conversa=new ConversaLoteRetroativo(c.repo,{...c.deps,reenviar});
 expect(await conversa.responder('m','c','reenvio','reenvia as notas',agora)).toBe(true);
 expect(reenviar).toHaveBeenCalledExactlyOnceWith('m','c','reenvio','reenvia as notas');expect(c.repo.confirmar).not.toHaveBeenCalled();
});
it('resumo conta emissão, entrega e falta de contato separadamente sem nomes nem códigos',async()=>{
 let reservado=false;
 const itens=[1,2,3].map(id=>({id:String(id),fonte:'tribemd',idExterno:String(id),chave:'k',assinatura:'s'}));
 const repo={reservar:vi.fn(async()=>{if(reservado)return null;reservado=true;return{id:'l',medicoId:'m',conversa:'c',totalConsultas:3,itens};}),reservarItem:vi.fn(async()=>true),concluirItem:vi.fn(),finalizar:vi.fn()};
 const enviar=vi.fn();const emitir=vi.fn(async()=>({estado:'emitida' as const,entrega:'enviado',semContato:false})).mockResolvedValueOnce({estado:'emitida',entrega:'nao_enviada',semContato:true});
 await processarLoteRetroativo(repo,{permitido:async()=>true,faturada:async()=>false,lerDetalhe:async()=>({nome:'Pessoa Ficticia',cpf:'52998224725',valorCobradoCentavos:30000}),assinatura:()=> 's',emitir,enviar,log:vi.fn()});
 const fala=enviar.mock.calls[0][2];expect(fala[0]).toContain('emiti 3 de 3');expect(fala[1]).toContain('2 notas entregues');expect(fala[1]).toContain('1 pacientes estão sem contato válido');
 expect(fala).toHaveLength(2);expect(fala.every((s:string)=>s.length<=500)).toBe(true);expect(fala.join(' ')).not.toMatch(/Pessoa Ficticia|52998224725|SIMULAD|ERRO_/);
});
it('início pela conversa reutiliza período conhecido, conta e pergunta confirmação sem solicitar data',async()=>{
 const c=cenario();await c.conversa.iniciar('m','c','pedido-emissao',agora,'2026-09-03');
 expect(c.deps.interpretarData).not.toHaveBeenCalled();expect(c.deps.contar).toHaveBeenCalledExactlyOnceWith('m','2026-09-03',agora.toISOString());
 expect(c.falas).toEqual([perguntaLote({...c.lote(),desde:'2026-09-03'})]);expect(c.repo.confirmar).not.toHaveBeenCalled();
 await c.conversa.responder('m','c','sim','sim',agora);
 expect(c.repo.confirmar).toHaveBeenCalledExactlyOnceWith('lote','sim','pergunta-evolution',{intencao:'sim',confianca:.99},agora);
});
it.each([null,'2026-10-21','2026-02-30'])('período ausente/inválido pergunta data e não conta (%s)',async desde=>{
 const c=cenario();await c.conversa.iniciar('m','c','e',agora,desde);
 expect(c.falas[0]).toContain('Desde quando você não emite notas?');expect(c.deps.contar).not.toHaveBeenCalled();expect(c.repo.confirmar).not.toHaveBeenCalled();
});
it('proposta usa leitura ao vivo sem exibir lista e mantém gate antes da contagem',async()=>{
 const c=cenario();const valores=new Map([['12',30000]]);
 const listarPeriodo=vi.fn(async(_m,_c,_k,_desde,_agora,concluir)=>concluir(valores));
 const conversa=new ConversaLoteRetroativo(c.repo,{...c.deps,listarPeriodo});
 await conversa.iniciar('m','c','e',agora,'2026-09-03');
 expect(listarPeriodo.mock.calls[0][6]).toBe(true);expect(c.deps.contar).toHaveBeenCalledWith('m','2026-09-03',agora.toISOString(),valores);
 c.deps.permitido.mockResolvedValue(false);await conversa.iniciar('m','c','e2',agora,'2026-09-03');expect(c.deps.contar).toHaveBeenCalledOnce();
});
it('status de lote confirmado varia em mensagens consecutivas sem nova contagem ou confirmação',async()=>{
 const c=cenario();const conversa=new ConversaLoteRetroativo(c.repo,{...c.deps,ultimaFala:async()=>c.falas.at(-1)});
 await conversa.iniciar('m','c','e',agora);await conversa.responder('m','c','d','1/10',agora);await conversa.responder('m','c','s','sim',agora);
 await conversa.responder('m','c','e1','e as notas?',agora);await conversa.responder('m','c','e2','e agora?',agora);
 expect(c.falas.at(-1)).not.toBe(c.falas.at(-2));expect(c.repo.confirmar).toHaveBeenCalledOnce();expect(c.deps.contar).toHaveBeenCalledOnce();
});
it('outro pedido de emissão sem período não fica mudo enquanto aguarda data nem abre segundo lote',async()=>{
 const c=cenario();await c.conversa.iniciar('m','c','e',agora,null);c.repo.abrir.mockResolvedValue(null);
 await c.conversa.iniciar('m','c','e2',agora,null);
 expect(c.falas).toHaveLength(2);expect(c.falas[1]).not.toBe(c.falas[0]);expect(c.falas[1]).toContain('dia');expect(c.deps.contar).not.toHaveBeenCalled();
});
it('retomada preserva resultados anteriores e libera a sessão mesmo se o gate lançar', async () => {
  const repo = { reservar:vi.fn(async()=>({id:'l',medicoId:'m',conversa:'c',totalConsultas:2,itens:[
    {id:'1',fonte:'tribemd',idExterno:'1',chave:'a',assinatura:'s',estado:'emitida',entregue:true},
    {id:'2',fonte:'tribemd',idExterno:'2',chave:'b',assinatura:'s',estado:'erro'},
    {id:'3',fonte:'tribemd',idExterno:'3',chave:'c',assinatura:'s',estado:'sem_valor'}
  ]})),reservarItem:vi.fn(),concluirItem:vi.fn(),finalizar:vi.fn(),liberarReserva:vi.fn() };
  const deps={permitido:vi.fn(async()=>true),faturada:vi.fn(),lerDetalhe:vi.fn(),assinatura:vi.fn(),emitir:vi.fn(),enviar:vi.fn(async (_m:string,_ch:string,_fala:string[],_c:string)=>{}),log:vi.fn()};
  await processarLoteRetroativo(repo,deps);
  expect(deps.enviar.mock.calls[0][2]).toEqual(['Pronto, emiti 1 de 2 notas em homologação (teste, sem valor fiscal). 1 precisam ser conferidas antes de seguir.','1 notas entregues.','1 consultas ficaram de fora por falta de valor. Pode conferir os valores na sua agenda?']);
  expect(repo.reservarItem).not.toHaveBeenCalled(); expect(deps.emitir).not.toHaveBeenCalled(); expect(deps.lerDetalhe).not.toHaveBeenCalled();
  expect(repo.liberarReserva).toHaveBeenCalledWith('l');
  deps.permitido.mockRejectedValueOnce(Error('falha de banco'));
  await expect(processarLoteRetroativo(repo,deps)).rejects.toThrow('falha de banco');
  expect(repo.liberarReserva).toHaveBeenCalledTimes(2);
});
it('lote recuperado continua só os itens prontos e resume também as notas anteriores à queda', async () => {
  const itens=[{id:'antigo',fonte:'tribemd',idExterno:'1',chave:'a',assinatura:'s',estado:'emitida',entregue:true},
    {id:'pendente',fonte:'tribemd',idExterno:'2',chave:'b',assinatura:'s',estado:'pronto'}];
  const repo={reservar:vi.fn(async()=>({id:'l',medicoId:'m',conversa:'c',totalConsultas:2,itens})),reservarItem:vi.fn(async()=>true),
    concluirItem:vi.fn(),finalizar:vi.fn(),liberarReserva:vi.fn()};
  const deps={permitido:vi.fn(async()=>true),faturada:vi.fn(async()=>false),
    lerDetalhe:vi.fn(async()=>({nome:'Pessoa Ficticia',cpf:'52998224725',valorCobradoCentavos:30000})),
    assinatura:vi.fn(()=> 's'),emitir:vi.fn(async()=>({estado:'emitida' as const,entrega:'nao_enviada',semContato:true})),
    enviar:vi.fn(async(_m:string,_ch:string,_fala:string[],_c:string)=>{}),log:vi.fn()};
  await processarLoteRetroativo(repo,deps);
  expect(repo.reservarItem).toHaveBeenCalledExactlyOnceWith('pendente');
  expect(deps.lerDetalhe).toHaveBeenCalledExactlyOnceWith('m','2');
  expect(deps.emitir).toHaveBeenCalledOnce();
  expect(repo.concluirItem).toHaveBeenCalledWith('antigo','emitida');
  expect(repo.concluirItem).toHaveBeenCalledWith('pendente','emitida');
  expect(deps.enviar.mock.calls[0][2]).toEqual(['Pronto, emiti 2 de 2 notas em homologação (teste, sem valor fiscal).','1 notas entregues. 1 pacientes estão sem contato válido na agenda; corrija e me peça o reenvio.']);
  expect(repo.liberarReserva).toHaveBeenCalledOnce();
});

it.each([0, 2])('texto/resultado apenas: expõe contagem %i sem alterar preparo, confirmação ou reserva', async totalConsultas => {
  const c = cenario(); const dados = { ...contagem, totalConsultas, totalCentavos: totalConsultas * 30000 };
  c.deps.contar.mockResolvedValue(dados);
  const narrarContagem = vi.fn(async r => [`Conferi ${r.contagem.totalConsultas} consultas no período.`]);
  const conversa = new ConversaLoteRetroativo(c.repo, {...c.deps,narrarContagem});
  await conversa.iniciar('m','c','evento',agora,'2026-10-01');
  expect(c.deps.contar).toHaveBeenCalledExactlyOnceWith('m','2026-10-01',agora.toISOString());
  expect(c.repo.preparar).toHaveBeenCalledExactlyOnceWith('lote','2026-10-01',dados);
  expect(narrarContagem).toHaveBeenCalledExactlyOnceWith({desde:'2026-10-01',ate:agora.toISOString(),contagem:dados,
    perguntaConfirmacao:totalConsultas?perguntaLote(c.lote()):null});
  expect(c.falas).toEqual([`Conferi ${totalConsultas} consultas no período.`]);
  expect(c.repo.confirmar).not.toHaveBeenCalled();
  expect(c.repo.registrarPergunta).toHaveBeenCalledTimes(totalConsultas?1:0);
});

it('confirmação e fechamento não usam a frase antiga de autorização', async () => {
 const {readFile}=await import('node:fs/promises');
 const antiga=['Autorização registrada para emitir somente essas consultas em homologação.', 'A entrega depende das permissões de envio.'].join(' ');
 for(const arquivo of ['src/onboarding/lote-retroativo.ts','src/worker/processar-lote-retroativo.ts']) expect(await readFile(arquivo,'utf8')).not.toContain(antiga);
});
