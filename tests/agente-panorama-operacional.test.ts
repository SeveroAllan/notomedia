import { describe, expect, it, vi } from 'vitest';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import type pg from 'pg';
import { consultarPanoramaFiscalDaConta } from '../src/agente/panorama-operacional.js';
import { responderAgente } from '../src/agente/agente.js';
import { lerEstadoConversa, salvarEstadoConversa } from '../src/agente/estado-conversa.js';

const CONTA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALICE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BRUNO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const linhaAlice = {
  id: ALICE,
  nome_completo: 'Dra. Alice Silva',
  solicitacoes: [{ status: 'pronta', quantidade: 2 }, { status: 'pendente_cadastro', quantidade: 1 }],
  notas: [{ status: 'autorizada', quantidade: 3 }]
};
const dados = {
  ok: true as const,
  janelaDias: 30 as const,
  profissionais: [{ nome: 'Dra. Alice Silva', solicitacoes: [{ status: 'pendente', quantidade: 2 }], notas: [{ status: 'autorizada', quantidade: 3 }] }],
  limite: 'REGISTROS_FISCAIS_DA_BASE' as const
};
const banco = (rows: unknown[] = [linhaAlice]) => {
  const query = vi.fn().mockResolvedValue({ rows });
  return { query, pool: { query } as unknown as pg.Pool };
};

describe('panorama fiscal real e isolado', () => {
  it('consulta apenas registros agregados dos médicos da conta, sem pacientes ou inferência de nota faltante', async () => {
    const b = banco();
    const resultado = await consultarPanoramaFiscalDaConta(b.pool, CONTA, [ALICE]);
    expect(resultado).toMatchObject({
      ok: true, janelaDias: 30,
      profissionais: [{ nome: 'Dra. Alice Silva', notas: [{ status: 'autorizada', quantidade: 3 }] }]
    });
    const [sql, parametros] = b.query.mock.calls[0]!;
    expect(sql).toContain('m.conta_id=$1 and m.id=any($2::uuid[])');
    expect(sql).toContain('public.solicitacoes_nota');
    expect(sql).toContain('public.notas_fiscais');
    expect(sql).toContain("interval '30 days'");
    expect(sql).not.toMatch(/pacientes|cpf|telefone|xml_storage_path|pdf_storage_path/i);
    expect(parametros).toEqual([CONTA, [ALICE]]);
    expect(JSON.stringify(resultado)).not.toContain('Paciente');
  });

  it('nunca consulta dados de uma conta sem profissional confirmado ou com mais de 20 alvos', async () => {
    const b = banco();
    expect(await consultarPanoramaFiscalDaConta(b.pool, CONTA, [])).toEqual({
      ok: false, motivo: 'SEM_PROFISSIONAIS_CONFIRMADOS'
    });
    expect(await consultarPanoramaFiscalDaConta(b.pool, CONTA, Array.from({length:21}, (_,i) => 'id-'+i)))
      .toEqual({ ok: false, motivo: 'ESCOPO_NAO_CONFERIDO' });
    expect(b.query).not.toHaveBeenCalled();
  });

  it('não devolve números parciais quando uma identidade não está dentro do escopo', async () => {
    const b = banco([linhaAlice]);
    expect(await consultarPanoramaFiscalDaConta(b.pool, CONTA, [ALICE, BRUNO]))
      .toEqual({ ok: false, motivo: 'ESCOPO_NAO_CONFERIDO' });
  });

  it('falha de tabela, privilégio ou status inesperado não vira zero documentos', async () => {
    const b = banco();
    b.query.mockRejectedValueOnce(new Error('relation does not exist'));
    expect(await consultarPanoramaFiscalDaConta(b.pool, CONTA, [ALICE]))
      .toEqual({ ok: false, motivo: 'DADOS_FISCAIS_INDISPONIVEIS' });
    b.query.mockResolvedValueOnce({ rows: [{ ...linhaAlice, notas: [{ status: 'NAO_MAPEADO', quantidade: 1 }] }] });
    expect(await consultarPanoramaFiscalDaConta(b.pool, CONTA, [ALICE]))
      .toEqual({ ok: false, motivo: 'DADOS_FISCAIS_INDISPONIVEIS' });
  });

  it('a resposta não copia contagens inventadas pelo modelo', async () => {
    const modelo = new ScriptedModel([
      [functionCall('consultar_panorama_operacional', { profissional: 'Alice' }, {callId:'panorama'})],
      [assistantMessage('Vi 999 notas, todas emitidas.')]
    ]);
    const consulta = vi.fn().mockResolvedValue(dados);
    const foco = vi.fn();
    const resposta = await responderAgente({
      texto: 'Noto, como está a situação fiscal da Alice?',
      profissionais: [{id:ALICE,nome:'Dra. Alice Silva'}]
    }, {
      modeloTeste: modelo,
      consultarStatus: vi.fn(),
      consultarPanorama: consulta,
      aoPanorama: foco
    });
    expect(consulta).toHaveBeenCalledWith([ALICE]);
    expect(foco).toHaveBeenCalledOnce();
    expect(resposta).toContain('3 autorizada');
    expect(resposta).toContain('2 pendente');
    expect(resposta).not.toContain('999');
    expect(resposta).toContain('não mostram, por si só');
    modelo.assertComplete();
  });

  it('modelo não consegue escolher médico de fora nem fabricar zero quando falha o banco', async () => {
    const consulta = vi.fn().mockResolvedValue({ok:false,motivo:'DADOS_FISCAIS_INDISPONIVEIS'});
    const fora = new ScriptedModel([
      [functionCall('consultar_panorama_operacional', { profissional: 'Bruno' }, {callId:'fora'})],
      [assistantMessage('O Bruno tem zero notas.')]
    ]);
    const respFora = await responderAgente({
      texto:'E o Bruno?',profissionais:[{id:ALICE,nome:'Dra. Alice Silva'}]
    }, { modeloTeste:fora,consultarStatus:vi.fn(),consultarPanorama:consulta });
    expect(consulta).not.toHaveBeenCalled();
    expect(respFora).not.toContain('zero notas');
    expect(respFora).toContain('identidade');
    fora.assertComplete();

    const falha = new ScriptedModel([
      [functionCall('consultar_panorama_operacional', {profissional:null}, {callId:'erro'})],
      [assistantMessage('Não há nenhuma nota fiscal.')]
    ]);
    const respFalha = await responderAgente({
      texto:'Como estão as coisas por aqui?',profissionais:[{id:ALICE,nome:'Dra. Alice Silva'}]
    }, {modeloTeste:falha,consultarStatus:vi.fn(),consultarPanorama:consulta});
    expect(respFalha).toContain('Não consegui acessar os registros fiscais');
    expect(respFalha).not.toContain('nenhuma nota fiscal');
    falha.assertComplete();
  });

  it('o foco fiscal confirmado sobrevive à leitura posterior; não guarda contagens ou pacientes', async () => {
    const estado = { ultimaConsultaFiscal: {
      escopo: 'profissional' as const, profissionalNome: 'Dra. Alice Silva', verificadaEm: '2026-11-03T13:00:00.000Z'
    } };
    const b = banco([{estado}]);
    expect(await lerEstadoConversa(b.pool, CONTA)).toMatchObject(estado);
    await salvarEstadoConversa(b.pool, CONTA, estado);
    const [, parametros] = b.query.mock.calls[1]!;
    expect(parametros[0]).toBe(CONTA);
    const persistido = JSON.parse(parametros[1]);
    expect(persistido.ultimaConsultaFiscal).toEqual(estado.ultimaConsultaFiscal);
    expect(JSON.stringify(persistido)).not.toMatch(/paciente|cpf|nota|solicitacoes/i);
  });
});
