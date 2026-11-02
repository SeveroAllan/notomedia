import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { carregarConfig } from '../src/config.js';
import { iniciarWorkerEmbutido } from '../src/worker/iniciar-worker-embutido.js';
import { validarBancoPilotoSomenteLeitura } from '../src/agente/banco-piloto.js';
import { criarAppPilotoLeitura } from '../src/agente/piloto-app.js';
import { validarConfiguracaoPiloto } from '../src/agente/piloto-start.js';
import { ScriptedModel, assistantMessage } from '@openai/agents/testing';

describe('Noto piloto — isolamento da fila e do banco operacional', () => {
  it('worker OFF não consulta nem trava a fila, não conecta o banco e não inicia efeitos', async () => {
    const query = vi.fn(async () => { throw new Error('NENHUM_SQL_PERMITIDO'); });
    const connect = vi.fn(async () => { throw new Error('NENHUMA_CONEXAO_PERMITIDA'); });
    const pool = { query, connect } as unknown as pg.Pool;
    const worker = iniciarWorkerEmbutido(pool, {
      workerEmbutidoAtivo: false,
      agenteFiscalAtivo: true, emissaoComprovanteHomologacaoAtiva: true,
      preparacaoFiscalAtiva: true,
      supabaseUrl: 'https://exemplo.invalid', supabaseServiceRoleKey: 'segredo',
      databaseUrl: 'postgres://nao-conectar'
    } as any);
    await worker.parar();
    await new Promise(r => setTimeout(r, 15));
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('flag só desliga explicitamente; produção atual preserva o comportamento padrão', () => {
    expect(carregarConfig({}).workerEmbutidoAtivo).toBe(true);
    expect(carregarConfig({ NOTO_WORKER_EMBUTIDO_ATIVO: 'false' }).workerEmbutidoAtivo).toBe(false);
    expect(carregarConfig({ NOTO_WORKER_EMBUTIDO_ATIVO: 'FALSE' }).workerEmbutidoAtivo).toBe(true);
  });

  it('preflight aceita somente role read-only sem permissões excessivas', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{
      somente_leitura: 'on', superusuario: false, ignora_rls: false,
      cria_roles: false, cria_bancos: false, replica: false
    }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{
      existe_usuarios: true, existe_medicos: true, le_usuarios: true, le_medicos: true
    }] });
    await expect(validarBancoPilotoSomenteLeitura({ query } as unknown as pg.Pool)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('preflight rejeita sessão com escrita, role privilegiada ou grants em outras tabelas', async () => {
    for (const resposta of [
      [{ rows: [{ somente_leitura: 'off' }] }],
      [{ rows: [{ somente_leitura: 'on', superusuario: true }] }],
      [{ rows: [{ somente_leitura: 'on', superusuario: false, ignora_rls: false, cria_roles: false, cria_bancos: false, replica: false }] },
       { rows: [{ esquema: 'public', objeto: 'solicitacoes_nota' }] }]
    ]) {
      const query = vi.fn();
      for (const x of resposta) query.mockResolvedValueOnce(x);
      await expect(validarBancoPilotoSomenteLeitura({ query } as unknown as pg.Pool))
        .rejects.toThrow(/PILOTO_/);
    }
  });

  it('startup rejeita DSN compartilhado ou allowlist múltipla antes de abrir qualquer conexão', () => {
    const env = {
      ENVIO_REAL_ALLOWLIST: '5511999990000',
      NOTO_AGENT_PILOTO_DATABASE_URL: 'postgres://piloto-readonly@db.invalid:5432/base',
      NOTO_AGENT_ATIVO: 'true', NOTO_AGENT_ENVIO_ATIVO: 'true',
      EVOLUTION_ASSISTANT_URL: 'https://evolution.invalid',
      EVOLUTION_ASSISTANT_GLOBAL_API_KEY: 'chave-propria',
      EVOLUTION_ASSISTANT_WEBHOOK_SECRET: 'segredo-unico',
      EVOLUTION_ASSISTANT_INSTANCE_NAME: 'notomed_assistente_teste',
      OPENAI_API_KEY: 'chave-ia-ficticia'
    };
    expect(validarConfiguracaoPiloto(env)).toMatchObject({ telefone: '5511999990000' });
    expect(() => validarConfiguracaoPiloto({ ...env, ENVIO_REAL_ALLOWLIST: '5511999990000,5521999990000' })).toThrow('PILOTO_EXIGE_UM_DESTINATARIO');
    expect(() => validarConfiguracaoPiloto({ ...env, DATABASE_URL: env.NOTO_AGENT_PILOTO_DATABASE_URL })).toThrow('PILOTO_EXIGE_DSN_READONLY_SEPARADO');
    expect(() => validarConfiguracaoPiloto({ ...env, EVOLUTION_ASSISTANT_WEBHOOK_SECRET: '' })).toThrow('PILOTO_INTEGRACOES_NAO_ISOLADAS');
  });

  it('app isolado rejeita OTP, cadastro, emissão, certificado e conexão WhatsApp sem tocar no banco', async () => {
    const query = vi.fn();
    const enviar = vi.fn();
    const app = criarAppPilotoLeitura({
      pool: { query } as unknown as pg.Pool,
      segredo: 'segredo-isolado',
      instancia: 'assistente_teste',
      telefoneAutorizado: '5511999990000',
      consultarStatus: vi.fn(),
      enviar,
      modeloTeste: new ScriptedModel([])
    });
    const server = createServer(app);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    try {
      expect((await (await fetch(origin + '/health')).json()).modo).toBe('agente_piloto_leitura');
      const rotas = [
        '/api/auth/otp/solicitar', '/api/auth/otp/verificar',
        '/api/onboarding/whatsapp/iniciar', '/api/onboarding/certificado',
        '/api/conta/cadastro', '/api/v1/nfse', '/v2/nfse',
        '/api/conta/cofre/tribemd', '/c/token'
      ];
      for (const path of rotas) {
        const r = await fetch(origin + path, { method: 'POST' });
        expect(r.status).toBe(404);
        expect(await r.json()).toMatchObject({ codigo: 'PILOTO_ROTA_NAO_DISPONIVEL' });
      }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    expect(query).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
  });

  it('webhook do piloto resolve apenas conta real e profissional autorizado por SELECT', async () => {
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      expect(/^\s*select\b/i.test(sql)).toBe(true);
      if (sql.includes('distinct conta_id')) {
        expect(sql).toContain('auth_user_id is not null');
        expect(params).toHaveLength(1);
        return { rows: [{ conta_id: 'conta-real-a' }] };
      }
      if (sql.includes('from medicos')) {
        expect(params).toEqual(['conta-real-a']);
        return { rows: [{ id: 'medico-real-a', nome_completo: 'Profissional Teste' }] };
      }
      throw new Error('SQL_FORA_DA_ALLOWLIST');
    });
    const enviar = vi.fn().mockResolvedValue(true);
    const model = new ScriptedModel([[assistantMessage('Olá! Qual agenda você utiliza?')]]);
    const app = criarAppPilotoLeitura({
      pool: { query } as unknown as pg.Pool, segredo: 'segredo-unico',
      instancia: 'assistente_teste', telefoneAutorizado: '5511999990000',
      consultarStatus: vi.fn(), enviar, modeloTeste: model
    });
    const server = createServer(app);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    try {
      const evento = { instance: 'assistente_teste', event: 'messages.upsert',
        data: { key: { id: 'e1', fromMe: false, remoteJid: '5511999990000@s.whatsapp.net' },
          message: { conversation: 'Oi Noto' } } };
      const resp = await fetch(origin + '/webhook/evolution', {
        method: 'POST', headers: { 'x-webhook-secret': 'segredo-unico', 'content-type': 'application/json' },
        body: JSON.stringify(evento)
      });
      expect(resp.status).toBe(200);
      expect(query).toHaveBeenCalledTimes(2);
      expect(enviar.mock.calls).toEqual([['5511999990000', 'Olá!'], ['5511999990000', 'Qual agenda você utiliza?']]);
      model.assertComplete();
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
