import { describe, expect, it, vi } from 'vitest';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import { responderAgente } from '../src/agente/agente.js';

const profissionais = [
  { id: 'alice-id', nome: 'Dra. Alice Silva' },
  { id: 'bruno-id', nome: 'Dr. Bruno Lima' }
];
const conectada = { tribemd: { salvo: true, conectada: true }, amplimed: { salvo: false, conectada: false } };
const vazia = { tribemd: { salvo: false, conectada: false }, amplimed: { salvo: false, conectada: false } };

describe('Noto Agent — Agent SDK, ferramentas e decisões em loop', () => {
  it('começa sem cadastro, chama contexto e pergunta qual agenda sem inventar médico', async () => {
    const modelo = new ScriptedModel([
      [functionCall('consultar_contexto_conta', {}, { callId: 'c1' })],
      [assistantMessage('Olá! Sou o Noto. Posso ajudar com notas fiscais. Qual agenda você utiliza: TribeMD, Amplimed ou outra?')]
    ]);
    const consultarStatus = vi.fn();
    const resposta = await responderAgente({ texto: 'Oi Noto', profissionais: [], semConta: true }, {
      modeloTeste: modelo, consultarStatus
    });
    expect(resposta).toContain('Qual agenda');
    expect(consultarStatus).not.toHaveBeenCalled();
    expect(modelo.calls).toHaveLength(2);
    const retorno = JSON.stringify(modelo.lastCall?.request.input);
    expect(retorno).toContain('contaCadastrada');
    expect(retorno).toContain('false');
    modelo.assertComplete();
  });

  it('usa a escolha Amplimed para orientar o cadastro seguro antes da conexão', async () => {
    const modelo = new ScriptedModel([
      [functionCall('orientar_conexao_agenda', { agenda: 'amplimed', profissional: null }, { callId: 'c1' })],
      [assistantMessage('Perfeito, usa Amplimed! Antes precisamos vincular o WhatsApp à conta pelo painel seguro.')]
    ]);
    const resposta = await responderAgente({
      texto: 'Uso Amplimed', contexto: ['Qual agenda você usa?'], profissionais: [], semConta: true
    }, { modeloTeste: modelo, consultarStatus: vi.fn() });
    expect(resposta).toContain('vincular');
    expect(JSON.stringify(modelo.lastCall?.request.input)).toContain('Amplimed');
    expect(JSON.stringify(modelo.lastCall?.request.input)).toContain('Vincular este WhatsApp');
    modelo.assertComplete();
  });

  it('consulta somente a profissional resolvida na conta e retorna evidência da conexão', async () => {
    const modelo = new ScriptedModel([
      [functionCall('consultar_status_agendas', { profissional: 'Alice' }, { callId: 'c1' })],
      [assistantMessage('A conexão TribeMD da Alice está ativa; não consultei consultas nem notas.')]
    ]);
    const consultarStatus = vi.fn().mockResolvedValue(conectada);
    const resposta = await responderAgente({ texto: 'Como está a agenda da Alice?', profissionais }, {
      modeloTeste: modelo, consultarStatus
    });
    expect(resposta).toContain('TribeMD');
    expect(consultarStatus).toHaveBeenCalledExactlyOnceWith('alice-id');
    const retorno = JSON.stringify(modelo.lastCall?.request.input);
    expect(retorno).toContain('tribemd');
    expect(retorno).toContain('conectada');
    expect(retorno).not.toContain('bruno-id');
    modelo.assertComplete();
  });

  it('nome ambíguo nunca escolhe profissional para executar consulta', async () => {
    const modelo = new ScriptedModel([
      [functionCall('consultar_status_agendas', { profissional: 'Alice' }, { callId: 'c1' })],
      [assistantMessage('Há duas profissionais chamadas Alice. Qual é o nome completo?')]
    ]);
    const consultarStatus = vi.fn();
    const resposta = await responderAgente({
      texto: 'Verifique a Alice',
      profissionais: [{ id: '1', nome: 'Alice Souza' }, { id: '2', nome: 'Alice Lima' }]
    }, { modeloTeste: modelo, consultarStatus });
    expect(resposta).toContain('nome completo');
    expect(consultarStatus).not.toHaveBeenCalled();
    expect(JSON.stringify(modelo.lastCall?.request.input)).toContain('Nome ambíguo');
    modelo.assertComplete();
  });

  it('já conectada: recebe evidência real e não chama reconexão', async () => {
    const modelo = new ScriptedModel([
      [functionCall('orientar_conexao_agenda', { agenda: 'tribemd', profissional: 'Alice' }, { callId: 'c1' })],
      [assistantMessage('A agenda TribeMD da Alice já está conectada. Não precisa conectar outra vez.')]
    ]);
    const consultarStatus = vi.fn().mockResolvedValue(conectada);
    const resposta = await responderAgente({ texto: 'Uso TribeMD, preciso conectar a Alice?', profissionais }, {
      modeloTeste: modelo, consultarStatus
    });
    expect(resposta).toContain('já está conectada');
    expect(JSON.stringify(modelo.lastCall?.request.input)).toContain('Já conectada');
    expect(consultarStatus).toHaveBeenCalledWith('alice-id');
    modelo.assertComplete();
  });

  it('bloqueia credenciais antes de chamar qualquer modelo', async () => {
    const modelo = new ScriptedModel([]);
    const resposta = await responderAgente({ texto: 'senha: AbCd2026@!', profissionais }, {
      modeloTeste: modelo, consultarStatus: vi.fn()
    });
    expect(resposta).toContain('não envie senhas');
    expect(modelo.calls).toHaveLength(0);
  });

  it('falha de IA produz fallback sem afirmar nota ou conexão', async () => {
    const modelo = new ScriptedModel([]);
    const resposta = await responderAgente({ texto: 'Veja a agenda', profissionais }, {
      modeloTeste: modelo, consultarStatus: vi.fn().mockResolvedValue(vazia)
    });
    expect(resposta).toContain('Não consegui concluir');
    expect(resposta).toContain('Não alterei');
    expect(resposta).not.toContain('está conectada');
  });

  it('sem chave da OpenAI responde indisponibilidade segura e não faz consultas', async () => {
    const consultarStatus = vi.fn();
    const resposta = await responderAgente({ texto: 'Oi', profissionais }, { consultarStatus });
    expect(resposta).toContain('temporariamente indisponível');
    expect(consultarStatus).not.toHaveBeenCalled();
  });
  it('registra códigos de ferramentas e uso de tokens sem retornar dados privados no diagnóstico', async () => {
    const modelo = new ScriptedModel([
      [functionCall('consultar_status_agendas', { profissional: 'Alice' }, { callId: 'trace-1' })],
      [assistantMessage('A TribeMD está conectada para a profissional consultada.')]
    ]);
    const aoDiagnostico = vi.fn();
    const resposta = await responderAgente({ texto: 'Verifique minha agenda Alice', profissionais }, {
      modeloTeste: modelo, consultarStatus: vi.fn().mockResolvedValue(conectada), aoDiagnostico
    });
    expect(resposta).toContain('conectada');
    expect(aoDiagnostico).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      codigo: 'RESPOSTA',
      ferramentas: [expect.objectContaining({ nome: 'consultar_status_agendas', codigo: 'STATUS_CONECTADO' })],
      uso: expect.objectContaining({ tokensEntrada: expect.any(Number), tokensSaida: expect.any(Number), tokensTotal: expect.any(Number) })
    }));
    expect(JSON.stringify(aoDiagnostico.mock.calls)).not.toContain('Alice Silva');
    modelo.assertComplete();
  });

  it('explicita falha do estado interno sem culpar o usuário ou presumir desconexão', async () => {
    const modelo = new ScriptedModel([
      [functionCall('orientar_conexao_agenda', { agenda: 'tribemd', profissional: 'Alice' }, { callId: 'trace-2' })],
      [assistantMessage('Não consegui verificar o Cofre agora. Podemos tentar de novo mais tarde, sem refazer sua configuração.')]
    ]);
    const aoDiagnostico = vi.fn();
    const resposta = await responderAgente({ texto: 'Tenho TribeMD para Alice', profissionais }, {
      modeloTeste: modelo, consultarStatus: vi.fn().mockResolvedValue({
        tribemd: { salvo: false, conectada: false, indisponivel: true },
        amplimed: { salvo: false, conectada: false }
      }), aoDiagnostico
    });
    expect(resposta).toContain('Não consegui verificar');
    expect(aoDiagnostico.mock.calls[0]?.[0]?.ferramentas[0]?.codigo).toBe('STATUS_INDISPONIVEL');
    expect(JSON.stringify(modelo.lastCall?.request.input)).toContain('Não foi possível consultar');
    modelo.assertComplete();
  });

  it('escolha de agenda não presume que o único profissional cadastrado é o desejado', async () => {
    const modelo = new ScriptedModel([
      [functionCall('orientar_conexao_agenda', { agenda: 'tribemd', profissional: null }, { callId: 'trace-3' })],
      [assistantMessage('Perfeito, você usa TribeMD. Para qual profissional deseja configurar a agenda?')]
    ]);
    const consultarStatus = vi.fn();
    const resposta = await responderAgente({
      texto: 'Eu uso tribemd', profissionais: [profissionais[0]!]
    }, { modeloTeste: modelo, consultarStatus });
    expect(resposta).toContain('Para qual profissional');
    expect(consultarStatus).not.toHaveBeenCalled();
    expect(JSON.stringify(modelo.lastCall?.request.input)).toContain('Não presumir');
    modelo.assertComplete();
  });

  it('não aceita nome de médico escolhido apenas pelo modelo sem menção na conversa', async () => {
    const modelo = new ScriptedModel([
      [functionCall('orientar_conexao_agenda', { agenda: 'tribemd', profissional: 'Alice' }, { callId: 'sem-escolha' })],
      [assistantMessage('Perfeito, você usa TribeMD. Para qual profissional deseja configurar?')]
    ]);
    const consultarStatus = vi.fn();
    const aoDiagnostico = vi.fn();
    const resposta = await responderAgente({
      texto: 'Eu uso tribemd', profissionais: [profissionais[0]!]
    }, { modeloTeste: modelo, consultarStatus, aoDiagnostico });
    expect(resposta).toContain('Para qual profissional');
    expect(consultarStatus).not.toHaveBeenCalled();
    expect(aoDiagnostico.mock.calls[0]?.[0]?.ferramentas[0]?.codigo).toBe('DEPENDENCIA_PROFISSIONAL');
    expect(JSON.stringify(modelo.lastCall?.request.input)).toContain('não foi escolhido explicitamente');
    modelo.assertComplete();
  });

});
