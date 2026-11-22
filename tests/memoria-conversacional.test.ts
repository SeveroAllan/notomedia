import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import type pg from 'pg';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import { sanitizarTextoParaMemoria } from '../src/agente/memoria/sanitizar-memoria.js';
import {
  formatarResumosLongoPrazo,
  formatarTurnosCurtoPrazo,
  selecionarMensagensParaCompactar
} from '../src/agente/memoria/regras-compactacao.js';
import { criarServicoMemoriaConversa } from '../src/agente/memoria/gerenciar-memoria-conversa.js';
import type {
  MemoriaConversaRepositorio,
  MensagemMemoria,
  ResumoMemoria
} from '../src/agente/memoria/memoria-repositorio.js';
import { responderAgente } from '../src/agente/agente.js';
import { criarRouterWebhookAgente } from '../src/agente/webhook.js';

function criarRepositorioMemoriaFalso(): MemoriaConversaRepositorio & {
  mensagens: Array<MensagemMemoria & { compactadaEm: string | null }>;
  resumos: ResumoMemoria[];
} {
  let seq = 1;
  const mensagens: Array<MensagemMemoria & { compactadaEm: string | null }> = [];
  const resumos: ResumoMemoria[] = [];

  return {
    mensagens,
    resumos,
    async registrarMensagem(entrada) {
      mensagens.push({
        id: `msg-${seq++}`,
        contaId: entrada.contaId,
        autor: entrada.autor,
        texto: entrada.texto,
        diaReferencia: entrada.diaReferencia,
        criadoEm: `${entrada.diaReferencia}T12:${String(seq).padStart(2, '0')}:00.000Z`,
        compactadaEm: null
      });
    },
    async listarNaoCompactadas(contaId, limite) {
      return mensagens
        .filter(m => m.contaId === contaId && m.compactadaEm === null)
        .slice(0, limite);
    },
    async listarRecentesDoDiaOuJanela(contaId, diaAtual, limite) {
      return mensagens
        .filter(m => m.contaId === contaId && (m.diaReferencia === diaAtual || m.compactadaEm === null))
        .slice(-limite);
    },
    async salvarResumoEMarcarCompactadas(entrada) {
      const ids = new Set(entrada.mensagemIds);
      for (const m of mensagens) {
        if (m.contaId === entrada.contaId && ids.has(m.id)) {
          m.compactadaEm = new Date().toISOString();
        }
      }
      const resumo: ResumoMemoria = {
        id: `res-${seq++}`,
        contaId: entrada.contaId,
        periodoInicio: entrada.periodoInicio,
        periodoFim: entrada.periodoFim,
        resumo: entrada.resumo,
        fatosCombinados: entrada.fatosCombinados,
        totalMensagens: entrada.mensagemIds.length,
        criadoEm: new Date().toISOString()
      };
      resumos.push(resumo);
      return resumo;
    },
    async listarResumosRecentes(contaId, limite) {
      return resumos.filter(r => r.contaId === contaId).slice(-limite);
    },
    async buscar(entrada) {
      const termo = entrada.termo?.toLowerCase().trim() ?? '';
      const resumosEncontrados = resumos
        .filter(r => r.contaId === entrada.contaId)
        .filter(r => !termo || r.resumo.toLowerCase().includes(termo) || r.fatosCombinados.some(f => f.toLowerCase().includes(termo)))
        .map(r => ({
          periodo: r.periodoInicio === r.periodoFim ? r.periodoInicio : `${r.periodoInicio} a ${r.periodoFim}`,
          resumo: r.resumo,
          fatosCombinados: r.fatosCombinados
        }));
      const mensagensEncontradas = mensagens
        .filter(m => m.contaId === entrada.contaId)
        .filter(m => !termo || m.texto.toLowerCase().includes(termo))
        .filter(m => !entrada.dataInicio || m.diaReferencia >= entrada.dataInicio)
        .filter(m => !entrada.dataFim || m.diaReferencia <= entrada.dataFim)
        .map(m => ({ dia: m.diaReferencia, autor: m.autor, texto: m.texto }));
      return { resumosEncontrados, mensagensEncontradas };
    }
  };
}

describe('memória conversacional em duas camadas (curto prazo do dia + longo prazo compactado)', () => {
  it('sanitiza links do cofre, CPFs e bloqueia credenciais antes de salvar na memória', () => {
    expect(
      sanitizarTextoParaMemoria('Abra https://app.noto.test/c/UVkLdCdOT15lGPywzscFvbP_lbnLwXDCd1YKDPHxlAY para conectar')
    ).toBe('Abra [link seguro do cofre] para conectar');

    expect(
      sanitizarTextoParaMemoria('CPF do paciente é 123.456.789-01 e outro 98765432100')
    ).toBe('CPF do paciente é [CPF oculto] e outro [documento oculto]');

    expect(sanitizarTextoParaMemoria('minha senha é segredo123')).toBeNull();
    expect(sanitizarTextoParaMemoria('Com comprovante e pode emitir direto')).toBe('Com comprovante e pode emitir direto');
  });

  it('compacta automaticamente conversas de dias anteriores em resumo de longo prazo e mantém o dia atual aberto', async () => {
    const repo = criarRepositorioMemoriaFalso();
    const compactador = {
      compactar: vi.fn().mockResolvedValue({
        resumo: 'No dia 19/11 o médico combinou emitir somente com comprovante e pediu para aguardar o certificado A1.',
        fatosCombinados: ['Emitir apenas com comprovante de pagamento', 'Certificado A1 ficou para enviar quando chegar em casa']
      })
    };
    const memoria = criarServicoMemoriaConversa({ repositorio: repo, compactador });

    const ontem = new Date('2026-11-19T15:00:00-03:00');
    await memoria.registrarMensagem('conta-1', 'medico', 'Quero emitir só com comprovante', ontem);
    await memoria.registrarMensagem('conta-1', 'noto', 'Combinado! Quando chegar comprovante eu preparo.', ontem);

    const hoje = new Date('2026-11-20T10:00:00-03:00');
    await memoria.registrarMensagem('conta-1', 'medico', 'Bom dia, cheguei em casa com o certificado', hoje);

    const contexto = await memoria.carregarContexto('conta-1', hoje);
    expect(compactador.compactar).toHaveBeenCalledTimes(1);
    expect(contexto.resumosLongoPrazo).toHaveLength(1);
    expect(contexto.resumosLongoPrazo[0]?.periodo).toBe('2026-11-19');
    expect(contexto.resumosLongoPrazo[0]?.resumo).toContain('somente com comprovante');
    expect(contexto.turnosCurtoPrazo).toEqual([
      'Médico: Bom dia, cheguei em casa com o certificado'
    ]);
  });

  it('seleciona excesso de mensagens do mesmo dia para compactar quando ultrapassa o gatilho', () => {
    const msgs: MensagemMemoria[] = Array.from({ length: 34 }, (_, i) => ({
      id: `m-${i}`,
      contaId: 'conta-1',
      autor: i % 2 === 0 ? 'medico' : 'noto',
      texto: `Mensagem ${i}`,
      diaReferencia: '2026-11-20',
      criadoEm: `2026-11-20T10:${String(i).padStart(2, '0')}:00.000Z`
    }));
    const lote = selecionarMensagensParaCompactar(msgs, '2026-11-20');
    expect(lote).not.toBeNull();
    expect(lote!.mensagens).toHaveLength(20);
    expect(formatarTurnosCurtoPrazo(msgs.slice(-2))).toHaveLength(2);
    expect(formatarResumosLongoPrazo([])).toEqual([]);
  });

  it('permite ao agente cruzar ferramenta operacional + busca na memória para explicar o que não foi pedido', async () => {
    const repo = criarRepositorioMemoriaFalso();
    const memoria = criarServicoMemoriaConversa({ repositorio: repo });
    await memoria.registrarMensagem('conta-1', 'medico', 'Falamos só da paciente Maria ontem', new Date('2026-11-18T14:00:00-03:00'));

    const buscarMemoriaConversa = vi.fn(entrada => memoria.buscar({ contaId: 'conta-1', ...entrada }));
    const modelo = new ScriptedModel([
      [functionCall('buscar_memoria_conversa', { termo: 'João', dataInicio: '2026-11-18', dataFim: '2026-11-18' }, { callId: 'mem-1' })],
      [assistantMessage('Olhando nas nossas conversas do dia 18, você não chegou a me pedir a nota do João. Quer que eu prepare agora?')]
    ]);

    const resposta = await responderAgente(
      {
        texto: 'A nota do dia 18 pro João foi enviada?',
        profissionais: [{ id: 'm1', nome: 'Alice Xavier' }],
        memoriaLongoPrazo: [{
          periodo: '2026-11-18',
          resumo: 'Médico tirou dúvidas sobre a paciente Maria.',
          fatosCombinados: ['Apenas paciente Maria mencionada']
        }]
      },
      {
        modeloTeste: modelo,
        consultarStatus: vi.fn().mockResolvedValue({ tribemd: { salvo: true, conectada: true }, amplimed: { salvo: false, conectada: false } }),
        onboardingAutonomo: { buscarMemoriaConversa }
      }
    );

    expect(buscarMemoriaConversa).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(modelo.calls[0]?.request.input)).toContain('memoriaConversacionalLongoPrazo');
    expect(resposta).toContain('não chegou a me pedir');
    modelo.assertComplete();
  });

  it('sobrevive a reinício do servidor preservando a conversa do dia no webhook durável', async () => {
    const repo = criarRepositorioMemoriaFalso();
    const memoria = criarServicoMemoriaConversa({ repositorio: repo });
    const reservadas = new Set<string>();
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('from usuarios where ativo=true')) return { rows: [{ conta_id: 'conta-1' }] };
      if (sql.includes('from medicos where conta_id=$1')) return { rows: [{ id: 'm1', nome_completo: 'Alice Xavier' }] };
      if (sql.includes('from noto_agent_conversas')) return { rows: [{ estado: {} }] };
      if (sql.startsWith('insert into noto_agent_mensagens')) {
        const id = String(params?.[2] ?? '');
        if (reservadas.has(id)) return { rows: [] };
        reservadas.add(id);
        return { rows: [{ mensagem_id: id }] };
      }
      return { rows: [], rowCount: 1 };
    });

    const montarApp = (modeloTeste: ScriptedModel) => {
      const app = express();
      app.use(express.json());
      app.use('/webhook', criarRouterWebhookAgente({
        pool: { query } as unknown as pg.Pool,
        ativo: true,
        envioAtivo: true,
        segredo: 'segredo-teste',
        instancia: 'instancia_teste_noto',
        allowlist: ['5551999990001'],
        persistirConversa: true,
        memoriaConversa: memoria,
        modeloTeste,
        consultarStatus: vi.fn().mockResolvedValue({ tribemd: { salvo: true, conectada: true }, amplimed: { salvo: false, conectada: false } }),
        enviar: vi.fn().mockResolvedValue(true)
      }));
      return app;
    };

    const enviarWebhook = async (app: express.Express, id: string, texto: string) => {
      const server = await new Promise<import('node:http').Server>(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      try {
        const porta = (server.address() as import('node:net').AddressInfo).port;
        return await fetch(`http://127.0.0.1:${porta}/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-webhook-secret': 'segredo-teste' },
          body: JSON.stringify({
            instance: 'instancia_teste_noto',
            event: 'MESSAGES_UPSERT',
            data: { key: { id, remoteJid: '555199990001@s.whatsapp.net', fromMe: false }, message: { conversation: texto } }
          })
        });
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    };

    // Instância 1 do servidor
    const m1 = new ScriptedModel([[assistantMessage('Combinado, só com comprovante! Posso emitir direto?')]]);
    expect((await enviarWebhook(montarApp(m1), 'M-1', 'Só com comprovante')).status).toBe(200);
    m1.assertComplete();

    // Instância 2 (simulando restart completo do servidor com RAM zerada!)
    const m2 = new ScriptedModel([[assistantMessage('Beleza, emito direto então!')]]);
    expect((await enviarWebhook(montarApp(m2), 'M-2', 'Pode ser direto')).status).toBe(200);
    const inputAposRestart = JSON.stringify(m2.calls[0]?.request.input ?? '');
    expect(inputAposRestart).toContain('Só com comprovante');
    expect(inputAposRestart).toContain('Posso emitir direto?');
    m2.assertComplete();
  });
});
