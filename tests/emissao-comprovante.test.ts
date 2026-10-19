import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { auditarComprovante, decidirPedidoComprovante, type ResultadoExtracaoComprovante } from '../src/atendimento/comprovante.js';
import { BancoEmissaoComprovante } from './fakes/banco-emissao-comprovante.js';

const lido: ResultadoExtracaoComprovante = { tipo: 'extraido', campos: { valorCentavos: 20000, dataPagamento: '2026-10-19', nomePagador: 'Responsavel', nomeFavorecido: 'Medico', confianca: { valorCentavos: 1, dataPagamento: 1, nomePagador: 1, nomeFavorecido: 1 } } };
function entrada(banco: BancoEmissaoComprovante, leitura = lido, consulta = { fonte: 'agenda', idExterno: 'consulta', dataHora: '2026-10-18T10:00:00Z', valorConsultaCentavos: 20000 }) {
  const estado = { medicoId: 'medico', paciente: { nome: 'Ana', cpf: '52998224725' }, ultimaConsulta: { valorConsultaCentavos: consulta.valorConsultaCentavos }, consulta };
  const decisao = decidirPedidoComprovante(leitura, estado, []);
  banco.auditorias.push({ id: `auditoria-${banco.auditorias.length}`, medico_id: 'medico', ...auditarComprovante('pepper-teste', estado, leitura, decisao) });
  return { medicoId: 'medico', pacienteId: 'paciente', lido: leitura, decisao, consulta };
}
async function adaptador(banco: BancoEmissaoComprovante) {
  const caminho = '../src/io/postgres/postgres-emissao-comprovante.js';
  const { PostgresEmissaoComprovante } = await import(caminho);
  return new PostgresEmissaoComprovante(banco.pool, 'chave-teste', 'pepper-teste');
}
describe('emissão por comprovante no PostgreSQL', () => {
  it('enfileira paciente existente, valor auditado, descrição fiscal e observação em uma transação', async () => {
    const banco = new BancoEmissaoComprovante(); const pedido = entrada(banco);
    expect(await (await adaptador(banco)).enfileirar(pedido)).toEqual({ tipo: 'enfileirada', solicitacaoId: 'solicitacao-0' });
    expect(banco.solicitacoes).toEqual([expect.objectContaining({ paciente_id: 'paciente', valor: 20000, origem: 'whatsapp', descricao: expect.stringContaining('Responsavel') })]);
    expect(banco.solicitacoes[0].descricao).toContain('REFERENTE A CONSULTAS');
    expect(banco.emissoes[0]).toMatchObject({ auditoria_comprovante_id: 'auditoria-0', consulta_chave: createHmac('sha256', 'pepper-teste').update(JSON.stringify(['medico', 'agenda', 'consulta'])).digest('hex'), estado: 'enfileirada', solicitacao_id: 'solicitacao-0', comprovante_chave: createHmac('sha256', 'pepper-teste').update(JSON.stringify([20000, '2026-10-19', 'Responsavel'])).digest('hex') });
    expect(banco.comandos.filter(c => c === 'begin')).toHaveLength(1);
    expect(banco.comandos.some(c => c.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(banco.comandos.at(-1)).toBe('commit');
  });
  it.each(['producao', null])('bloqueia ambiente %s sem solicitação', async ambiente => {
    const banco = new BancoEmissaoComprovante(); banco.ambiente = ambiente;
    expect(await (await adaptador(banco)).enfileirar(entrada(banco))).toMatchObject({ tipo: 'perguntar_medico' });
    expect(banco.solicitacoes).toHaveLength(0); expect(banco.emissoes[0]).toMatchObject({ estado: 'bloqueada', erro_codigo: 'AMBIENTE_NAO_HOMOLOGACAO' });
  });
  it('não age sem decisão pronta ou duplicação recuperável', async () => {
    const banco = new BancoEmissaoComprovante();
    expect(await (await adaptador(banco)).enfileirar({ ...entrada(banco), decisao: { tipo: 'nenhuma', motivo: 'AUDITORIA_FALHOU' } })).toEqual({ tipo: 'nenhuma' });
    expect(banco.comandos).toHaveLength(0);
  });
  it('recupera auditoria pronta anterior após interrupção antes de enfileirar', async () => {
    const banco = new BancoEmissaoComprovante(); const pedido = entrada(banco);
    expect(await (await adaptador(banco)).enfileirar({ ...pedido, decisao: { tipo: 'nenhuma', motivo: 'COMPROVANTE_JA_PROCESSADO' } })).toMatchObject({ tipo: 'enfileirada' });
    expect(banco.solicitacoes).toHaveLength(1);
  });
  it('recusa comprovante sem auditoria pronta persistida', async () => {
    const banco = new BancoEmissaoComprovante(); const pedido = entrada(banco); banco.auditorias = [];
    expect(await (await adaptador(banco)).enfileirar(pedido)).toMatchObject({ tipo: 'perguntar_medico' }); expect(banco.solicitacoes).toHaveLength(0);
  });
  it.each(['paciente', 'valor', 'perfil', 'cpf'])('revalida %s atual sem criar fila', async caso => {
    const banco = new BancoEmissaoComprovante(); const pedido = entrada(banco);
    if (caso === 'paciente') pedido.pacienteId = 'outro';
    if (caso === 'valor') pedido.consulta.valorConsultaCentavos = 30000;
    if (caso === 'perfil') banco.perfilCompleto = false;
    if (caso === 'cpf') banco.paciente.cpf = '11111111111';
    expect(await (await adaptador(banco)).enfileirar(pedido)).toMatchObject({ tipo: 'perguntar_medico' }); expect(banco.solicitacoes).toHaveLength(0);
  });
  it.each([/from public\.noto_auditoria_comprovantes/, /^insert into solicitacoes_nota/, /^update public\.noto_emissoes_comprovantes/])('falha atômica em %s não deixa reserva ou solicitação', async falhar => {
    const banco = new BancoEmissaoComprovante(); banco.falhar = falhar;
    const resultado = await (await adaptador(banco)).enfileirar(entrada(banco));
    expect(resultado).toMatchObject({ tipo: 'perguntar_medico' }); expect(JSON.stringify(resultado)).not.toContain('DADO_PRIVADO');
    expect(banco.emissoes).toHaveLength(0); expect(banco.solicitacoes).toHaveLength(0); expect(banco.comandos.at(-1)).toBe('rollback');
  });
  it.each([false, true])('concorrência de comprovantes diferentes=%s da mesma consulta gera uma solicitação', async diferente => {
    const banco = new BancoEmissaoComprovante(); const primeiro = entrada(banco);
    const segundoLido = structuredClone(lido); if (diferente && segundoLido.tipo === 'extraido') segundoLido.campos.dataPagamento = '2026-10-20';
    const segundo = entrada(banco, segundoLido); const repo = await adaptador(banco);
    const resultados = await Promise.all([repo.enfileirar(primeiro), repo.enfileirar(segundo)]);
    expect(resultados.filter(r => r.tipo === 'enfileirada')).toHaveLength(1); expect(banco.solicitacoes).toHaveLength(1); expect(banco.emissoes).toHaveLength(1);
  });
  it('mesmo comprovante nunca enfileira outra consulta posterior', async () => {
    const banco = new BancoEmissaoComprovante(); const pedido = entrada(banco); const repo = await adaptador(banco);
    await repo.enfileirar(pedido); const posterior = entrada(banco, lido, { ...pedido.consulta, idExterno: 'posterior', dataHora: '2026-10-19T10:00:00Z' });
    expect(await repo.enfileirar(posterior)).toEqual({ tipo: 'nenhuma' }); expect(banco.solicitacoes).toHaveLength(1);
  });
  it('migração proposta protege vínculos, unicidades, estados e acesso sem dados pessoais', () => {
    const sql = readFileSync('scripts/migrations/20261019-emissao-comprovante.sql', 'utf8').toLowerCase();
    expect(sql).toContain('create table if not exists public.noto_emissoes_comprovantes');
    expect(sql).toContain('unique (medico_id, comprovante_chave)'); expect(sql).toContain('unique (medico_id, fonte, consulta_id_externo)');
    expect(sql).toContain('references public.noto_consultas_sincronizadas'); expect(sql).toContain('references public.noto_auditoria_comprovantes');
    expect(sql).toContain('enable row level security'); expect(sql).toContain('revoke all'); expect(sql).not.toMatch(/create policy|cpf|senha/);
  });
});
