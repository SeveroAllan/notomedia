import { describe, expect, it, vi } from 'vitest';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import { responderAgente, respostaCompativelComFerramentas } from '../src/agente/agente.js';
import type { EventoFerramenta } from '../src/agente/diagnostico.js';

const conectado: EventoFerramenta[] = [
  { nome: 'consultar_status_agendas', codigo: 'STATUS_CONECTADO', duracaoMs: 1 }
];
const desconectado: EventoFerramenta[] = [
  { nome: 'consultar_status_agendas', codigo: 'STATUS_NAO_CONECTADO', duracaoMs: 1 }
];
const falhou: EventoFerramenta[] = [
  { nome: 'consultar_status_agendas', codigo: 'STATUS_INDISPONIVEL', duracaoMs: 1 }
];

describe('guard determinístico — ações fiscais negadas e afirmações sem prova', () => {
  it.each([
    'Não emiti nota nenhuma.',
    'Eu ainda não enviei documento.',
    'Nunca cancelei a nota.',
    'Não emiti a nota e não enviei o comprovante.',
    'O comprovante ainda não foi enviado.',
    'A nota não foi emitida.',
    'A nota nunca foi cancelada.',
    'Não sei se emiti a nota.',
    'Não posso confirmar se enviei o documento.',
    'Não tenho evidência de que emiti a nota.',
    'Não emiti a nota. Podemos verificar o que falta?',
    'Não consegui verificar sua última nota, porque não possuo essa ferramenta.'
  ])('preserva explicação legítima: %s', texto => {
    expect(respostaCompativelComFerramentas(texto, [])).toBe(true);
  });

  it.each([
    'Emiti a nota.',
    'Já emitimos uma nota.',
    'Enviei o comprovante.',
    'Cancelei a nota.',
    'O documento foi enviado.',
    'A nota já foi emitida.',
    'O comprovante está enviado.',
    'Não emiti a nota, mas enviei o comprovante.',
    'Não emiti a nota e enviei o documento.',
    'Não enviei o documento; emiti a nota.',
    'A nota não foi emitida, mas o documento foi enviado.',
    'Não enviei a nota. Contudo, já cancelei a nota.',
    'Não emiti a nota, porém a nota já foi enviada.',
    'Não sei se enviei a nota, mas já emiti o comprovante.'
  ])('bloqueia ação indevida, mesmo havendo negação na resposta: %s', texto => {
    expect(respostaCompativelComFerramentas(texto, [])).toBe(false);
  });

  it.each([
    ['A agenda TribeMD está conectada.', [], false],
    ['A agenda TribeMD está conectada.', conectado, true],
    ['A agenda está desconectada.', [], false],
    ['A agenda está desconectada.', desconectado, true],
    ['A agenda não está conectada.', [], false],
    ['A agenda não está conectada.', desconectado, true],
    ['A agenda não está conectada.', conectado, false],
    ['Não consegui verificar a agenda agora.', falhou, true],
    ['Não sei se a agenda está conectada.', falhou, true],
    ['Não posso confirmar se a agenda está conectada.', [], true],
    ['Não consegui verificar a agenda, mas a TribeMD está conectada.', falhou, false],
    ['Não consegui verificar a agenda; a Amplimed está desconectada.', falhou, false],
    ['A agenda não está conectada, porém a TribeMD está conectada.', desconectado, false],
    ['A agenda está conectada, mas a Amplimed está desconectada.', conectado, false],
    ['A agenda pode estar conectada; não consegui verificar.', falhou, true]
  ] as const)('conexão: %s → %s', (texto, evidencias, esperado) => {
    expect(respostaCompativelComFerramentas(texto, evidencias)).toBe(esperado);
  });

  it('resposta negativa do modelo passa íntegra, com o código diagnóstico RESPOSTA', async () => {
    const texto = 'Não emiti nota nenhuma e ainda não enviei documento.';
    const modelo = new ScriptedModel([
      [functionCall('consultar_contexto_conta', {}, { callId: 'neg-1' })],
      [assistantMessage(texto)]
    ]);
    const diagnostico = vi.fn();
    const resposta = await responderAgente(
      { texto: 'E as notas?', profissionais: [{ id: 'prof-1', nome: 'Dra. Teste' }] },
      { modeloTeste: modelo, consultarStatus: vi.fn(), aoDiagnostico: diagnostico }
    );
    expect(resposta).toBe(texto);
    expect(diagnostico).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      codigo: 'RESPOSTA',
      ferramentas: [expect.objectContaining({
        nome: 'consultar_contexto_conta', codigo: 'CONTA_AUTORIZADA'
      })]
    }));
    modelo.assertComplete();
  });

  it('resposta mista do modelo não passa; nem um "não" verdadeiro encobre envio inventado', async () => {
    const modelo = new ScriptedModel([
      [functionCall('consultar_contexto_conta', {}, { callId: 'mist-1' })],
      [assistantMessage('Não emiti nota nenhuma, mas enviei o documento.')]
    ]);
    const diagnostico = vi.fn();
    const resposta = await responderAgente(
      { texto: 'Qual o estado?', profissionais: [{ id: 'prof-1', nome: 'Dra. Teste' }] },
      { modeloTeste: modelo, consultarStatus: vi.fn(), aoDiagnostico: diagnostico }
    );
    expect(resposta).toContain('Não consegui confirmar isso');
    expect(resposta).not.toContain('enviei o documento');
    expect(diagnostico).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      codigo: 'RESPOSTA_BLOQUEADA',
      ferramentas: [expect.objectContaining({ nome: 'consultar_contexto_conta', codigo: 'CONTA_AUTORIZADA' })]
    }));
    modelo.assertComplete();
  });
});


describe('guard exige evidência das novas ações de onboarding sem bloquear negações',()=>{
  const evento = (codigo: import('../src/agente/diagnostico.js').CodigoFerramenta) =>
    [{nome:'consultar_contexto_conta' as const,codigo,duracaoMs:1}];

  it.each([
    ['CRM registrado.', 'DADOS_PROFISSIONAIS_SALVOS'],
    ['Registrei o CRM.', 'DADOS_PROFISSIONAIS_SALVOS'],
    ['Enviei o link seguro.', 'LINK_ENVIADO'],
    ['Bruno foi adicionado à conta.', 'PROFISSIONAIS_CONFIRMADOS'],
    ['Encontrei Bruno na agenda.', 'PROFISSIONAIS_ENCONTRADOS']
  ] as const)('bloqueia afirmação %s sem ferramenta, mas permite com prova %s',(frase,codigo)=>{
    expect(respostaCompativelComFerramentas(frase,[])).toBe(false);
    expect(respostaCompativelComFerramentas(frase,evento(codigo))).toBe(true);
  });

  it('negação isolada não bloqueia, mas não libera uma segunda ação inventada',()=>{
    expect(respostaCompativelComFerramentas('Não registrei o CRM.',[])).toBe(true);
    expect(respostaCompativelComFerramentas('Não enviei link.',[])).toBe(true);
    expect(respostaCompativelComFerramentas('Não encontrei Bruno na agenda.',[])).toBe(true);
    expect(respostaCompativelComFerramentas('Não enviei link, mas registrei o CRM.',[])).toBe(false);
    expect(respostaCompativelComFerramentas('Não registrei o CRM; enviei o link.',[])).toBe(false);
  });
});
