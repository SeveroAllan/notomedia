import { expect, it } from 'vitest';
import { z } from 'zod';
import { ErroNvidiaChat } from '../src/io/nvidia/chat-client.js';
import { diagnosticarFalhaAssistente, type EtapaAssistente } from '../src/assistente/diagnostico.js';

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

it('mantém SQLSTATE e etapa com mensagem fixa, sem copiar texto técnico ou restrição', () => {
  const erro = Object.assign(new Error('Conexão caiu https://usuario:senha@exemplo.invalid/caminho?token=ficticio; Bearer ficticio; CPF 123.456.789-09'),
    { code: '23505', constraint: 'assistente_trabalhos_usuario_id_tipo_chave_key', detail: 'não registrar detalhe' });
  const diagnostico = diagnosticarFalhaAssistente(erro, 'salvar_conversa');
  expect(diagnostico).toMatchObject({ codigo: '23505', etapa: 'salvar_conversa',
    mensagem: 'A operação no banco de dados não foi concluída.' });
  expect(diagnostico).not.toHaveProperty('restricao');
  expect(JSON.stringify(diagnostico)).not.toMatch(/senha@|token=ficticio|Bearer ficticio|123\.456|não registrar detalhe/);
});

it.each([
  'Paciente Ana Exemplo apresenta dor torácica e usa medicamento fictício',
  'JOAO_DA_SILVA', 'SEGREDO_FICTICIO_SEM_ROTULO'
])('não registra nenhum texto livre do erro: %s', texto => {
  class ClasseFicticiaComNomeDePaciente extends Error {}
  const erro = Object.assign(new ClasseFicticiaComNomeDePaciente(texto), {
    name: 'NomeClinicoFicticio', codigo: texto, code: texto, constraint: 'paciente_nome_clinico',
    detail: texto, cause: texto, stack: texto, statusHttp: 503
  });
  const diagnostico = diagnosticarFalhaAssistente(erro, 'consultar_preparacao');
  expect(diagnostico).toEqual({ etapa: 'consultar_preparacao', codigo: 'ERRO_NAO_MAPEADO',
    tipoErro: 'Error', mensagem: 'A execução não foi concluída.', statusHttp: 503 });
  expect(JSON.stringify(diagnostico)).not.toMatch(/Ana|JOAO|SEGREDO|NomeClinico|paciente_nome|ClasseFicticia/);
});

it('aceita códigos internos conhecidos somente por igualdade com o catálogo', () => {
  expect(diagnosticarFalhaAssistente(Error('MEDICO_NAO_PERMITIDO'), 'verificar_permissoes').codigo)
    .toBe('MEDICO_NAO_PERMITIDO');
  expect(diagnosticarFalhaAssistente(Error('MEDICO_NAO_PERMITIDO paciente Ana'), 'verificar_permissoes').codigo)
    .toBe('ERRO_NAO_MAPEADO');
});

it('limita também os metadados de validação e o caminho aos valores permitidos', () => {
  const erro = new z.ZodError([{
    code: z.ZodIssueCode.invalid_type, path: ['NomeClinicoFicticio', 12345678901],
    expected: 'SEGREDO_FICTICIO' as z.ZodParsedType, received: 'DADO_CLINICO' as z.ZodParsedType,
    message: 'Paciente Ana com diagnóstico fictício'
  }, { code: z.ZodIssueCode.invalid_string, path: ['memoria', 'agenda'],
    validation: 'SEGREDO_FICTICIO' as 'uuid', message: 'não registrar' }]);
  const diagnostico = diagnosticarFalhaAssistente(erro, 'decidir_conversa');
  expect(diagnostico.problemas).toEqual([
    { codigo: 'invalid_type', caminho: '[campo].[indice]' },
    { codigo: 'invalid_string', caminho: 'memoria.agenda' }
  ]);
  expect(JSON.stringify(diagnostico)).not.toMatch(/NomeClinico|12345678901|SEGREDO|DADO_CLINICO|Paciente Ana|não registrar/);
});

it.each([99, 600, 503.5, '503', NaN, Infinity])('ignora HTTP fora do domínio permitido: %s', statusHttp => {
  expect(diagnosticarFalhaAssistente(Object.assign(Error('não registrar'), { statusHttp }), 'decidir_conversa'))
    .not.toHaveProperty('statusHttp');
});

it('não copia uma etapa fora do catálogo mesmo se o chamador violar a tipagem', () => {
  expect(diagnosticarFalhaAssistente(Error('segredo-ficticio'), 'NomeClinicoFicticio' as EtapaAssistente).etapa)
    .toBe('etapa_desconhecida');
});

it('não copia objetos ou strings arbitrários lançados como erro', () => {
  expect(JSON.stringify(diagnosticarFalhaAssistente({ mensagem: 'segredo-ficticio' }, 'carregar_contexto')))
    .not.toContain('segredo-ficticio');
});
