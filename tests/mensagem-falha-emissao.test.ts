import { expect, it } from 'vitest';
import { traduzirFalhaEmissao } from '../src/worker/notificar-erro-medico.js';

const casos: Array<[string[], string]> = [
  [['PERFIL_FISCAL_INCOMPLETO'], 'Faltam informações do consultório; revise seu cadastro com seu contador antes de pedir uma nova tentativa.'],
  [['DADOS_PROFISSIONAIS_INCOMPLETOS'], 'Faltam seu nome completo e registro profissional; confira esses dados no cadastro antes de pedir uma nova tentativa.'],
  [['CERTIFICADO_AUSENTE'], 'Não encontrei um certificado digital ativo; cadastre um certificado válido antes de pedir uma nova tentativa.'],
  [['CERTIFICADO_INVALIDO'], 'Não consegui usar seu certificado digital; confira a validade e a senha na área segura antes de pedir uma nova tentativa.'],
  [['PACIENTE_CPF_INVALIDO'], 'Não consegui validar o documento do paciente; confira o cadastro antes de pedir uma nova tentativa.'],
  [['PACIENTE_NOME_INVALIDO'], 'Não consegui validar o nome do paciente; confira o nome completo no cadastro antes de pedir uma nova tentativa.'],
  [['PARAMETROS_FISCAIS_PENDENTES'], 'As informações de impostos precisam ser conferidas; peça ao seu contador para revisar a configuração antes de pedir uma nova tentativa.'],
  [['REJEICAO_TRIBUTOS'], 'O serviço de emissão recusou as informações de impostos; peça ao seu contador para conferir a configuração antes de pedir uma nova tentativa.'],
  [['PREPARACAO_NECESSARIA'], 'O cadastro do consultório precisa de revisão antes da emissão; peça ao suporte para conferir a configuração.'],
  [['AMBIENTE_FISCAL_BLOQUEADO'], 'A configuração não permite continuar este teste de emissão; peça ao suporte para conferir.'],
  [['INTEGRACAO_FISCAL_INDISPONIVEL'], 'Não consegui acessar o serviço de emissão; peça ao suporte para conferir a conexão.'],
  [['SEFIN_INDISPONIVEL'], 'O serviço de emissão da prefeitura está indisponível; aguarde uma orientação antes de pedir nova tentativa.'],
  [['SEFIN_TIMEOUT'], 'O serviço de emissão demorou a responder; aguarde a conferência do resultado antes de pedir nova tentativa.'],
  [['E0014'], 'A numeração informada já está em uso; aguarde o suporte conferir para evitar uma nota duplicada.'],
  [['E0160', 'E0676', 'E0710'], 'O cadastro do consultório está diferente do registrado no serviço de emissão; peça ao seu contador para conferir.'],
  [['FALHA_ENTREGA_PDF'], 'A nota foi emitida, mas não consegui entregar o documento; confira a conexão do WhatsApp e peça o reenvio, sem emitir outra nota.'],
  [['INSTANCIA_INDISPONIVEL'], 'A nota foi emitida, mas seu WhatsApp está desconectado; conecte-o e peça o reenvio, sem emitir outra nota.'],
  [['PERSISTENCIA_COMPROVANTE_PENDENTE'], 'A emissão foi autorizada, mas o registro precisa de conferência; aguarde o suporte e não peça outra emissão para a mesma consulta.']
];
for (const [codigos, texto] of casos) it.each(codigos)('traduz %s sem código ou detalhe técnico', codigo => {
  const interno = ['PREPARACAO_NECESSARIA', 'AMBIENTE_FISCAL_BLOQUEADO', 'INTEGRACAO_FISCAL_INDISPONIVEL', 'SEFIN_INDISPONIVEL', 'SEFIN_TIMEOUT'].includes(codigo);
  expect(traduzirFalhaEmissao(codigo)).toBe(interno ? 'Tive uma instabilidade e não consegui concluir agora. Não vou tentar emitir novamente sozinho.' : `${texto} Não vou tentar emitir novamente sozinho.`);
  expect(traduzirFalhaEmissao(codigo)).not.toContain(codigo);
});
it.each([undefined, '__proto__', 'E9999 senha=privado CPF 52998224725', { erro: 'privado' }])('desconhecido %j usa frase fixa segura', codigo => {
  expect(traduzirFalhaEmissao(codigo)).toBe('Tive uma instabilidade e não consegui concluir agora. Não vou tentar emitir novamente sozinho.');
});
it('registro de erro é estruturado, marcado e sanitizado para consumo futuro', async () => {
  const { registroErroNoto } = await import('../src/observabilidade/erros.js');
  const texto = registroErroNoto('BANCO_INDISPONIVEL', 'tecnico', { medicoId: 'medico', etapa: 'agenda', detalhe: 'CPF 529.982.247-25 senha=privado' });
  expect(texto).toMatch(/^NOTO_ERRO /); expect(texto).not.toContain('529.982.247-25'); expect(texto).not.toContain('privado');
  expect(JSON.parse(texto.slice('NOTO_ERRO '.length))).toMatchObject({ codigo: 'BANCO_INDISPONIVEL', categoria: 'tecnico', contexto: { medicoId: 'medico', etapa: 'agenda' } });
});
