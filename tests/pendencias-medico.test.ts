import { expect, it, vi } from 'vitest';
import { PendenciasMedico, formatarPendencias, type ContextoPendencias, type RepositorioContextoPendencias } from '../src/onboarding/pendencias-medico.js';
const agora = new Date('2026-10-21T01:00Z');
const resultado = { ok: true, total: 23, consultas: Array.from({ length: 20 }, (_, i) => ({ paciente: `Pessoa Ficticia ${String.fromCharCode(65 + i)}`, dataHora: '2026-10-19T14:00Z', valorCentavos: 30000 })) };
it('lista determinística mantém nome + data, informa restantes e mascara memória', () => {
  const r = formatarPendencias(resultado, '2026-09-03');
  expect(r.fala.length).toBeLessThanOrEqual(3); expect(r.fala.every(t => t.length <= 500)).toBe(true);
  expect(r.fala.join('\n')).toContain('desde 03/09/2026'); expect(r.fala.join('\n')).toContain('Em 19/10/2026: Pessoa Ficticia A');
  expect(r.fala.join('\n')).toMatch(/e mais \d+ consultas/);
  for (const balao of r.fala) for (const linha of balao.split('\n')) if (linha.includes('Pessoa Ficticia')) expect(linha).toContain('19/10/2026');
  expect(r.falaMemoria.join('\n')).not.toContain('Pessoa Ficticia'); expect(r.falaMemoria.join('\n')).toContain('[PACIENTE]');
});
it('aceita dataHora como instância Date retornada pelo driver pg (timestamptz)', () => {
  const r = formatarPendencias({ ok: true, total: 1, consultas: [{ paciente: 'Pessoa Ficticia A', dataHora: new Date('2026-10-19T14:00Z'), valorCentavos: 30000 }] }, '2026-09-03');
  expect(r.fala.join('\n')).toContain('Em 19/10/2026: Pessoa Ficticia A');
});
it('zero exige total zero confirmado; lista contraditória ou incompleta não afirma ausência', () => {
  expect(formatarPendencias({ ok: true, total: 0, consultas: [] }, '2026-09-03').fala.join(' ')).toContain('Não há nenhuma pendência desde 03/09/2026');
  expect(() => formatarPendencias({ ok: true, total: 23, consultas: [] }, '2026-09-03')).toThrow();
  expect(() => formatarPendencias({ ok: false, motivo: 'SINCRONIZACAO_INCOMPLETA' }, '2026-09-03')).toThrow();
});
function cenario() {
  const estado: ContextoPendencias = { dataInicio: null, aguardandoData: false };
  let sync = false;
  const repo: RepositorioContextoPendencias = { ler: vi.fn(async () => ({ ...estado })), perguntarData: vi.fn(async () => { const primeira = !estado.aguardandoData; estado.aguardandoData = true; return primeira; }),
    definirInicio: vi.fn(async (_m, data) => { estado.dataInicio = data; estado.aguardandoData = false; }),
    reservarSync: vi.fn(async () => { if (sync) return false; sync = true; estado.syncAtiva = true; return true; }), concluirSync: vi.fn(async () => { estado.syncAtiva = false; }), registrarAviso: vi.fn(async (_m, texto) => { estado.ultimoAviso = texto; }) };
  const enviar = vi.fn(async (_m: string, _c: string, _k: string, _f: string[], _memoria?: string[]) => {});
  const deps = { permitido: vi.fn(async () => true), classificar: vi.fn(async () => ({ verificar: true, desde: null as string | null, moldura: 'Conferi esse período.' })),
    listar: vi.fn(async () => ({ ...resultado, total: 1, consultas: resultado.consultas.slice(0, 1) } as any)), enviar,
    log: vi.fn(), demoraMs: 1000 };
  return { estado, repo, deps, fluxo: new PendenciasMedico(repo, deps) };
}
it('intenção de verificar sem ação do conversador exige data uma vez e depois ferramenta, nunca memória como resultado', async () => {
  const c = cenario();
  const e = { medicoId: 'm', conversa: 'c', chave: '1', texto: 'ver penentes', mensagens: ['quer verificar pendências?'], agora };
  expect(await c.fluxo.responder(e)).toBe(true); expect(c.deps.listar).not.toHaveBeenCalled();
  await c.fluxo.responder({ ...e, chave: '2' }); expect(c.repo.perguntarData).toHaveBeenCalledTimes(2);
  const perguntas = c.deps.enviar.mock.calls.flatMap(c => c[3]).filter(t => t.includes('?')); expect(perguntas).toHaveLength(1);
  c.deps.classificar.mockResolvedValue({ verificar: true, desde: '2026-09-03', moldura: 'Conferi esse período.' });
  await c.fluxo.responder({ ...e, chave: '3', texto: 'desdi 3 de setenbro' });
  expect(c.deps.listar).toHaveBeenCalledWith('m', '2026-09-03', agora);
  expect(c.deps.enviar.mock.calls.at(-1)?.[3].join(' ')).toContain('Em 19/10/2026: Pessoa Ficticia A');
  expect(c.deps.enviar.mock.calls.flatMap(c => c[3]).join(' ')).not.toContain('deixa eu ver um minutinho');
});
it('resposta rápida não envia aviso; lista sempre refaz leitura mesmo com início já conhecido', async () => {
  const c = cenario(); c.estado.dataInicio = '2026-09-03';
  await c.fluxo.responder({ medicoId: 'm', conversa: 'c', chave: '1', texto: 'ver pendentes', mensagens: [], agora });
  await c.fluxo.responder({ medicoId: 'm', conversa: 'c', chave: '2', texto: 'ver de novo', mensagens: [], agora });
  expect(c.deps.listar).toHaveBeenCalledTimes(2); expect(c.deps.enviar).toHaveBeenCalledTimes(2);
});
it('sync incompleta dispara leitura real em fundo e empurra resultado sem nova mensagem', async () => {
  const c = cenario(); c.estado.dataInicio = '2026-09-03';
  let liberar!: (r: unknown) => void;
  const fundo = new Promise<any>(r => { liberar = r; });
  c.deps.listar.mockResolvedValueOnce({ ok: false, motivo: 'SINCRONIZACAO_INCOMPLETA' }).mockImplementationOnce(() => fundo);
  await c.fluxo.responder({ medicoId: 'm', conversa: 'c', chave: '1', texto: 'ver pendentes', mensagens: [], agora });
  expect(c.deps.listar).toHaveBeenCalledTimes(2);
  expect(c.deps.enviar.mock.calls[0][3].join(' ')).toContain('Ainda estou lendo sua agenda');
  liberar({ ...resultado, total: 1, consultas: resultado.consultas.slice(0, 1) }); await c.fluxo.aguardar();
  expect(c.deps.enviar.mock.calls.at(-1)?.[3].join(' ')).toContain('Em 19/10/2026: Pessoa Ficticia A');
  expect(c.repo.concluirSync).toHaveBeenCalledWith('m', '1', true);
});
it('gate bloqueia sem leitura/IA/envio e falha técnica não revela código', async () => {
  const c = cenario(); c.deps.permitido.mockResolvedValue(false);
  expect(await c.fluxo.responder({ medicoId: 'm', conversa: 'c', chave: '1', texto: 'ver', mensagens: [], agora })).toBe(false);
  expect(c.deps.classificar).not.toHaveBeenCalled(); expect(c.deps.listar).not.toHaveBeenCalled(); expect(c.deps.enviar).not.toHaveBeenCalled();
});

it('consulta lenta avisa só na primeira leitura e não repete anúncio na conversa', async () => {
  vi.useFakeTimers();
  try {
    const c = cenario(); c.estado.dataInicio = '2026-09-03';
    for (const chave of ['1', '2']) {
      let liberar!: (r: any) => void;
      c.deps.listar.mockImplementationOnce(() => new Promise(r => { liberar = r; }));
      const p = c.fluxo.responder({ medicoId: 'm', conversa: 'c', chave, texto: 'ver pendentes', mensagens: [], agora });
      await vi.advanceTimersByTimeAsync(1001);
      const avisos = c.deps.enviar.mock.calls.filter(c => c[2].endsWith(':espera'));
      expect(avisos).toHaveLength(1);
      liberar({ ...resultado, total: 1, consultas: resultado.consultas.slice(0,1) }); await p;
    }
    const avisos = c.deps.enviar.mock.calls.filter(c => c[2].endsWith(':espera')).map(c => c[3].join(' '));
    expect(avisos).toEqual(['Sua agenda já está conectada, deixa eu ver um minutinho.']); expect(c.deps.listar).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
it('erro da sync em fundo explica instabilidade sem zero nem código técnico', async () => {
  const c = cenario(); c.estado.dataInicio = '2026-09-03';
  c.deps.listar.mockResolvedValueOnce({ ok: false, motivo: 'SEM_CONSULTAS_SINCRONIZADAS' }).mockRejectedValueOnce(Error('BANCO_SENHA_SUPER_PRIVADA'));
  await c.fluxo.responder({ medicoId: 'm', conversa: 'c', chave: '1', texto: 'ver pendentes', mensagens: [], agora }); await c.fluxo.aguardar();
  const fala = c.deps.enviar.mock.calls.flatMap(c => c[3]).join(' ');
  expect(fala).toContain('instabilidade'); expect(fala).not.toMatch(/BANCO|SENHA|nenhuma pendência|não há/i);
  expect(c.repo.concluirSync).toHaveBeenCalledWith('m', '1', false);
});
it('pós-conexão sem início pergunta data antes de sincronizar ou listar', async () => {
  const c = cenario();
  await c.fluxo.aposSyncIncompleta('m','c','evento',agora);
  expect(c.repo.perguntarData).toHaveBeenCalledOnce();
  expect(c.deps.enviar.mock.calls.at(-1)?.[3]).toEqual(['Desde quando você não emite notas?']);
  expect(c.deps.listar).not.toHaveBeenCalled(); expect(c.repo.reservarSync).not.toHaveBeenCalled();
});
it('classificador independente usa contexto e relógio, sem depender de acao; JSON indevido não destrava', async () => {
  const { classificarPendencias } = await import('../src/onboarding/pendencias-medico.js');
  const completar = vi.fn(async () => '{"verificar":true,"desde":"2026-10-19","moldura":"Veja o que encontrei."}');
  const entrada = { texto: 've as penentes desdi onten', mensagens: ['Quer verificar suas pendências?'], agora, aguardandoData: false };
  expect(await classificarPendencias('key','model',completar,entrada)).toMatchObject({ verificar: true, desde: '2026-10-19' });
  expect(completar.mock.calls[0][2][1].content).toContain('2026-10-20'); expect(completar.mock.calls[0][2][1].content).toContain('Quer verificar');
  completar.mockResolvedValue('{"verificar":true,"desde":"2026-10-19","acao":"emitir"}');
  expect((await classificarPendencias('key','model',completar,entrada)).verificar).toBe(false);
});
it('controle persistido guarda só período/estado, com reserva atômica e migration manual protegida', async () => {
  const { PostgresContextoPendencias } = await import('../src/io/postgres/postgres-contexto-pendencias.js');
  const { readFileSync } = await import('node:fs');
  let perguntou = false;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('aguardando_data) values')) { const rows = perguntou ? [] : [{ medico_id: 'm' }]; perguntou = true; return { rows }; }
    return { rows: [{ medico_id: 'm' }] };
  });
  const repo = new PostgresContextoPendencias({ query } as any);
  expect(await repo.perguntarData('m')).toBe(true); expect(await repo.perguntarData('m')).toBe(false);
  expect(query.mock.calls[0][0]).toContain('where not noto_contexto_pendencias.aguardando_data');
  await repo.definirInicio('m', '2026-09-03');
  expect(query.mock.calls.at(-1)?.[0]).toContain("sync_estado='executando' then noto_contexto_pendencias.atualizado_em");
  await repo.reservarSync('m', 'pedido');
  expect(query.mock.calls.at(-1)?.[0]).toContain("sync_estado is distinct from 'executando'");
  const sql = readFileSync('scripts/migrations/20261025-contexto-pendencias.sql', 'utf8');
  expect(sql).toContain('enable row level security'); expect(sql).toContain('from anon, authenticated'); expect(sql).toContain('references public.medicos(id) on delete cascade');
  expect(sql).not.toMatch(/nome|cpf|valor_cobrado|valor_consulta|create policy/i);
});
it('pedido atual de emissão tem prioridade sobre verificar e reaproveita o período sem relistar',async()=>{
 const c=cenario();c.estado.dataInicio='2026-09-03';
 c.deps.classificar.mockResolvedValue({verificar:true,emitir:true,desde:null,moldura:'Veja o que encontrei.'} as any);
 const aoEmitir=vi.fn();
 expect(await c.fluxo.responder({medicoId:'m',conversa:'c',chave:'emitir',texto:'Pode emitir as notas desse período',mensagens:['173 consultas sem nota desde 03/09/2026'],agora,aoEmitir})).toBe(true);
 expect(aoEmitir).toHaveBeenCalledExactlyOnceWith('2026-09-03');expect(c.deps.listar).not.toHaveBeenCalled();expect(c.deps.enviar).not.toHaveBeenCalled();
});
it('pedido de emissão sem período encaminha null; sem executor não é convertido em verificação',async()=>{
 const c=cenario();c.deps.classificar.mockResolvedValue({verificar:true,emitir:true,desde:null,moldura:'Veja o que encontrei.'} as any);
 const entrada={medicoId:'m',conversa:'c',chave:'e',texto:'quero emtiir as notas',mensagens:[],agora};const aoEmitir=vi.fn();
 expect(await c.fluxo.responder({...entrada,aoEmitir})).toBe(true);expect(aoEmitir).toHaveBeenCalledExactlyOnceWith(null);
 expect(await c.fluxo.responder(entrada)).toBe(false);expect(c.deps.listar).not.toHaveBeenCalled();
});
it('contagem lê ferramenta e chama continuação sem reenviar a lista já apresentada',async()=>{
 const c=cenario();const concluir=vi.fn();
 await c.fluxo.consultar('m','c','e','2026-09-03',agora,'',3,concluir,false);
 expect(concluir).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ok:true,total:1}));expect(c.deps.listar).toHaveBeenCalledOnce();expect(c.deps.enviar).not.toHaveBeenCalled();
});
it.each(['Pode emitir as notas desse período','emite as notas','quero emtiir as notaas'])('protocolo IA distingue emissão atual com contexto: %s',async texto=>{
 const {classificarPendencias}=await import('../src/onboarding/pendencias-medico.js');
 const completar=vi.fn(async()=>'{"verificar":true,"emitir":true,"desde":null,"moldura":"Conferi esse período."}');
 expect(await classificarPendencias('k','m',completar,{texto,mensagens:['173 consultas sem nota desde 03/09/2026'],agora,aguardandoData:false})).toMatchObject({emitir:true,verificar:false});
 expect(completar.mock.calls[0][2][0].content).toContain('Pedido ATUAL de emissão');expect(completar.mock.calls[0][2][1].content).toContain(texto);
});
it('agrupa por data sem nome solto e mantém a memória mascarada',()=>{
 const r=formatarPendencias({ok:true,total:3,consultas:[
  {paciente:'Pessoa A',dataHora:'2026-10-07T12:00Z'}, {paciente:'Pessoa B',dataHora:'2026-10-06T12:00Z'}, {paciente:'Pessoa C',dataHora:'2026-10-06T13:00Z'}
 ]},'2026-10-01');
 expect(r.fala.join('\n')).toContain('Em 06/10/2026: Pessoa B e Pessoa C.');
 expect(r.fala.join('\n')).toContain('Em 07/10/2026: Pessoa A.');
 expect(r.falaMemoria.join(' ')).not.toMatch(/Pessoa [ABC]/);expect(r.falaMemoria.join(' ')).toContain('[PACIENTE]');
});
it('aviso de agenda já conectada não reaparece depois de já comunicado',async()=>{
 vi.useFakeTimers();try {
  const c=cenario();c.estado.dataInicio='2026-09-03';c.estado.ultimoAviso='Sua agenda já está conectada, deixa eu ver um minutinho.';
  let concluir!:(r:any)=>void;c.deps.listar.mockImplementationOnce(()=>new Promise(r=>{concluir=r;}));
  const p=c.fluxo.consultar('m','c','nova','2026-09-03',agora);await vi.advanceTimersByTimeAsync(2000);
  expect(c.deps.enviar).not.toHaveBeenCalled();concluir({ok:true,total:0,consultas:[]});await p;
  expect(c.deps.enviar).toHaveBeenCalledOnce();expect(c.deps.enviar.mock.calls[0][3][0]).toContain('Não há nenhuma pendência');
 }finally{vi.useRealTimers();}
});
it('falha de leitura avisa uma vez, refaz leitura em fundo e retorna resultado sem nova mensagem',async()=>{
 const c=cenario();let concluir!:(r:any)=>void;
 c.deps.listar.mockRejectedValueOnce(Error('SEGREDO_TECNICO')).mockImplementationOnce(()=>new Promise(r=>{concluir=r;}));
 await c.fluxo.consultar('m','c','erro','2026-09-03',agora);
 expect(c.deps.listar).toHaveBeenCalledTimes(2);await vi.waitFor(()=>expect(c.deps.enviar).toHaveBeenCalledOnce());expect(c.deps.enviar.mock.calls[0][3].join(' ')).toMatch(/verific|confer/i);
 concluir({ok:true,total:0,consultas:[]});await c.fluxo.aguardar();
 expect(c.deps.enviar.mock.calls.at(-1)?.[3].join(' ')).toContain('Não há nenhuma pendência desde 03/09/2026');
 expect(JSON.stringify(c.deps.enviar.mock.calls)).not.toContain('SEGREDO_TECNICO');
});
it('guarda início respondido antes da conexão, sem consultar ou autorizar emissão',async()=>{
 const c=cenario();c.estado.aguardandoData=true;c.deps.classificar.mockResolvedValue({verificar:true,desde:'2026-10-01',moldura:'Veja o que encontrei.'});
 const emitir=vi.fn();expect(await c.fluxo.responder({medicoId:'m',conversa:'c',chave:'data',texto:'primeiro de outubro',mensagens:['Desde quando você não emite notas?'],agora,agendaConectada:false,aoEmitir:emitir})).toBe(false);
 expect(c.repo.definirInicio).toHaveBeenCalledWith('m','2026-10-01');expect(c.deps.listar).not.toHaveBeenCalled();expect(emitir).not.toHaveBeenCalled();
});
it('duas falhas da mesma verificação encerram com conclusão honesta, sem loop nem promessa pendente',async()=>{
 const c=cenario();let rejeitar!:(e:Error)=>void;
 c.deps.listar.mockRejectedValueOnce(Error('CODIGO_TECNICO')).mockImplementationOnce(()=>new Promise((_r,reject)=>{rejeitar=reject;}));
 await c.fluxo.consultar('m','c','erro','2026-09-03',agora);await vi.waitFor(()=>expect(c.deps.enviar).toHaveBeenCalledOnce());
 rejeitar(Error('CODIGO_TECNICO'));await c.fluxo.aguardar();
 const falas=c.deps.enviar.mock.calls.flatMap(c=>c[3]);expect(c.deps.listar).toHaveBeenCalledTimes(2);expect(falas).toHaveLength(2);expect(new Set(falas).size).toBe(2);
 expect(falas[0]).toMatch(/verific|confer/i);expect(falas[1]).not.toMatch(/volto|retorno|verificando|CODIGO/);expect(c.repo.concluirSync).toHaveBeenCalledWith('m','erro',false);
});
it('erro após leitura concluída não refaz callback de lote nem leitura ou emissão',async()=>{
 const c=cenario();const concluir=vi.fn(async()=>{throw Error('FISCAL_FALHOU');});
 await c.fluxo.consultar('m','c','callback','2026-09-03',agora,'',3,concluir);await c.fluxo.aguardar();
 expect(c.deps.listar).toHaveBeenCalledOnce();expect(concluir).toHaveBeenCalledOnce();expect(c.repo.reservarSync).not.toHaveBeenCalled();
 expect(c.deps.enviar.mock.calls.at(-1)?.[3].join(' ')).not.toContain('FISCAL');
});
