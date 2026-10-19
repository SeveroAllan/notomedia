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
