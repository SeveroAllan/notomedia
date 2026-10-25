import type pg from 'pg';
import { expect, it } from 'vitest';
import { PostgresMemoriaConversaMedico } from '../src/onboarding/memoria-conversa.js';
import { PostgresMemoriaConversaMedico as Compatibilidade } from '../src/onboarding/conversa-repositorio.js';
import { BancoConversaFalso } from './fakes/banco-conversa.js';

it('contrato reúne histórico, marcas e resumo sem tratar contexto como fala', async () => {
  const banco = new BancoConversaFalso(); const memoria = new PostgresMemoriaConversaMedico(banco as unknown as pg.Pool);
  await memoria.registrarFala('m', 'c', 'medico:1', 'CPF 529.982.247-25');
  await memoria.registrarFala('m', 'outra-variante', 'noto:agenda:link:1:0', 'Use o link seguro: https://exemplo.invalid/c/[LINK_SEGURO]', 'noto');
  await memoria.registrarMarca('m', 'c', 'sem_agenda_digital');
  await memoria.registrarResumo('m', 'c', 'Paciente informado; CPF 529.982.247-25', '2');
  expect(await memoria.lerContextoParaModelo('m', 'c')).toEqual({
    historicoRecente: ['CPF [OCULTO]', 'Use o link seguro: https://exemplo.invalid/c/[LINK_SEGURO]'],
    marcas: { semAgendaDigital: true, linkAgendaSolicitado: false, boasVindasComunicadas: false },
    resumo: { resumo: 'Paciente informado; CPF [OCULTO]', ateId: '2' },
    entregasRecentes: []
  });
  expect(await memoria.lerUltimaFalaNoto('m', 'c')).toBe('Use o link seguro: https://exemplo.invalid/c/[LINK_SEGURO]');
});
it('preserva os quatro textos cronológicos, ids, dedup e marcador monotônico do resumo', async () => {
  const banco = new BancoConversaFalso(); const memoria = new PostgresMemoriaConversaMedico(banco as unknown as pg.Pool);
  for (let i = 1; i <= 6; i++) await memoria.registrarFala('m', 'c', `medico:${i}`, `Fala ${i}`);
  expect(await memoria.registrarFala('m', 'outra', 'medico:6', 'Não substituir')).toBe(false);
  await memoria.registrarMarca('m', 'c', 'sem_agenda_digital');
  await memoria.registrarMarca('m', 'c', 'sem_agenda_digital');
  await memoria.registrarResumo('m', 'c', 'Resumo atual', '4');
  await memoria.registrarResumo('m', 'c', 'Resumo atrasado', '2');
  const contexto = await memoria.lerContextoParaModelo('m', 'c');
  expect(contexto.historicoRecente).toEqual(['Fala 3', 'Fala 4', 'Fala 5', 'Fala 6']);
  expect(contexto.resumo).toEqual({ resumo: 'Resumo atual', ateId: '4' });
  expect(banco.mensagens.filter(m => m.mensagemId === 'contexto:sem_agenda_digital')).toHaveLength(1);
  expect(Compatibilidade).toBe(PostgresMemoriaConversaMedico);
});
it('limparTudo remove mensagens, marcas e resumos de todas as conversas em uma instrução e isola outro médico', async () => {
  const banco = new BancoConversaFalso(); const memoria = new PostgresMemoriaConversaMedico(banco as unknown as pg.Pool);
  for (const medico of ['m', 'outro']) for (const conversa of ['c', 'variante']) {
    await memoria.registrarFala(medico, conversa, `medico:${conversa}`, 'Mensagem anterior');
    await memoria.registrarMarca(medico, conversa, 'sem_agenda_digital');
    await memoria.registrarResumo(medico, conversa, 'Resumo anterior', '2');
  }
  await memoria.registrarMarca('m', 'c', 'link_agenda_solicitado');
  const antes = banco.consultas.length;
  await memoria.limparTudoDoMedico('m');
  const comandos = banco.consultas.slice(antes);
  expect(comandos).toHaveLength(1); expect(comandos[0].parametros).toEqual(['m']);
  expect(comandos[0].sql).toContain('delete from conversa_mensagens where medico_id=$1');
  expect(comandos[0].sql).toContain('delete from conversa_resumos where medico_id=$1');
  const reiniciada = new PostgresMemoriaConversaMedico(banco as unknown as pg.Pool);
  for (const conversa of ['c', 'variante']) expect(await reiniciada.lerContextoParaModelo('m', conversa)).toEqual({
    historicoRecente: [], marcas: { semAgendaDigital: false, linkAgendaSolicitado: false, boasVindasComunicadas: false }, resumo: null, entregasRecentes: []
  });
  expect((await reiniciada.lerContextoParaModelo('outro', 'c')).resumo?.resumo).toBe('Resumo anterior');
  expect((await reiniciada.lerContextoParaModelo('outro', 'c')).marcas.semAgendaDigital).toBe(true);
  expect(await reiniciada.registrarFala('m', 'c', 'medico:c', 'Novo ciclo')).toBe(true);
  expect((await reiniciada.lerContextoParaModelo('m', 'c')).historicoRecente).toEqual(['Novo ciclo']);
  expect((await reiniciada.lerContextoParaModelo('m', 'c')).resumo).toBeNull();
});
it('entrega de nota vira contexto estruturado e nunca fala do histórico', async () => {
  const banco = new BancoConversaFalso(); const memoria = new PostgresMemoriaConversaMedico(banco as unknown as pg.Pool);
  await memoria.registrarEntregaNota('m','c','nota-1',{notaFiscalId:'nf-1',solicitacaoId:'sol-1',ndps:42,paciente:'Paciente Teste',datasConsulta:'20/10/2026',valorCentavos:25000,destino:'medico',origem:'pedido_historico',resultado:'enviado',registradaEm:'2026-10-25T09:00:00.000Z'});
  const contexto=await memoria.lerContextoParaModelo('m','c');
  expect(contexto.historicoRecente).toEqual([]);
  expect(contexto.entregasRecentes).toEqual([expect.objectContaining({notaFiscalId:'nf-1',ndps:42,paciente:'Paciente Teste',datasConsulta:'20/10/2026',valorCentavos:25000,destino:'medico',origem:'pedido_historico',resultado:'enviado'})]);
  expect(banco.mensagens.find(m=>m.mensagemId.startsWith('contexto:entrega_nota:'))?.papel).toBe('noto');
});

it('documenta a exceção legada da marca de pedido de link sem alterar a leitura atual', async () => {
  const banco = new BancoConversaFalso(); const memoria = new PostgresMemoriaConversaMedico(banco as unknown as pg.Pool);
  await memoria.registrarMarca('m', 'c', 'link_agenda_solicitado');
  const contexto = await memoria.lerContextoParaModelo('m', 'c');
  expect(contexto.marcas.linkAgendaSolicitado).toBe(true);
  expect(contexto.historicoRecente).toEqual(await memoria.ler('m', 'c'));
  expect(contexto.historicoRecente).toEqual(['O link seguro já foi solicitado nesta conversa; aguardo a conexão. Isso não confirma envio.']);
});
