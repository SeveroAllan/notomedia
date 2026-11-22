import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import type pg from 'pg';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import {
  avaliarPreferenciasEmissao,
  mesclarPreferenciasEmissao,
  PREFERENCIAS_EMISSAO_VAZIAS,
  reconciliarPreferenciasComFalaDoMedico,
  type PreferenciasEmissaoConta
} from '../src/conta/preferencias-emissao.js';
import { decidirProximoPassoOnboarding } from '../src/agente/estado-prontidao-conta.js';
import {
  notificarCertificadoSalvoEProximoPasso,
  notificarXmlSalvoEProximoPasso,
  type PortaEnvioOrquestracao
} from '../src/agente/orquestrar-pos-cofre.js';
import { responderAgente } from '../src/agente/agente.js';
import { criarRouterWebhookAgente } from '../src/agente/webhook.js';

const vazio = { tribemd: { salvo: false, conectada: false }, amplimed: { salvo: false, conectada: false } };

describe('preferências conversacionais de emissão (estilo secretária humana)', () => {
  it('infere rotina diária pelo contexto (comprovante vs. pós-consulta) sem perguntas redundantes', () => {
    const soComprovante = mesclarPreferenciasEmissao(PREFERENCIAS_EMISSAO_VAZIAS, {
      emitirApenasComComprovante: true,
      enviarNotaParaPaciente: true,
      revisaoDiariaAgenda: null
    });
    expect(soComprovante).toEqual({
      emitirApenasComComprovante: true,
      revisaoDiariaAgenda: false,
      enviarNotaParaPaciente: true,
      pedirAprovacaoAntesDeEmitir: null,
      solicitarCpfDiretoPaciente: null
    });

    const resumo1 = avaliarPreferenciasEmissao(soComprovante);
    expect(resumo1.completas).toBe(false);
    expect(resumo1.pendentes).toEqual([
      'pedirAprovacaoAntesDeEmitir',
      'solicitarCpfDiretoPaciente'
    ]);
    expect(resumo1.proximoAssunto?.chave).toBe('pedirAprovacaoAntesDeEmitir');
    expect(resumo1.comoFuncionaNaPratica).toContain('comprovante');

    const posConsulta = mesclarPreferenciasEmissao(PREFERENCIAS_EMISSAO_VAZIAS, {
      emitirApenasComComprovante: false
    });
    expect(posConsulta.revisaoDiariaAgenda).toBe(true);
    expect(avaliarPreferenciasEmissao(posConsulta).comoFuncionaNaPratica).toContain('finalizadas');

    const passo2 = mesclarPreferenciasEmissao(soComprovante, {
      revisaoDiariaAgenda: true,
      pedirAprovacaoAntesDeEmitir: false,
      solicitarCpfDiretoPaciente: false
    });
    const resumo2 = avaliarPreferenciasEmissao(passo2);
    expect(resumo2.completas).toBe(true);
    expect(resumo2.valores.revisaoDiariaAgenda).toBe(true);
    expect(resumo2.pendentes).toEqual([]);
    expect(resumo2.proximoAssunto).toBeNull();
    expect(resumo2.resumoCombinado).toHaveLength(4);
  });

  it('corrige deterministicamente inversões do LLM em "Depois do comprovante" e "Pergunta pra mim. E muda, prefiro que envie para mim q nota"', () => {
    const r1 = reconciliarPreferenciasComFalaDoMedico(
      'Depois do comprovante',
      PREFERENCIAS_EMISSAO_VAZIAS,
      { emitirApenasComComprovante: false, revisaoDiariaAgenda: true }
    );
    const apos1 = mesclarPreferenciasEmissao(PREFERENCIAS_EMISSAO_VAZIAS, r1);
    expect(apos1.emitirApenasComComprovante).toBe(true);
    expect(apos1.revisaoDiariaAgenda).toBe(false);

    const estadoAntesCpf: PreferenciasEmissaoConta = {
      emitirApenasComComprovante: true,
      revisaoDiariaAgenda: false,
      pedirAprovacaoAntesDeEmitir: false,
      enviarNotaParaPaciente: true,
      solicitarCpfDiretoPaciente: null
    };
    const r2 = reconciliarPreferenciasComFalaDoMedico(
      'Pergunta pra mim. E muda, prefiro que envie para mim q nota',
      estadoAntesCpf,
      { enviarNotaParaPaciente: false, pedirAprovacaoAntesDeEmitir: true, solicitarCpfDiretoPaciente: null }
    );
    const apos2 = mesclarPreferenciasEmissao(estadoAntesCpf, r2);
    expect(apos2).toEqual({
      emitirApenasComComprovante: true,
      revisaoDiariaAgenda: false,
      pedirAprovacaoAntesDeEmitir: false,
      enviarNotaParaPaciente: false,
      solicitarCpfDiretoPaciente: false
    });
  });

  it('marca proximaEtapa como definir_preferencias depois que fiscal está pronto e preferências ainda faltam', () => {
    const agenda = { conectada: true, provedor: 'tribemd', nomeAgenda: 'TribeMD' };
    const profissionais = [{
      id: 'm1',
      nomeCompleto: 'Dra. Alice Xavier',
      crm: '12345/RS',
      rqe: null,
      certificadoValido: true,
      dadosFiscaisProntos: true
    }];

    expect(decidirProximoPassoOnboarding({
      agenda,
      profissionais,
      preferenciasEmissao: PREFERENCIAS_EMISSAO_VAZIAS
    }).proximaEtapa).toBe('definir_preferencias');

    const completas: PreferenciasEmissaoConta = {
      emitirApenasComComprovante: true,
      revisaoDiariaAgenda: true,
      enviarNotaParaPaciente: true,
      pedirAprovacaoAntesDeEmitir: true,
      solicitarCpfDiretoPaciente: false
    };
    expect(decidirProximoPassoOnboarding({
      agenda,
      profissionais,
      preferenciasEmissao: completas
    }).proximaEtapa).toBe('pronto');
  });

  it('inicia conversa natural de secretária logo após concluir o certificado A1 e extrair dados fiscais', async () => {
    const mensagens: string[] = [];
    const porta: PortaEnvioOrquestracao = {
      enviarTexto: async (_tel, texto) => { mensagens.push(texto); return true; },
      criarLinkProfissionais: vi.fn(),
      criarLinkCertificado: vi.fn(),
      criarLinkXml: vi.fn(),
      listarProfissionaisSemCertificado: async () => [],
      obterNomeAgendaConectada: async () => 'TribeMD',
      preferenciasJaConfiguradas: async () => false
    };

    await notificarCertificadoSalvoEProximoPasso(porta, {
      contaId: 'c1',
      medicoId: 'm1',
      nomeProfissional: 'Dra. Alice Xavier',
      telefone: '5551999990001',
      fiscalImportado: true,
      resumoFiscal: 'ISS 2%'
    });

    expect(mensagens.some(m => m.includes('Por aqui tá tudo certo'))).toBe(true);
    expect(mensagens.some(m => m.includes('TribeMD'))).toBe(true);
    expect(mensagens.some(m => m.includes('comprovante') && m.includes('logo depois da consulta'))).toBe(true);

    const mensagensXml: string[] = [];
    await notificarXmlSalvoEProximoPasso({
      ...porta,
      enviarTexto: async (_tel, texto) => { mensagensXml.push(texto); return true; },
      preferenciasJaConfiguradas: async () => true
    }, {
      contaId: 'c1',
      nomeProfissional: 'Dra. Alice Xavier',
      telefone: '5551999990001'
    });
    expect(mensagensXml.some(m => m.includes('preferências que combinamos'))).toBe(true);
  });

  it('salva múltiplas preferências a partir de resposta natural sem bloquear nem engessar a fala da IA', async () => {
    let estadoPrefs: PreferenciasEmissaoConta = { ...PREFERENCIAS_EMISSAO_VAZIAS };
    const salvarPreferenciasEmissao = vi.fn(async patch => {
      estadoPrefs = mesclarPreferenciasEmissao(estadoPrefs, patch);
      return estadoPrefs;
    });

    const modelo = new ScriptedModel([
      [functionCall('salvar_preferencias_emissao', {
        emitirApenasComComprovante: true,
        enviarNotaParaPaciente: true,
        pedirAprovacaoAntesDeEmitir: true
      }, { callId: 'pref-1' })],
      [assistantMessage('Combinado, anotei aqui! Só com comprovante, te pedindo um ok antes e já mandando pro paciente. Quer que eu dê uma olhada na sua agenda todo dia também?')]
    ]);

    const resposta = await responderAgente(
      { texto: 'Eu só emito quando o paciente paga e manda o comprovante, pode mandar pra ele depois mas sempre me pergunta antes', profissionais: [] },
      {
        modeloTeste: modelo,
        consultarStatus: vi.fn().mockResolvedValue(vazio),
        onboardingAutonomo: { salvarPreferenciasEmissao }
      }
    );

    expect(salvarPreferenciasEmissao).toHaveBeenCalledTimes(1);
    expect(estadoPrefs).toEqual({
      emitirApenasComComprovante: true,
      revisaoDiariaAgenda: false,
      enviarNotaParaPaciente: true,
      pedirAprovacaoAntesDeEmitir: true,
      solicitarCpfDiretoPaciente: null
    });
    expect(resposta).toContain('Combinado, anotei aqui!');
    expect(resposta).not.toContain('[[RESULTADO_ACAO]]');
    expect(resposta).not.toContain('Não consegui confirmar isso');
    modelo.assertComplete();
  });

  it('mantém memória das últimas trocas no webhook mesmo com persistirConversa=true', async () => {
    const mensagensReservadas = new Set<string>();
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('from usuarios where ativo=true')) return { rows: [{ conta_id: 'conta-1' }] };
      if (sql.includes('from medicos where conta_id=$1')) return { rows: [{ id: 'med-1', nome_completo: 'Alice Xavier' }] };
      if (sql.includes('from noto_agent_conversas')) return { rows: [{ estado: {} }] };
      if (sql.startsWith('insert into noto_agent_mensagens')) {
        const chave = String(params?.[2] ?? '');
        if (mensagensReservadas.has(chave)) return { rows: [] };
        mensagensReservadas.add(chave);
        return { rows: [{ mensagem_id: chave }] };
      }
      return { rows: [], rowCount: 1 };
    });

    const modelo = new ScriptedModel([
      [assistantMessage('Você emite só quando chega o comprovante ou logo após a consulta?')],
      [assistantMessage('Beleza, só com comprovante então!')]
    ]);
    const enviar = vi.fn().mockResolvedValue(true);

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
      modeloTeste: modelo,
      consultarStatus: vi.fn().mockResolvedValue(vazio),
      enviar
    }));

    const server = await new Promise<import('node:http').Server>(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const porta = (server.address() as import('node:net').AddressInfo).port;
      const postar = (id: string, texto: string) => fetch(`http://127.0.0.1:${porta}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': 'segredo-teste' },
        body: JSON.stringify({
          instance: 'instancia_teste_noto',
          event: 'MESSAGES_UPSERT',
          data: { key: { id, remoteJid: '555199990001@s.whatsapp.net', fromMe: false }, message: { conversation: texto } }
        })
      });

      expect((await postar('MSG-1', 'Podemos seguir sem certificado?')).status).toBe(200);
      expect((await postar('MSG-2', 'Com provante')).status).toBe(200);

      const entradaTurno2 = JSON.stringify(modelo.calls[1]?.request.input ?? '');
      expect(entradaTurno2).toContain('comprovante ou logo após a consulta');
      expect(entradaTurno2).toContain('Podemos seguir sem certificado?');
      modelo.assertComplete();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
