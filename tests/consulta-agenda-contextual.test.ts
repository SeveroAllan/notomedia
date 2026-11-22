import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import type pg from 'pg';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import {
  calcularJanelaDiasConsulta,
  filtrarEOrdenarAtendimentos,
  formatarResumoAssincronoAgenda
} from '../src/agenda/filtrar-atendimentos-agenda.js';
import { criarConsultorAgendaConta } from '../src/agenda/consultar-agenda-conta.js';
import { responderAgente, respostaCompativelComFerramentas } from '../src/agente/agente.js';
import { criarRouterWebhookAgente } from '../src/agente/webhook.js';
import { reacaoContextual } from '../src/agente/baloes.js';

describe('consulta contextual de atendimentos na agenda (sem regex rígido de data)', () => {
  it('filtra, ordena pelo mais recente e calcula janela de dias corretamente', () => {
    expect(calcularJanelaDiasConsulta('2026-11-01', '2026-11-20')).toBe(20);
    expect(calcularJanelaDiasConsulta('2026-11-19', '2026-11-20')).toBe(7);
    expect(calcularJanelaDiasConsulta('2026-01-01', '2026-11-20')).toBe(90);

    const resumo = filtrarEOrdenarAtendimentos([
      { data: '2026-10-29', paciente: 'Pedro Outubro', profissional: 'Alice Xavier', situacao: 'finalizado' },
      { data: '2026-11-05', paciente: 'Ana Costa', profissional: 'Alice Xavier', situacao: 'finalizado' },
      { data: '2026-11-18', paciente: 'Maria Silva', profissional: 'Alice Xavier', situacao: 'finalizado' }
    ], {
      dataInicio: '2026-11-01',
      dataFim: '2026-11-20'
    });

    expect(resumo.totalEncontrados).toBe(2);
    expect(resumo.ultimoAtendimento?.paciente).toBe('Maria Silva');
    expect(resumo.ultimoAtendimento?.data).toBe('2026-11-18');
    expect(formatarResumoAssincronoAgenda('TribeMD', resumo)).toContain('Maria Silva (18/11/2026)');
    expect(formatarResumoAssincronoAgenda('TribeMD', resumo)).toContain('Ana Costa (05/11/2026)');
  });

  it('usa cache curto em memória e responde assincronamente quando a leitura demora mais que o limite síncrono', async () => {
    const lerTribemdRapido = vi.fn().mockResolvedValue({
      ok: true as const,
      consultas: [{ data: '2026-11-18', paciente: 'Maria Silva', profissional: 'Alice Xavier', situacao: 'finalizado' }]
    });
    const consultor = criarConsultorAgendaConta({
      obterAgendaConectada: async () => ({ conectada: true, provedor: 'tribemd', nomeAgenda: 'TribeMD' }),
      lerTribemdRapido,
      esperaSincronaMs: 500
    });

    const r1 = await consultor({
      contaId: 'conta-1',
      filtro: { dataInicio: '2026-11-01', dataFim: '2026-11-20' },
      agora: new Date('2026-11-20T15:00:00Z')
    });
    expect(r1.ok && !r1.emAndamento && r1.resumo.ultimoAtendimento?.paciente).toBe('Maria Silva');

    const r2 = await consultor({
      contaId: 'conta-1',
      filtro: { dataInicio: '2026-11-10', dataFim: '2026-11-20' },
      agora: new Date('2026-11-20T15:01:00Z')
    });
    expect(r2.ok && !r2.emAndamento && r2.resumo.ultimoAtendimento?.paciente).toBe('Maria Silva');
    expect(lerTribemdRapido).toHaveBeenCalledTimes(1);

    // Simula leitura lenta em segundo plano que estouraria o timeout da IA.
    let resolverLeitura!: (valor: { ok: true; consultas: Array<{ data: string; paciente: string }> }) => void;
    const consultorLento = criarConsultorAgendaConta({
      obterAgendaConectada: async () => ({ conectada: true, provedor: 'tribemd', nomeAgenda: 'TribeMD' }),
      lerTribemdRapido: () => new Promise(resolve => { resolverLeitura = resolve; }),
      esperaSincronaMs: 25
    });
    const aoConcluirAssincrono = vi.fn().mockResolvedValue(undefined);
    const emAndamento = await consultorLento({
      contaId: 'conta-2',
      filtro: { dataInicio: '2026-11-01', dataFim: '2026-11-20' },
      agora: new Date('2026-11-20T15:00:00Z'),
      aoConcluirAssincrono
    });
    expect(emAndamento).toEqual({
      ok: true,
      emAndamento: true,
      agenda: 'TribeMD',
      periodo: { inicio: '2026-11-01', fim: '2026-11-20' }
    });

    resolverLeitura({ ok: true, consultas: [{ data: '2026-11-19', paciente: 'Carlos Lima' }] });
    await vi.waitFor(() => expect(aoConcluirAssincrono).toHaveBeenCalledTimes(1));
    expect(aoConcluirAssincrono.mock.calls[0]?.[0]).toContain('Carlos Lima em 19/11/2026');
    expect(aoConcluirAssincrono.mock.calls[0]?.[1]).toBe(true);
  });

  it('injeta referenciaTemporal no turno do agente e permite narrar atendimento encontrado na agenda', async () => {
    expect(respostaCompativelComFerramentas(
      'Encontrei o último atendimento de novembro na agenda: Maria Silva em 18/11.',
      [{ nome: 'consultar_agenda_atendimentos', codigo: 'AGENDA_ATENDIMENTOS_CONSULTADOS', duracaoMs: 120 }]
    )).toBe(true);

    const consultarAgenda = vi.fn().mockResolvedValue({
      ok: true as const,
      emAndamento: false as const,
      agenda: 'TribeMD',
      resumo: {
        periodo: { inicio: '2026-11-01', fim: '2026-11-20' },
        totalEncontrados: 1,
        ultimoAtendimento: { data: '2026-11-18', paciente: 'Maria Silva', profissional: 'Alice Xavier', situacao: 'finalizado' },
        atendimentos: [{ data: '2026-11-18', paciente: 'Maria Silva', profissional: 'Alice Xavier', situacao: 'finalizado' }]
      }
    });
    const modelo = new ScriptedModel([
      [functionCall('consultar_agenda_atendimentos', { dataInicio: '2026-11-01', dataFim: '2026-11-20' }, { callId: 'ag-1' })],
      [assistantMessage('Encontrei o último atendimento de novembro na agenda: Maria Silva no dia 18/11.')]
    ]);

    const resposta = await responderAgente({
      texto: 'Tá, poderia ver qual foi o último atendimento do mês de novembro?',
      profissionais: [{ id: 'med-1', nome: 'Alice Xavier' }]
    }, {
      modeloTeste: modelo,
      consultarStatus: async () => ({
        tribemd: { salvo: true, conectada: true },
        amplimed: { salvo: false, conectada: false }
      }),
      onboardingAutonomo: {
        consultarAgendaAtendimentos: consultarAgenda
      }
    });

    expect(consultarAgenda).toHaveBeenCalledWith({
      dataInicio: '2026-11-01',
      dataFim: '2026-11-20',
      filtroPaciente: undefined,
      filtroProfissional: undefined
    });
    expect(resposta).toContain('Maria Silva');
    expect(JSON.stringify(modelo.calls[0]?.request.input)).toContain('referenciaTemporal');
    expect(JSON.stringify(modelo.calls[0]?.request.input)).toContain('diaSemana');
    modelo.assertComplete();
  });

  it('no webhook com autonomia ativa não força regex de período e evolui reação 🔎 -> ✅', async () => {
    expect(reacaoContextual('Tá, poderia ver qual foi o último atendimento do mês de novembro?', { seletiva: true })).toBe('🔎');

    const enviadas: string[] = [];
    const reacoes: string[] = [];
    const poolFalso = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('from usuarios')) return { rows: [{ conta_id: 'conta-ctx-1' }] };
        if (sql.includes('from medicos')) return { rows: [{ id: 'med-1', nome_completo: 'Alice Xavier' }] };
        if (sql.includes('from noto_agent_conversas')) return { rows: [{ estado: { perguntaPendente: 'periodo' } }] };
        if (sql.includes('insert into noto_agent_mensagens')) return { rows: [{ mensagem_id: 'm1' }] };
        return { rows: [] };
      })
    } as unknown as pg.Pool;

    const modelo = new ScriptedModel([
      [functionCall('consultar_agenda_atendimentos', { dataInicio: '2026-11-01', dataFim: '2026-11-20' }, { callId: 'ag-2' })],
      [assistantMessage('O último atendimento de novembro foi Maria Silva no dia 18/11.')]
    ]);

    const app = express();
    app.use(express.json());
    app.use('/webhook', criarRouterWebhookAgente({
      pool: poolFalso,
      ativo: true,
      envioAtivo: true,
      segredo: 'segredo-teste',
      instancia: 'instancia_teste_noto',
      allowlist: ['555199990001'],
      modeloTeste: modelo,
      persistirConversa: true,
      reacoesSeletivas: true,
      consultarStatus: async () => ({
        tribemd: { salvo: true, conectada: true },
        amplimed: { salvo: false, conectada: false }
      }),
      enviar: async (_tel, txt) => { enviadas.push(txt); return true; },
      reagir: async (_chave, emoji) => { reacoes.push(emoji); return true; },
      onboardingAutonomo: () => ({
        consultarAgendaAtendimentos: async () => ({
          ok: true,
          emAndamento: false,
          agenda: 'TribeMD',
          resumo: {
            periodo: { inicio: '2026-11-01', fim: '2026-11-20' },
            totalEncontrados: 1,
            ultimoAtendimento: { data: '2026-11-18', paciente: 'Maria Silva', profissional: 'Alice Xavier', situacao: 'finalizado' },
            atendimentos: [{ data: '2026-11-18', paciente: 'Maria Silva', profissional: 'Alice Xavier', situacao: 'finalizado' }]
          }
        })
      })
    }));

    const server = app.listen(0);
    const { port } = server.address() as { port: number };
    try {
      const r = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': 'segredo-teste' },
        body: JSON.stringify({
          instance: 'instancia_teste_noto',
          event: 'messages.upsert',
          data: {
            key: { id: 'msg-nov-1', remoteJid: '555199990001@s.whatsapp.net', fromMe: false },
            message: { conversation: 'Tá, poderia ver qual foi o último atendimento do mês de novembro?' }
          }
        })
      });
      expect(r.status).toBe(200);
      expect(enviadas.join(' ')).toContain('Maria Silva');
      expect(enviadas.join(' ')).not.toContain('incluindo o ano');
      expect(reacoes).toEqual(['🔎', '✅']);
    } finally {
      server.close();
    }
  });
});
