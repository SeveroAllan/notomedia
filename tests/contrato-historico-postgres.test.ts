import { config } from '../src/config.js';
import { auditarComprovante } from '../src/atendimento/comprovante.js';
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { BancoHistoricoFalso } from './fakes/banco-historico.js';
import { PostgresHistoricoComunicacao } from '../src/io/postgres/postgres-historico-comunicacao.js';
import { HistoricoComunicacaoEmMemoria, type HistoricoComunicacaoRepositorio } from '../src/onboarding/historico-comunicacao-repositorio.js';
import { processarComprovante } from '../src/fluxos/processar-comprovante.js';
import { orquestrarComunicacao } from '../src/onboarding/orquestrar-comunicacao.js';
import type { EstadoPedidoComprovante, ResultadoExtracaoComprovante } from '../src/atendimento/comprovante.js';

const medico = '00000000-0000-4000-8000-000000000001', instante = '2026-10-18T12:00:00.000Z';
const estado: EstadoPedidoComprovante = { medicoId: medico, paciente: { nome: 'Paciente Ficticio', cpf: '52998224725' }, ultimaConsulta: { valorConsultaCentavos: 35000 } };
const lido: ResultadoExtracaoComprovante = { tipo: 'extraido', campos: { valorCentavos: 35000, dataPagamento: '2026-10-18', nomePagador: 'Paciente Ficticio', nomeFavorecido: 'Medica Ficticia',
  confianca: { valorCentavos: 0.90, dataPagamento: 0.90, nomePagador: 0.90, nomeFavorecido: 0.90 } } };
function criar(tipo: 'memoria' | 'postgres') {
  const banco = new BancoHistoricoFalso(); let falha: 'leitura' | 'gravacao' | null = null;
  class MemoriaComFalha extends HistoricoComunicacaoEmMemoria {
    override async ler(...args: Parameters<HistoricoComunicacaoRepositorio['ler']>) { if (falha === 'leitura') throw new Error('LEITURA_FALHOU'); return super.ler(...args); }
    override async registrarComprovante(...args: Parameters<HistoricoComunicacaoRepositorio['registrarComprovante']>) {
      if (falha) throw new Error('FRONTEIRA_MEMORIA_FALHOU'); return super.registrarComprovante(...args);
    }
    override async gravarAcao(...args: Parameters<HistoricoComunicacaoRepositorio['gravarAcao']>) { if (falha === 'gravacao') throw new Error('GRAVACAO_FALHOU'); return super.gravarAcao(...args); }
  }
  const historico: HistoricoComunicacaoRepositorio = tipo === 'memoria' ? new MemoriaComFalha() : new PostgresHistoricoComunicacao(banco as unknown as pg.Pool);
  return { historico, banco, falhar: (valor: 'leitura' | 'gravacao' | null) => { falha = valor;
    banco.falhar = valor === 'leitura' ? /^select (\*|lido,|chave_processamento)/ : valor === 'gravacao' ? /^(update|insert into public.noto_(auditoria_comprovantes|comunicacao_(reservas|envios)))/ : null; } };
}
for (const tipo of ['memoria', 'postgres'] as const) describe('contrato do histórico: ' + tipo, () => {
  it('reserva, consome chave, grava datas, resposta e separa modo/médico', async () => {
    const { historico: h } = criar(tipo);
    expect(await h.reservar(medico, 'simulado', 'primeira')).toBe(true);
    expect(await h.reservar(medico, 'simulado', 'outra')).toBe(false);
    await h.gravarAcao(medico, 'simulado', 'primeira', { tipo: 'boas_vindas', ultimaNota: null }, instante);
    await h.liberar(medico, 'simulado', 'primeira');
    expect(await h.reservar(medico, 'simulado', 'primeira')).toBe(false);
    await h.gravarResposta(medico, 'simulado', { temNota: false, desde: null }, instante);
    const salvo = await h.ler(medico, 'simulado');
    expect(salvo.boasVindasEm).toBe(instante); expect(salvo.perguntaNota.resposta).toEqual({ temNota: false, desde: null });
    expect(salvo.registros).toEqual([{ modo: 'simulado', chaveProcessamento: 'primeira', tipo: 'boas_vindas', quando: instante }]);
    expect((await h.ler(medico, 'real')).boasVindasComunicadas).toBe(false);
    expect((await h.ler('00000000-0000-4000-8000-000000000002', 'simulado')).boasVindasComunicadas).toBe(false);
    salvo.registros.length = 0; expect((await h.ler(medico, 'simulado')).registros).toHaveLength(1);
  });
  it('mantém exclusividade após gravar a ação até liberar explicitamente', async () => {
    const { historico: h } = criar(tipo);
    await h.reservar(medico, 'simulado', 'primeira');
    await h.gravarAcao(medico, 'simulado', 'primeira', { tipo: 'boas_vindas', ultimaNota: null }, instante);
    expect(await h.reservar(medico, 'simulado', 'segunda')).toBe(false);
    await h.liberar(medico, 'simulado', 'primeira');
    expect(await h.reservar(medico, 'simulado', 'segunda')).toBe(true);
  });
  it('confirma balões ordenados sem transporte e só depois grava enviado', async () => {
    const { historico: h } = criar(tipo); const acao = { tipo: 'boas_vindas' as const, ultimaNota: null };
    await h.reservar(medico, 'real', 'envio'); expect(await h.reservarEnvio(medico, 'envio', acao)).toBe(true);
    await expect(h.confirmarBalao(medico, 'envio', 1)).rejects.toThrow();
    await h.confirmarBalao(medico, 'envio', 0); await h.confirmarBalao(medico, 'envio', 1);
    expect((await h.ler(medico, 'real')).envios[0].baloesEnviados).toEqual([0, 1]);
    expect((await h.ler(medico, 'real')).boasVindasComunicadas).toBe(false);
    await h.gravarAcao(medico, 'real', 'envio', acao, instante); await h.liberar(medico, 'real', 'envio');
    expect((await h.ler(medico, 'real')).registros[0].estado).toBe('enviado');
    await h.reservar(medico, 'real', 'outro'); expect(await h.reservarEnvio(medico, 'outro', acao)).toBe(false);
  });
  it('audita, isola médicos e deduplica duas execuções simultâneas', async () => {
    const { historico: h } = criar(tipo);
    const resultados = await Promise.all([h.registrarComprovante(estado, lido), h.registrarComprovante(estado, lido)]);
    expect(resultados.map(r => r.tipo)).toEqual(['pedido_nota_pronto', 'nenhuma']);
    expect(await h.lerComprovantes(medico)).toEqual(resultados.map(decisao => auditarComprovante(config.appPepper, estado, lido, decisao)));
    const copias = await h.lerComprovantes(medico); const hash = copias[0].estado.pacienteHash; copias[0].estado.pacienteHash = 'alterado';
    expect((await h.lerComprovantes(medico))[0].estado.pacienteHash).toBe(hash);
    expect(JSON.stringify(await h.lerComprovantes(medico))).not.toContain('52998224725');
    expect((await h.registrarComprovante({ ...estado, medicoId: '00000000-0000-4000-8000-000000000002' }, lido)).tipo).toBe('pedido_nota_pronto');
  });
  it.each(['leitura', 'gravacao'] as const)('falha de %s não devolve pedido nem intenção seca', async falha => {
    const c = criar(tipo); c.falhar(falha); const logs: string[] = [];
    const resultado = await processarComprovante({ key: { id: 'mensagem-ficticia', remoteJid: '5511999990000@s.whatsapp.net', fromMe: false } }, estado,
      { historico: c.historico, extrator: { extrair: async () => lido }, log: (_nivel, texto) => logs.push(texto) });
    expect(resultado).toEqual({ tipo: 'nenhuma', motivo: 'AUDITORIA_FALHOU' });
    expect(logs).toEqual(['AUDITORIA_COMPROVANTE_FALHOU']); c.falhar(null);
    expect(await c.historico.lerComprovantes(medico)).toEqual([]);
  });
  it.each(['leitura', 'gravacao'] as const)('falha de %s da comunicação não gera ação de envio', async falha => {
    const c = criar(tipo); c.falhar(falha); const logs: string[] = [];
    const resultado = await orquestrarComunicacao({ medicoId: medico, chaveProcessamento: 'evento', estado: {
      fiscal: { certificado: 'ok', dadosFiscais: 'ok' }, agenda: { nome: null, conectada: false }, ultimaNota: null, agora: new Date(instante)
    } }, { historico: c.historico, log: (_nivel, texto) => logs.push(texto) });
    expect(resultado).toEqual({ tipo: 'nenhuma' }); expect(logs.every(log => !log.startsWith('enviaria'))).toBe(true);
    expect(logs).toContain('HISTORICO_COMUNICACAO_FALHOU');
  });
});
it('Postgres recupera histórico e auditoria em outra instância, sem memória compartilhada', async () => {
  const c = criar('postgres'); await c.historico.registrarComprovante(estado, lido);
  const outro = new PostgresHistoricoComunicacao(c.banco as unknown as pg.Pool);
  expect((await outro.registrarComprovante(estado, lido)).tipo).toBe('nenhuma');
  expect(c.banco.consultas).toContain('select pg_advisory_xact_lock(hashtextextended($1, 0))');
  expect(c.banco.consultas.every(sql => !/^(create|alter|drop|truncate)/.test(sql))).toBe(true);
});

it('Postgres preserva reserva anterior sem snapshot até a liberação explícita', async () => {
  const c = criar('postgres');
  await c.historico.reservar(medico, 'simulado', 'anterior');
  c.banco.reservas.clear(); // Reserva ausente, mantendo a tentativa SQL reservada para o mesmo caso de contrato.
  await c.historico.gravarAcao(medico, 'simulado', 'anterior', { tipo: 'boas_vindas', ultimaNota: null }, instante);
  expect(await c.historico.reservar(medico, 'simulado', 'nova')).toBe(false);
  await c.historico.liberar(medico, 'simulado', 'anterior');
  expect(await c.historico.reservar(medico, 'simulado', 'nova')).toBe(true);
});
