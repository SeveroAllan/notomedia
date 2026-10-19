import { expect, it } from 'vitest';
import type pg from 'pg';
import { createHmac, createHash } from 'node:crypto';
import { BancoHistoricoFalso } from './fakes/banco-historico.js';
import { PostgresHistoricoComunicacao } from '../src/io/postgres/postgres-historico-comunicacao.js';
import { HistoricoComunicacaoEmMemoria } from '../src/onboarding/historico-comunicacao-repositorio.js';
import { auditarComprovante, chaveConsulta, chaveComprovante } from '../src/atendimento/comprovante.js';

const pepper = 'pepper-ficticio-de-testes';
const estado = { medicoId: 'm', paciente: { nome: 'Ana Ficticia', cpf: '52998224725' }, ultimaConsulta: { valorConsultaCentavos: 20000 }, consulta: { fonte: 'agenda', idExterno: 'externo-123', dataHora: '2026-10-18', valorConsultaCentavos: 20000 } };
const lido = { tipo: 'extraido' as const, campos: { valorCentavos: 20000, dataPagamento: '2026-10-19', nomePagador: 'Pagador Ficticio', nomeFavorecido: 'Medica Ficticia', confianca: { valorCentavos: 1, dataPagamento: 1, nomePagador: 1, nomeFavorecido: 1 } } };

it('HMAC-SHA256 usa pepper e identidade exata da consulta, sem PII nas chaves', () => {
  expect(chaveConsulta(pepper, 'm', 'agenda', 'externo-123')).toBe(createHmac('sha256', pepper).update(JSON.stringify(['m', 'agenda', 'externo-123'])).digest('hex'));
  const chave = chaveComprovante(pepper, lido);
  expect(chave).toMatch(/^[a-f0-9]{64}$/);
  expect(chave).not.toBe(createHash('sha256').update(JSON.stringify([20000, '2026-10-19', 'Pagador Ficticio'])).digest('hex'));
  expect(chave).not.toBe(chaveComprovante('outro-pepper', lido));
});
it.each(['memoria', 'postgres'])('auditoria %s não guarda nomes, CPF, telefone nem identificador externo e mantém deduplicação concorrente', async modo => {
  const banco = new BancoHistoricoFalso();
  const h = modo === 'postgres' ? new PostgresHistoricoComunicacao(banco as unknown as pg.Pool, pepper) : new HistoricoComunicacaoEmMemoria(undefined, pepper);
  const resultados = await Promise.all([h.registrarComprovante(estado, lido), h.registrarComprovante(estado, lido)]);
  expect(resultados.map(r => r.tipo)).toEqual(['pedido_nota_pronto', 'nenhuma']);
  expect(resultados[0]).toHaveProperty('pedido.paciente.cpf', '52998224725');
  const registros = await h.lerComprovantes('m');
  const gravado = JSON.stringify(modo === 'postgres' ? banco.comprovantes : registros);
  for (const proibido of ['Ana Ficticia', '52998224725', 'Pagador Ficticio', 'Medica Ficticia', 'externo-123', 'telefonePaciente']) expect(gravado).not.toContain(proibido);
  expect(registros[0]).toEqual(auditarComprovante(pepper, estado, lido, resultados[0]));
  expect(registros[0].lido).toHaveProperty('campos.comprovanteHash', chaveComprovante(pepper, lido));
  expect(registros[0].decisao).not.toHaveProperty('pedido');
});
