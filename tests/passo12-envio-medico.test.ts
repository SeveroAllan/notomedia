import { BancoConversaFalso } from './fakes/banco-conversa.js';
import { createHmac } from 'node:crypto';
import { montarBoasVindas } from '../src/onboarding/regras/decidir-proxima-acao.js';
import { beforeEach, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { EnviarMensagemPacienteParams } from '../src/whatsapp/enviar-mensagem-paciente.js';
import { carregarConfig } from '../src/config.js';
import { ComunicacaoHomologacao } from '../src/whatsapp/comunicacao-homologacao.js';

let bancoMensagens: BancoConversaFalso;
beforeEach(() => { bancoMensagens = new BancoConversaFalso(); });

it('flags novas nascem desligadas e a allowlist nasce vazia', () => {
  expect(carregarConfig({})).toMatchObject({ envioMedicoRealAtivo: false, envioPacienteRealAtivo: false, envioRealAllowlist: [] });
});
it.each([
  [false, 'homologacao', ['11999990000']],
  [true, 'producao', ['11999990000']],
  [true, 'homologacao', []],
  [true, 'homologacao', ['11988880000']],
  [true, null, ['11999990000']]
])('bloqueia médico flag=%s ambiente=%s allowlist=%j', async (flag, ambiente, allowlist) => {
  const enviarTexto = vi.fn(async (_p: EnviarMensagemPacienteParams) => ({ sucesso: true }));
  const query = vi.fn(async (_sql: string) => ({ rows: [{ telefone: '5511999990000', ambiente }] }));
  const config = { ...carregarConfig({}), envioMedicoRealAtivo: flag, envioRealAllowlist: allowlist };
  const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, config, { enviarTexto }, vi.fn());
  expect(await c.medico({ medicoId: 'm', acao: 'pedir_agenda', chave: 'msg' })).toBe('simulado');
  expect(enviarTexto).not.toHaveBeenCalled();
  expect(query.mock.calls.filter(c => String(c[0]).includes('insert into'))).toEqual([]);
});
it('cada médico/ação/chave envia uma vez mesmo com corrida; falha mantém reserva consumida', async () => {
  const reservas = new Set<string>(), gravacoes: any[] = [];
  const query = vi.fn(async (sql: string, p: any[] = []) => {
    gravacoes.push(p);
    if (sql.includes('from medicos m')) return { rows: [{ telefone: '5511999990000', ambiente: 'homologacao' }] };
    if (sql.includes('insert into')) { const chave = JSON.stringify(p); if (reservas.has(chave)) return { rows: [] }; reservas.add(chave); return { rows: [{ id: String(reservas.size) }] }; }
    if (sql.includes('update ')) return { rows: [] };
    throw Error('SQL não modelado');
  });
  const enviarTexto = vi.fn(async (_p: EnviarMensagemPacienteParams) => ({ sucesso: false }));
  const config = { ...carregarConfig({}), envioMedicoRealAtivo: true, envioRealAllowlist: ['11999990000'] };
  const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, config, { enviarTexto }, vi.fn());
  const entrada = { medicoId: 'm', acao: 'perguntar_medico' as const, motivo: 'VALOR_DIVERGENTE', chave: 'mensagem-ficticia:5511999990000' };
  await Promise.all([c.medico(entrada), c.medico(entrada)]); await c.medico(entrada);
  expect(enviarTexto).toHaveBeenCalledTimes(1);
  expect(enviarTexto.mock.calls[0][0]).toMatchObject({ instanciaNome: 'notomed_assistente', contatoTelefone: '5511999990000', texto: expect.stringContaining('valor') });
  expect(JSON.stringify(gravacoes)).not.toContain('5511999990000');
  expect(query.mock.calls.some(c => c[0].includes('update ') && c[1]?.[1] === 'erro')).toBe(true);
});
it.each(['perguntar_medico', 'perguntar_pacote', 'pedir_agenda', 'falha_emissao', 'nota_gerada'] as const)('texto de %s é fixo e não inclui conteúdo arbitrário', async acao => {
  const enviarTexto = vi.fn(async (_p: EnviarMensagemPacienteParams) => ({ sucesso: true }));
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('from medicos m') ? [{ telefone: '11999990000', ambiente: 'homologacao' }] : [{ id: 'r' }] }));
  const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, { ...carregarConfig({}), envioMedicoRealAtivo: true, envioRealAllowlist: ['11999990000'] }, { enviarTexto }, vi.fn());
  await c.medico({ medicoId: 'm', acao, motivo: 'texto livre CPF PRIVADO', chave: 'msg' });
  expect(enviarTexto).toHaveBeenCalledTimes(1);
  expect(enviarTexto.mock.calls[0][0].texto).not.toContain('PRIVADO');
});

it('normalização não confunde DDD 55 com o código do país', async () => {
  const { gerarVariantesTelefoneBrasileiro } = await import('../src/whatsapp/variantes-telefone-brasileiro.js');
  expect(gerarVariantesTelefoneBrasileiro('55999990000')).toContain('5555999990000');
  expect(gerarVariantesTelefoneBrasileiro('5555999990000')).toContain('55999990000');
});

it.each([{ fala: [] }, { fala: ['1', '2', '3', '4'] }, { fala: [''] }, { fala: ['x'.repeat(501)] }])('conversa recusa lote inválido %j antes de banco ou transporte', async ({ fala }) => {
  const query = vi.fn(), enviarTexto = vi.fn();
  const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, carregarConfig({}), { enviarTexto }, vi.fn());
  expect(await c.conversa({ medicoId: 'm', chave: 'msg', fala })).toBe('erro');
  expect(query).not.toHaveBeenCalled(); expect(enviarTexto).not.toHaveBeenCalled();
});

it.each(['sucesso', 'falha', 'excecao', 'confirmacao falha'])('conversa reserva o lote de até três balões, sem repetição após %s', async caso => {
  const reservas = new Set<string>();
  const query = vi.fn(async (sql: string, p: any[] = []) => {
    if (sql.includes('from medicos m')) return { rows: [{ telefone: '+5551993527271', ambiente: 'homologacao' }] };
    if (sql.includes('insert into public.noto_envios_homologacao')) {
      const chave = JSON.stringify(p); if (reservas.has(chave)) return { rows: [] };
      reservas.add(chave); return { rows: [{ id: 'reserva' }] };
    }
    if (sql.startsWith('update public.noto_envios_homologacao')) {
      if (caso === 'confirmacao falha') throw Error('CONFIRMACAO_INDISPONIVEL');
      return { rows: [] };
    }
    if (sql.startsWith('insert into conversa_mensagens')) return bancoMensagens.query(sql, p);
    throw Error('SQL_NAO_MODELADO');
  });
  const enviarTexto = vi.fn(async (_p: EnviarMensagemPacienteParams) => {
    if (caso === 'excecao') throw Error('ENTREGA_INCERTA');
    return { sucesso: caso !== 'falha' };
  });
  const config = { ...carregarConfig({}), envioMedicoRealAtivo: true, envioPacienteRealAtivo: false, envioRealAllowlist: ['+5551993527271'] };
  const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, config, { enviarTexto }, vi.fn());
  const entrada = { medicoId: 'm', chave: 'evento', fala: ['Primeiro.', 'Segundo.', 'Terceiro.'] };
  const resultados = await Promise.all([c.conversa(entrada), c.conversa(entrada)]);
  expect(resultados).toEqual([caso === 'sucesso' ? 'enviado' : 'erro', 'repetido']);
  expect(await new ComunicacaoHomologacao({ query } as unknown as pg.Pool, config, { enviarTexto }, vi.fn()).conversa(entrada)).toBe('repetido');
  const textos = caso === 'falha' || caso === 'excecao' ? ['Primeiro.'] : entrada.fala;
  expect(enviarTexto.mock.calls.map(([p]) => p)).toEqual(textos.map(texto => ({
    instanciaNome: config.evolutionAssistantInstanceName, contatoTelefone: '+5551993527271', texto
  })));
  expect(reservas.size).toBe(1);
  const inserts = query.mock.calls.filter(([sql]) => sql.includes('insert into public.noto_envios_homologacao'));
  expect(inserts).toHaveLength(1);
  expect(bancoMensagens.mensagens).toHaveLength(1);
  expect(inserts[0][1]).toEqual(['m', 'conversa_livre', expect.stringMatching(/^[a-f0-9]{64}$/)]);
  const banco = JSON.stringify(query.mock.calls.filter(([sql]) => !sql.startsWith('insert into conversa_mensagens')));
  expect(bancoMensagens.mensagens[0].texto).toBe(entrada.fala.join('\n'));
  for (const texto of entrada.fala) expect(banco).not.toContain(texto);
  expect(banco).not.toContain('+5551993527271');
});

it.each([
  [false, 'homologacao', ['11999990000']],
  [true, 'producao', ['11999990000']],
  [true, 'homologacao', ['11988880000']],
  [true, null, ['11999990000']]
])('boas-vindas bloqueadas por flag=%s ambiente=%s allowlist=%j', async (ativo, ambiente, allowlist) => {
  const query = vi.fn(async (_sql: string) => ({ rows: [{ telefone: '5511999990000', ambiente }] }));
  const enviarTexto = vi.fn(), aoEnviar = vi.fn(), log = vi.fn();
  const config = { ...carregarConfig({}), envioMedicoRealAtivo: ativo, envioRealAllowlist: allowlist };
  const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, config, { enviarTexto }, log);
  expect(await c.boasVindas({ medicoId: 'm', nomeMedico: 'ALICE CASTRO', ultimaNota: null, aoEnviar })).toBe('simulado');
  expect(enviarTexto).not.toHaveBeenCalled(); expect(aoEnviar).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledExactlyOnceWith('enviaria boas_vindas');
  if (!ativo) expect(query).not.toHaveBeenCalled();
  expect(query.mock.calls.filter(([sql]) => sql.includes('insert into'))).toEqual([]);
});
it.each([undefined, '', '   '])('boas-vindas recusam nome ausente/vazio %j', async nomeMedico => {
  const query = vi.fn(), enviarTexto = vi.fn();
  const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, carregarConfig({}), { enviarTexto }, vi.fn());
  expect(await c.boasVindas({ medicoId: 'm', nomeMedico, ultimaNota: null })).toBe('erro');
  expect(query).not.toHaveBeenCalled(); expect(enviarTexto).not.toHaveBeenCalled();
});
it.each([false, true])('boas-vindas enviam em ordem, uma única vez por médico, com falha no segundo=%s', async falha => {
  const reservas = new Set<string>();
  const query = vi.fn(async (sql: string, p: any[] = []) => {
    if (sql.includes('from medicos m')) return { rows: [{ telefone: '5511999990000', ambiente: 'homologacao' }] };
    if (sql.includes('insert into public.noto_envios_homologacao')) {
      const chave = JSON.stringify(p); if (reservas.has(chave)) return { rows: [] };
      reservas.add(chave); return { rows: [{ id: 'r' }] };
    }
    if (sql.startsWith('update public.noto_envios_homologacao')) return { rows: [] };
    if (sql.startsWith('insert into conversa_mensagens')) return bancoMensagens.query(sql, p);
    throw Error('SQL_NAO_MODELADO');
  });
  const enviarTexto = vi.fn(async (_p: EnviarMensagemPacienteParams) => ({ sucesso: true }));
  if (falha) enviarTexto.mockResolvedValueOnce({ sucesso: true }).mockResolvedValueOnce({ sucesso: false });
  const aoEnviar = vi.fn(async (_telefone: string, _baloes: string[]) => {});
  const config = { ...carregarConfig({}), envioMedicoRealAtivo: true, envioRealAllowlist: ['11999990000'] };
  const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, config, { enviarTexto }, vi.fn());
  const ultimaNota = { paciente: 'Paciente Ficticio', dataEmissao: '2026-10-20', valorCentavos: 30000, diasDesdeEmissao: 0 };
  const baloes = montarBoasVindas('ALICE CASTRO MENEZES XAVIER', ultimaNota);
  expect(await c.boasVindas({ medicoId: 'm', nomeMedico: 'ALICE CASTRO MENEZES XAVIER', ultimaNota, aoEnviar })).toBe(falha ? 'erro' : 'enviado');
  expect(enviarTexto.mock.calls.map(([p]) => p)).toEqual((falha ? baloes.slice(0, 2) : baloes).map(texto => ({
    instanciaNome: config.evolutionAssistantInstanceName, contatoTelefone: '5511999990000', texto
  })));
  const hash = createHmac('sha256', config.appPepper).update(JSON.stringify(['m', 'boas_vindas', 'unica'])).digest('hex');
  expect(query.mock.calls.find(([sql]) => sql.includes('insert into public.noto_envios_homologacao'))?.[1]).toEqual(['m', 'boas_vindas', hash]);
  expect(query).toHaveBeenCalledWith('update public.noto_envios_homologacao set estado = $2 where id = $1', ['r', falha ? 'erro' : 'enviado']);
  if (falha) expect(aoEnviar).not.toHaveBeenCalled();
  else expect(aoEnviar).toHaveBeenCalledExactlyOnceWith('5511999990000', baloes);
  expect(await new ComunicacaoHomologacao({ query } as unknown as pg.Pool, config, { enviarTexto }, vi.fn()).boasVindas({
    medicoId: 'm', nomeMedico: 'Outro Nome', ultimaNota: null, aoEnviar
  })).toBe('repetido');
  expect(enviarTexto).toHaveBeenCalledTimes(falha ? 2 : 5);
  expect(aoEnviar).toHaveBeenCalledTimes(falha ? 0 : 1);
});
it.each([
  [false, 'homologacao', true, 'simulado'], [true, 'producao', true, 'simulado'],
  [true, 'homologacao', false, 'simulado'], [true, 'homologacao', true, 'enviado']
] as const)('pergunta de confirmação respeita flag=%s ambiente=%s allowlist=%s', async (ativo, ambiente, permitido, esperado) => {
  const reservas = new Set<string>();
  const query = vi.fn(async (sql: string, p: any[] = []) => {
    if (sql.includes('from medicos m')) return { rows: [{ telefone: '+5551993527271', ambiente }] };
    if (sql.includes('insert into public.noto_envios_homologacao')) { const chave = JSON.stringify(p); if (reservas.has(chave)) return { rows: [] }; reservas.add(chave); return { rows: [{ id: 'envio' }] }; }
    if (sql.startsWith('update public.noto_envios_homologacao')) return { rows: [] };
    if (sql.startsWith('insert into conversa_mensagens')) return bancoMensagens.query(sql, p);
    throw Error('SQL_NAO_MODELADO');
  });
  const enviarTexto = vi.fn(async () => ({ sucesso: true, mensagemId: 'pergunta-real-fixture' }));
  const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, { ...carregarConfig({}), envioMedicoRealAtivo: ativo,
    envioRealAllowlist: permitido ? ['+5551993527271'] : [] }, { enviarTexto }, vi.fn());
  const entrada = { medicoId: 'medico', solicitacaoId: 'sol', paciente: 'Ana', dataEnvioPagamento: '2026-10-20T01:00Z', dataConsulta: '2026-10-18T15:00Z' };
  expect(await c.confirmarEmissao(entrada)).toEqual(esperado === 'enviado' ? { resultado: 'enviado', chaveMensagem: 'pergunta-real-fixture' } : { resultado: 'simulado' });
  if (esperado === 'enviado') {
    expect(enviarTexto).toHaveBeenCalledExactlyOnceWith({ instanciaNome: carregarConfig({}).evolutionAssistantInstanceName, contatoTelefone: '+5551993527271',
      texto: 'Pronto para emitir a nota do Ana, que enviou o pagamento em 19/10/2026 da consulta de 18/10/2026. Posso emitir?' });
    expect(await c.confirmarEmissao(entrada)).toEqual({ resultado: 'repetido' }); expect(enviarTexto).toHaveBeenCalledOnce();
  } else expect(enviarTexto).not.toHaveBeenCalled();
  expect(await c.medicoPermitido('medico')).toBe(esperado === 'enviado');
});
it.each([
  [false, 'homologacao', true], [true, 'producao', true], [true, 'homologacao', false], [true, 'homologacao', true]
] as const)('tradução de falha mantém flag=%s ambiente=%s allowlist=%s e dedup', async (ativo, ambiente, permitir) => {
  const chaves = new Set<string>();
  const query = vi.fn(async (sql: string, p: unknown[] = []) => {
    if (sql.includes('from medicos m')) return { rows: [{ telefone: '+5551993527271', ambiente }] };
    if (sql.includes('insert into public.noto_envios_homologacao')) { const k = JSON.stringify(p); if (chaves.has(k)) return { rows: [] }; chaves.add(k); return { rows: [{ id: 'r' }] }; }
    if (sql.startsWith('update public.noto_envios_homologacao')) return { rows: [] }; throw Error('SQL_NAO_MODELADO');
  });
  const enviarTexto = vi.fn(async () => ({ sucesso: true }));
  const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, { ...carregarConfig({}), envioMedicoRealAtivo: ativo, envioRealAllowlist: permitir ? ['+5551993527271'] : [] }, { enviarTexto }, vi.fn());
  const entrada = { medicoId: 'm', acao: 'falha_emissao' as const, chave: 'sol', motivo: 'CERTIFICADO_AUSENTE' };
  expect(await c.medico(entrada)).toBe(ativo && permitir && ambiente === 'homologacao' ? 'enviado' : 'simulado');
  if (ativo && permitir && ambiente === 'homologacao') {
    expect(enviarTexto.mock.calls[0]).toEqual([{ instanciaNome: carregarConfig({}).evolutionAssistantInstanceName, contatoTelefone: '+5551993527271', texto: 'Não encontrei um certificado digital ativo; cadastre um certificado válido antes de pedir uma nova tentativa.' }]);
    expect(await c.medico(entrada)).toBe('repetido'); expect(enviarTexto).toHaveBeenCalledOnce();
  } else expect(enviarTexto).not.toHaveBeenCalled();
});

it.each([
  [false, true, 'homologacao', ['51993527271']], [true, false, 'homologacao', ['51993527271']],
  [true, true, 'producao', ['51993527271']], [true, true, 'homologacao', []]
])('leitura bloqueada conversa=%s envio=%s ambiente=%s', async (livre, envio, ambiente, allowlist) => {
  const marcarLida = vi.fn(); const query = vi.fn(async (_sql: string) => ({ rows: [{ telefone: '5551993527271', ambiente }] }));
  const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, { ...carregarConfig({}), conversaLivreAtiva: livre, envioMedicoRealAtivo: envio, envioRealAllowlist: allowlist }, { enviarTexto: vi.fn(), marcarLida }, vi.fn());
  expect(await c.marcarLida('m', { id: 'msg', remoteJid: '555193527271@s.whatsapp.net', fromMe: false })).toBe('simulado');
  expect(marcarLida).not.toHaveBeenCalled(); expect(query.mock.calls.some(c => String(c[0]).includes('insert into'))).toBe(false);
});
it('Evolution envia readMessages com a chave original, uma vez por evento', async () => {
  const { EvolutionApiClient } = await import('../src/io/evolution/evolution-api-client.js');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));
  const reservas = new Set<string>();
  const query = vi.fn(async (sql: string, p: any[] = []) => {
    if (sql.includes('from medicos m')) return { rows: [{ telefone: '+5551993527271', ambiente: 'homologacao' }] };
    if (sql.includes('insert into')) { const chave = JSON.stringify(p); if (reservas.has(chave)) return { rows: [] }; reservas.add(chave); return { rows: [{ id: 'r' }] }; }
    return { rows: [] };
  });
  try {
    const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, { ...carregarConfig({}), conversaLivreAtiva: true, envioMedicoRealAtivo: true, envioRealAllowlist: ['+5551993527271'] }, new EvolutionApiClient('https://evolution.invalid', 'ficticia', 'assistente', 'oficial'), vi.fn());
    const chave = { id: 'original', remoteJid: '123456789@lid', remoteJidAlt: '555193527271@s.whatsapp.net', fromMe: false };
    expect(await c.marcarLida('m', chave)).toBe('enviado'); expect(await c.marcarLida('m', chave)).toBe('repetido');
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://evolution.invalid/chat/markMessageAsRead/notomed_assistente', expect.objectContaining({ method: 'POST', body: JSON.stringify({ readMessages: [{ id: 'original', remoteJid: '123456789@lid', fromMe: false }] }) }));
  } finally { fetcher.mockRestore(); }
});

it.each(['conversa off', 'envio off', 'produção', 'fora da lista', 'emoji inválido'])('reação respeita bloqueio %s', async caso => {
  const enviarReacao = vi.fn(); const query = vi.fn(async (_sql: string) => ({ rows: [{ telefone: '+5551993527271', ambiente: caso === 'produção' ? 'producao' : 'homologacao' }] }));
  const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, { ...carregarConfig({}), conversaLivreAtiva: caso !== 'conversa off', envioMedicoRealAtivo: caso !== 'envio off', envioRealAllowlist: caso === 'fora da lista' ? [] : ['+5551993527271'] }, { enviarTexto: vi.fn(), enviarReacao }, vi.fn());
  expect(await c.reagir('m', { id: 'msg', remoteJid: '555193527271@s.whatsapp.net', fromMe: false }, caso === 'emoji inválido' ? '💣' : '👍')).toBe('simulado');
  expect(enviarReacao).not.toHaveBeenCalled();
});
it('Evolution envia reação pela key recebida e audita sem reenviar', async () => {
  const { EvolutionApiClient } = await import('../src/io/evolution/evolution-api-client.js');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true })); const reservas = new Set<string>();
  const query = vi.fn(async (sql: string, p: any[] = []) => {
    if (sql.includes('from medicos m')) return { rows: [{ telefone: '+5551993527271', ambiente: 'homologacao' }] };
    if (sql.includes('insert into')) { const chave = JSON.stringify(p); if (reservas.has(chave)) return { rows: [] }; reservas.add(chave); return { rows: [{ id: 'r' }] }; }
    return { rows: [] };
  });
  try {
    const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, { ...carregarConfig({}), conversaLivreAtiva: true, envioMedicoRealAtivo: true, envioRealAllowlist: ['+5551993527271'] }, new EvolutionApiClient('https://evolution.invalid', 'ficticia', 'assistente', 'oficial'), vi.fn());
    const chave = { id: 'original', remoteJid: '555193527271@s.whatsapp.net', fromMe: false };
    expect(await c.reagir('m', chave, '👀')).toBe('enviado'); expect(await c.reagir('m', chave, '👀')).toBe('repetido');
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://evolution.invalid/message/sendReaction/notomed_assistente', expect.objectContaining({ method: 'POST', body: JSON.stringify({ key: chave, reaction: '👀' }) }));
    expect(query).toHaveBeenCalledWith('update public.noto_envios_homologacao set estado = $2 where id = $1', ['r', 'enviado']);
  } finally { fetcher.mockRestore(); }
});

it.each([
  [[{ name: 'notomed_assistente', ownerJid: '5511999990000@s.whatsapp.net' }], '5511999990000'],
  [[{ name: 'notomed_oficial', ownerJid: '5511999990000@s.whatsapp.net' }], null],
  [[{ name: 'notomed_assistente', ownerJid: 'grupo@g.us' }], null],
  [{ erro: 'privado' }, null]
])('link de retorno usa só a identidade da instância assistente %j', async (resposta, esperado) => {
  const { EvolutionApiClient } = await import('../src/io/evolution/evolution-api-client.js');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(resposta));
  try {
    expect(await new EvolutionApiClient('https://evolution.invalid', 'ficticia', 'notomed_assistente', 'notomed_oficial').obterTelefoneInstancia()).toBe(esperado);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://evolution.invalid/instance/fetchInstances?instanceName=notomed_assistente', expect.objectContaining({ redirect: 'error' }));
  } finally { fetcher.mockRestore(); }
});

it.each(['boas_vindas:unica', 'agenda:link:acesso', 'agenda:link', 'agenda:falha'])('20 transportes concorrentes de %s reservam uma linha antes do primeiro balão', async chave => {
  const banco = new BancoConversaFalso(), reservas = new Set<string>();
  const query = async (sql: string, p: any[] = []) => {
    if (sql.includes('from medicos m')) return { rows: [{ telefone: '5551993527271', ambiente: 'homologacao' }] };
    if (sql.startsWith('insert into conversa_mensagens')) return banco.query(sql, p);
    if (sql.includes('insert into public.noto_envios_homologacao')) { const id = JSON.stringify(p); if (reservas.has(id)) return { rows: [] }; reservas.add(id); return { rows: [{ id: 'reserva' }] }; }
    if (sql.startsWith('update public.noto_envios_homologacao')) return { rows: [] };
    throw Error('SQL_NAO_MODELADO');
  };
  const enviarTexto = vi.fn(async () => { expect(banco.mensagens).toHaveLength(1); expect(banco.mensagens[0].mensagemId).toBe(`noto:${chave}`); return { sucesso: true }; });
  const config = { ...carregarConfig({}), envioMedicoRealAtivo: true, envioRealAllowlist: ['+5551993527271'] };
  const resultados = await Promise.all(Array.from({ length: 20 }, () => {
    const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, config, { enviarTexto }, vi.fn());
    return chave === 'boas_vindas:unica' ? c.boasVindas({ medicoId: 'medico', nomeMedico: 'Alice', ultimaNota: null }) : c.conversa({ medicoId: 'medico', chave, fala: ['Mensagem automática.'] });
  }));
  expect(resultados.filter(r => r === 'enviado')).toHaveLength(1); expect(resultados.filter(r => r === 'repetido')).toHaveLength(19);
  expect(banco.mensagens).toHaveLength(1); expect(enviarTexto).toHaveBeenCalledTimes(chave === 'boas_vindas:unica' ? 4 : 1);
});

it('pergunta do lote vincula o id Evolution apenas depois de envio protegido e não repete', async () => {
  const reservas = new Set<string>();
  const query = vi.fn(async (sql: string, p: any[] = []) => {
    if (sql.includes('from medicos m')) return { rows: [{ telefone: '5511999990000', ambiente: 'homologacao' }] };
    if (sql.includes('conversa_mensagens')) return bancoMensagens.query(sql, p);
    if (sql.includes('insert into')) { const chave = JSON.stringify(p); if (reservas.has(chave)) return { rows: [] }; reservas.add(chave); return { rows: [{ id: 'r' }] }; }
    if (sql.includes('update ')) return { rows: [] }; throw Error('SQL_FORA_DO_CENARIO');
  });
  const enviarTexto = vi.fn(async () => ({ sucesso: true, mensagemId: 'evolution-pergunta' }));
  const config = { ...carregarConfig({}), envioMedicoRealAtivo: true, envioRealAllowlist: ['11999990000'] };
  const c = new ComunicacaoHomologacao({ query } as any, config, { enviarTexto }, vi.fn());
  const aoEnviar = vi.fn(async () => { expect(enviarTexto).toHaveBeenCalledOnce(); });
  const entrada = { medicoId: 'm', chave: 'lote:l:confirmacao', fala: ['Posso simular essas consultas?'], aoEnviar };
  expect(await c.conversa(entrada)).toBe('enviado'); expect(await c.conversa(entrada)).toBe('repetido');
  expect(aoEnviar).toHaveBeenCalledExactlyOnceWith('evolution-pergunta'); expect(enviarTexto).toHaveBeenCalledOnce();
});
it.each([[false, 'homologacao', ['11999990000']], [true, 'producao', ['11999990000']], [true, 'homologacao', []]] as const)('pergunta do lote não é vinculada quando gate bloqueia: %s/%s', async (ativo, ambiente, allowlist) => {
  const query = vi.fn(async () => ({ rows: [{ telefone: '5511999990000', ambiente }] }));
  const enviarTexto = vi.fn(), aoEnviar = vi.fn();
  const c = new ComunicacaoHomologacao({ query } as any, { ...carregarConfig({}), envioMedicoRealAtivo: ativo, envioRealAllowlist: [...allowlist] }, { enviarTexto }, vi.fn());
  expect(await c.conversa({ medicoId: 'm', chave: 'lote:l:confirmacao', fala: ['Posso simular?'], aoEnviar })).toBe('simulado');
  expect(enviarTexto).not.toHaveBeenCalled(); expect(aoEnviar).not.toHaveBeenCalled();
});
