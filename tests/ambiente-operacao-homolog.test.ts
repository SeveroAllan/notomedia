import { expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { EnviarMensagemPacienteParams } from '../src/whatsapp/enviar-mensagem-paciente.js';
import { carregarConfig } from '../src/config.js';
import { ComunicacaoHomologacao } from '../src/whatsapp/comunicacao-homologacao.js';
import { ambienteEfetivoConversa, operacaoHomologacaoExplicita, telefoneNaAllowlist } from '../src/whatsapp/ambiente-operacao-homolog.js';

it('ambiente de operação nasce desconfigurado e o perfil fiscal continua sendo a fonte', () => {
  expect(carregarConfig({}).ambienteOperacao).toBeUndefined();
  expect(operacaoHomologacaoExplicita(carregarConfig({}))).toBe(false);
  expect(ambienteEfetivoConversa(carregarConfig({}), null, '5511999990000')).toBeNull();
  expect(ambienteEfetivoConversa({ ambienteOperacao: 'homologacao', envioMedicoRealAtivo: true, envioRealAllowlist: ['11999990000'] }, 'producao', '5511999990000')).toBe('producao');
  expect(ambienteEfetivoConversa({ ambienteOperacao: 'homologacao', envioMedicoRealAtivo: true, envioRealAllowlist: ['11999990000'] }, 'homologacao', '5511999990000')).toBe('homologacao');
});

it.each([
  ['sem NOTO_AMBIENTE_OPERACAO', { envioMedicoRealAtivo: true, envioRealAllowlist: ['11999990000'] }, '5511999990000'],
  ['operação não homolog', { ambienteOperacao: 'producao', envioMedicoRealAtivo: true, envioRealAllowlist: ['11999990000'] }, '5511999990000'],
  ['envio real desligado', { ambienteOperacao: 'homologacao', envioMedicoRealAtivo: false, envioRealAllowlist: ['11999990000'] }, '5511999990000'],
  ['telefone fora da allowlist', { ambienteOperacao: 'homologacao', envioMedicoRealAtivo: true, envioRealAllowlist: ['11988880000'] }, '5511999990000'],
  ['allowlist vazia', { ambienteOperacao: 'homologacao', envioMedicoRealAtivo: true, envioRealAllowlist: [] as string[] }, '5511999990000'],
  ['telefone ausente', { ambienteOperacao: 'homologacao', envioMedicoRealAtivo: true, envioRealAllowlist: ['11999990000'] }, undefined],
])('médico sem perfil fiscal NÃO habilita: %s', (_rotulo, config, telefone) => {
  expect(ambienteEfetivoConversa(config, null, telefone)).toBeNull();
});

it('médico sem perfil fiscal habilita só com operação homolog explícita + envio real + allowlist', () => {
  const config = { ambienteOperacao: 'homologacao', envioMedicoRealAtivo: true, envioRealAllowlist: ['11999990000', '+5551993527271'] };
  expect(ambienteEfetivoConversa(config, null, '5511999990000')).toBe('homologacao');
  expect(ambienteEfetivoConversa(config, null, '+55 51 99352-7271')).toBe('homologacao');
  expect(telefoneNaAllowlist(config, '11999990001')).toBe(false);
});

function cenarioConversa(ambiente: string | null, configExtra: Record<string, unknown>) {
  const reservas = new Set<string>(), mensagens: string[] = [];
  const query = vi.fn(async (sql: string, p: unknown[] = []) => {
    if (sql.includes('from medicos m')) return { rows: [{ telefone: '5511999990000', ambiente }] };
    if (sql.includes('insert into public.noto_envios_homologacao')) {
      const chave = JSON.stringify(p); if (reservas.has(chave)) return { rows: [] };
      reservas.add(chave); return { rows: [{ id: 'r' }] };
    }
    if (sql.startsWith('update public.noto_envios_homologacao')) return { rows: [] };
    if (sql.startsWith('insert into conversa_mensagens')) { mensagens.push(String(p[3])); return { rows: [{ id: 1 }] }; }
    throw Error('SQL_NAO_MODELADO');
  });
  const enviarTexto = vi.fn(async (_p: EnviarMensagemPacienteParams) => ({ sucesso: true }));
  const config = { ...carregarConfig({}), envioMedicoRealAtivo: true, envioRealAllowlist: ['11999990000'], ...configExtra };
  const c = new ComunicacaoHomologacao({ query } as unknown as pg.Pool, config, { enviarTexto }, vi.fn());
  return { c, enviarTexto };
}

it('conversa responde a médico sem perfil fiscal em operação homolog explícita (escopo allowlist)', async () => {
  const { c, enviarTexto } = cenarioConversa(null, { ambienteOperacao: 'homologacao' });
  expect(await c.conversa({ medicoId: 'm', chave: 'oi-1', fala: ['Oi! Vamos configurar.'] })).toBe('enviado');
  expect(enviarTexto).toHaveBeenCalledTimes(1);
  expect(enviarTexto.mock.calls[0][0]).toMatchObject({ contatoTelefone: '5511999990000', texto: 'Oi! Vamos configurar.' });
});

it('conversa continua silenciada sem a configuração explícita da operação homolog', async () => {
  const { c, enviarTexto } = cenarioConversa(null, {});
  expect(await c.conversa({ medicoId: 'm', chave: 'oi-2', fala: ['Oi!'] })).toBe('simulado');
  expect(enviarTexto).not.toHaveBeenCalled();
});

it('conversa simulada quando ambiente do perfil é producao mesmo com operação homolog', async () => {
  const { c, enviarTexto } = cenarioConversa('producao', { ambienteOperacao: 'homologacao' });
  expect(await c.conversa({ medicoId: 'm', chave: 'oi-3', fala: ['Oi!'] })).toBe('simulado');
  expect(enviarTexto).not.toHaveBeenCalled();
});
