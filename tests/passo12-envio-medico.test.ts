import { createHmac } from 'node:crypto';
import { montarBoasVindas } from '../src/onboarding/regras/decidir-proxima-acao.js';
import { expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { EnviarMensagemPacienteParams } from '../src/whatsapp/enviar-mensagem-paciente.js';
import { carregarConfig } from '../src/config.js';
import { ComunicacaoHomologacao } from '../src/whatsapp/comunicacao-homologacao.js';

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
  const inserts = query.mock.calls.filter(([sql]) => sql.includes('insert into'));
  expect(inserts).toHaveLength(3);
  expect(inserts[0][1]).toEqual(['m', 'conversa_livre', expect.stringMatching(/^[a-f0-9]{64}$/)]);
  const banco = JSON.stringify(query.mock.calls);
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
  expect(query.mock.calls.find(([sql]) => sql.includes('insert into'))?.[1]).toEqual(['m', 'boas_vindas', hash]);
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
    expect(enviarTexto.mock.calls[0]).toEqual([{ instanciaNome: carregarConfig({}).evolutionAssistantInstanceName, contatoTelefone: '+5551993527271', texto: 'Não encontrei um certificado digital ativo; cadastre um certificado válido antes de pedir uma nova tentativa. Não vou tentar emitir novamente sozinho.' }]);
    expect(await c.medico(entrada)).toBe('repetido'); expect(enviarTexto).toHaveBeenCalledOnce();
  } else expect(enviarTexto).not.toHaveBeenCalled();
});
