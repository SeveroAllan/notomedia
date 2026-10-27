import { expect, it } from 'vitest';
import { z } from 'zod';
import { ErroNvidiaChat } from '../src/io/nvidia/chat-client.js';
import { diagnosticarFalhaAssistente } from '../src/assistente/diagnostico.js';

it('preserva código e HTTP da falha do provedor, sem presumir a causa', () => {
  expect(diagnosticarFalhaAssistente(new ErroNvidiaChat('IA_HTTP_ERRO', 429), 'decidir_conversa'))
    .toMatchObject({ etapa: 'decidir_conversa', codigo: 'IA_HTTP_ERRO', tipoErro: 'ErroNvidiaChat', statusHttp: 429 });
});

it('registra caminhos e tipos inválidos sem valores ou chaves inesperadas do modelo', () => {
  const schema = z.object({ memoria: z.object({ agenda: z.string() }).strict() }).strict();
  const resultado = schema.safeParse({ memoria: { agenda: 123, 'senha=segredo-ficticio': 'valor-ficticio' } });
  if (resultado.success) throw Error('FIXTURE_INVALIDA');
  const diagnostico = diagnosticarFalhaAssistente(resultado.error, 'decidir_conversa');
  expect(diagnostico.codigo).toBe('CONTRATO_INVALIDO');
  expect(diagnostico.problemas).toEqual([
    { caminho: 'memoria.agenda', codigo: 'invalid_type', esperado: 'string', recebido: 'number' },
    { caminho: 'memoria', codigo: 'unrecognized_keys' }
  ]);
  expect(JSON.stringify(diagnostico)).not.toMatch(/segredo-ficticio|valor-ficticio|senha=/);
});

it('explica a validação UUID sem registrar o identificador recusado', () => {
  const resultado = z.object({ consultarPreparacao: z.array(z.string().uuid()) }).safeParse({ consultarPreparacao: ['nome-ficticio'] });
  if (resultado.success) throw Error('FIXTURE_INVALIDA');
  const diagnostico = diagnosticarFalhaAssistente(resultado.error, 'decidir_conversa');
  expect(diagnostico.problemas).toEqual([{ caminho: 'consultarPreparacao.0', codigo: 'invalid_string', validacao: 'uuid' }]);
  expect(JSON.stringify(diagnostico)).not.toContain('nome-ficticio');
});

it('não registra conteúdo de um JSON inválido', () => {
  let erro: unknown;
  try { JSON.parse('conteudo-sensivel-ficticio'); } catch (capturado) { erro = capturado; }
  const diagnostico = diagnosticarFalhaAssistente(erro, 'decidir_conversa');
  expect(diagnostico.codigo).toBe('JSON_INVALIDO');
  expect(JSON.stringify(diagnostico)).not.toContain('conteudo-sensivel-ficticio');
});

it('mantém SQLSTATE e local da falha e oculta credenciais no texto técnico', () => {
  const erro = Object.assign(new Error('Conexão caiu https://usuario:senha@exemplo.invalid/caminho?token=ficticio; Bearer ficticio; CPF 123.456.789-09'),
    { code: '23505', constraint: 'assistente_trabalhos_usuario_id_tipo_chave_key', detail: 'não registrar detalhe' });
  const diagnostico = diagnosticarFalhaAssistente(erro, 'salvar_conversa');
  expect(diagnostico).toMatchObject({ codigo: '23505', etapa: 'salvar_conversa',
    restricao: 'assistente_trabalhos_usuario_id_tipo_chave_key' });
  expect(diagnostico.mensagem).toContain('Conexão caiu');
  expect(JSON.stringify(diagnostico)).not.toMatch(/senha@|token=ficticio|Bearer ficticio|123\.456|não registrar detalhe/);
});

it('não copia objetos ou strings arbitrários lançados como erro', () => {
  expect(JSON.stringify(diagnosticarFalhaAssistente({ mensagem: 'segredo-ficticio' }, 'carregar_contexto')))
    .not.toContain('segredo-ficticio');
});
