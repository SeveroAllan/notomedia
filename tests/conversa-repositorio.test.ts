import type pg from 'pg';
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PostgresMemoriaConversaMedico } from '../src/onboarding/conversa-repositorio.js';
import { BancoConversaFalso } from './fakes/banco-conversa.js';

it('persiste só texto sanitizado, deduplica e recupera quatro textos em ordem após reinício', async () => {
  const banco = new BancoConversaFalso();
  const repo = new PostgresMemoriaConversaMedico(banco as unknown as pg.Pool);
  const textos = ['início', 'CPF 529.982.247-25', 'telefone +55 (11) 99999-0000', 'medico@example.invalid', 'token=segredo-ficticio'];
  for (const [id, texto] of textos.entries()) await repo.registrar('medico', 'conversa', String(id), texto);
  await repo.registrar('medico', 'conversa', '4', 'não sobrescrever');
  await repo.registrar('outro', 'conversa', '4', 'outro médico');
  await repo.registrar('medico', 'outra', '4', 'outra conversa', 'noto');
  expect(banco.mensagens).toHaveLength(7);
  expect(banco.mensagens.at(-1)?.papel).toBe('noto');
  expect(await new PostgresMemoriaConversaMedico(banco as unknown as pg.Pool).ler('medico', 'conversa'))
    .toEqual(['CPF [OCULTO]', 'telefone [OCULTO]', '[OCULTO]', '[OCULTO]']);
  const gravado = JSON.stringify(banco.consultas);
  for (const segredo of ['529.982.247-25', '99999-0000', 'medico@example.invalid', 'segredo-ficticio']) expect(gravado).not.toContain(segredo);
});

it('lê antigas fora da janela e guarda resumo sanitizado com marcador monotônico', async () => {
  const banco = new BancoConversaFalso(); const repo = new PostgresMemoriaConversaMedico(banco as unknown as pg.Pool);
  expect(await repo.lerResumo('medico', 'conversa')).toBeNull();
  for (let id = 1; id <= 25; id++) await repo.registrar('medico', 'conversa', String(id), `texto ${id}`);
  expect(await repo.lerAntigas('medico', 'conversa', '0')).toHaveLength(21);
  await repo.gravarResumo('medico', 'conversa', 'contato medico@example.invalid', '21');
  await repo.gravarResumo('medico', 'conversa', 'resumo atrasado', '10');
  expect(await repo.lerResumo('medico', 'conversa')).toEqual({ resumo: 'contato [OCULTO]', ateId: '21' });
  expect(await repo.lerAntigas('medico', 'conversa', '21')).toEqual([]);
});

it('migration é idempotente e define os tipos, unicidade e índice pedidos, sem executá-la', () => {
  const sql = readFileSync('scripts/migrations/20261020-conversa-mensagens.sql', 'utf8');
  expect(sql).toContain('create table if not exists conversa_mensagens');
  expect(sql).toContain('create table if not exists conversa_resumos');
  expect(sql).toContain('medico_id uuid not null');
  expect(sql).toContain("check (papel in ('medico', 'noto'))");
  expect(sql).toContain('unique (medico_id, conversa, mensagem_id)');
  expect(sql).toContain('(medico_id, conversa, id desc)');
});
