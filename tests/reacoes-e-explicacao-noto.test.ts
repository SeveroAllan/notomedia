import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type pg from 'pg';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import { reacaoContextual } from '../src/agente/baloes.js';
import { INSTRUCOES_NOTO } from '../src/agente/instrucoes.js';
import { EvolutionApiClient } from '../src/io/evolution/evolution-api-client.js';
import { criarRouterWebhookAgente } from '../src/agente/webhook.js';

describe('reações seletivas humanas, visualizado e conhecimento do funcionamento do Noto', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reage apenas a intenções claras no modo seletivo, sem poluir conversa comum', () => {
    expect(reacaoContextual('Comigo', { seletiva: true })).toBeNull();
    expect(reacaoContextual('Pode ser direto', { seletiva: true })).toBeNull();
    expect(reacaoContextual('Como assim você pedir?', { seletiva: true })).toBeNull();
    expect(reacaoContextual('Com comprovante', { seletiva: true })).toBeNull();

    expect(reacaoContextual('Consegue verificar minha agenda?', { seletiva: true })).toBe('🔎');
    expect(reacaoContextual('Corrige essa preferência pra mim', { seletiva: true })).toBe('✍️');
    expect(reacaoContextual('Olha essa nota que estou te enviando', { seletiva: true })).toBe('👀');
    expect(reacaoContextual('', { tipoMidia: 'audio', seletiva: true })).toBe('👂');
    expect(reacaoContextual('Vê isso aqui', { tipoMidia: 'imagem', seletiva: true })).toBe('👀');
    expect(reacaoContextual('Muito obrigado!', { seletiva: true })).toBe('❤️');
  });

  it('permite reagir em JID @lid da Evolution v2 com ✍️ e 👂', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new EvolutionApiClient('https://evolution.invalid', 'api-key', 'otp', 'otp');
    const chaveLid = { id: '3EB0746DD0E4CEAF2312B6', remoteJid: '100000000000001@lid', fromMe: false };

    expect(await client.reagirMensagem('instancia_teste_noto', chaveLid, '✍️')).toBe(true);
    expect(await client.reagirMensagem('instancia_teste_noto', chaveLid, '👂')).toBe(true);
    expect(await client.reagirMensagem('instancia_teste_noto', chaveLid, '✅')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('marca como visualizada e conclui pedido de alteração/consulta com ✅ na mesma mensagem', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('from usuarios where ativo=true')) return { rows: [{ conta_id: 'conta-1' }] };
      if (sql.includes('from medicos where conta_id=$1')) return { rows: [{ id: 'm1', nome_completo: 'Alice Xavier' }] };
      return { rows: [] };
    });
    const marcarLida = vi.fn().mockResolvedValue(true);
    const reagir = vi.fn().mockResolvedValue(true);
    const enviar = vi.fn().mockResolvedValue(true);
    const salvarPreferenciasEmissao = vi.fn().mockResolvedValue({
      emitirApenasComComprovante: true,
      revisaoDiariaAgenda: false,
      enviarNotaParaPaciente: false,
      pedirAprovacaoAntesDeEmitir: true,
      solicitarCpfDiretoPaciente: false
    });

    const modelo = new ScriptedModel([
      [functionCall('salvar_preferencias_emissao', { pedirAprovacaoAntesDeEmitir: true }, { callId: 'pref-corr' })],
      [assistantMessage('Anotado, mudei aqui para sempre te pedir um ok antes de emitir.')]
    ]);

    const app = express();
    app.use(express.json());
    app.use('/webhook', criarRouterWebhookAgente({
      pool: { query } as unknown as pg.Pool,
      ativo: true,
      envioAtivo: true,
      segredo: 'segredo-teste',
      instancia: 'instancia_teste_noto',
      allowlist: ['5551999990001'],
      reacoesSeletivas: true,
      marcarLida,
      reagir,
      enviar,
      modeloTeste: modelo,
      consultarStatus: vi.fn().mockResolvedValue({ tribemd: { salvo: true, conectada: true }, amplimed: { salvo: false, conectada: false } }),
      onboardingAutonomo: () => ({ salvarPreferenciasEmissao })
    }));

    const server = await new Promise<import('node:http').Server>(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const porta = (server.address() as import('node:net').AddressInfo).port;
      const key = { id: 'MSG-CORRIGIR-1', remoteJid: '100000000000001@lid', remoteJidAlt: '555199990001@s.whatsapp.net', fromMe: false };
      const resp = await fetch(`http://127.0.0.1:${porta}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': 'segredo-teste' },
        body: JSON.stringify({
          instance: 'instancia_teste_noto',
          event: 'MESSAGES_UPSERT',
          data: { key, message: { conversation: 'Corrige minhas preferências para sempre pedir aprovação antes' } }
        })
      });
      expect(resp.status).toBe(200);
      expect(marcarLida).toHaveBeenCalledOnce();
      expect(reagir.mock.calls.map(c => c[1])).toEqual(['✍️', '✅']);
      expect(reagir.mock.calls[1]?.[0]).toMatchObject({ id: 'MSG-CORRIGIR-1', remoteJid: '100000000000001@lid' });
      modelo.assertComplete();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('carrega como-noto-funciona.md nas instruções do agente como base factual concisa do produto', () => {
    expect(INSTRUCOES_NOTO).toContain('# Como o Noto funciona por dentro');
    expect(INSTRUCOES_NOTO).toContain('como se fosse o próprio médico/secretária');
    expect(INSTRUCOES_NOTO).toContain('não de um número desconhecido');
  });
});
