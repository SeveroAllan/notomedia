import { ZodError } from 'zod';
import { sanitizarTextoMedico } from '../onboarding/contexto-conversa-medico.js';

export type EtapaAssistente = 'reservar_trabalho' | 'carregar_contexto' | 'decidir_conversa' | 'salvar_conversa' |
  'verificar_permissoes' | 'consultar_preparacao' | 'revalidar_permissoes' | 'salvar_preparacao' |
  'verificar_destino' | 'enviar_mensagem' | 'confirmar_envio' | 'registrar_falha';
export interface DiagnosticoAssistente {
  etapa: EtapaAssistente;
  codigo: string;
  tipoErro: string;
  mensagem: string;
  statusHttp?: number;
  restricao?: string;
  problemas?: Array<{ caminho: string; codigo: string; validacao?: string; esperado?: string; recebido?: string }>;
}
const campos = new Set(['resposta', 'memoria', 'agenda', 'periodo', 'profissionais', 'consultarPreparacao']);
const codigoTecnico = (valor: unknown): valor is string => typeof valor === 'string' && /^[A-Z0-9_]{1,80}$/.test(valor);

export function diagnosticarFalhaAssistente(erro: unknown, etapa: EtapaAssistente): DiagnosticoAssistente {
  if (erro instanceof ZodError) {
    return { etapa, codigo: 'CONTRATO_INVALIDO', tipoErro: 'ZodError', mensagem: 'Dados incompatíveis com o contrato esperado.',
      problemas: erro.issues.slice(0, 20).map(issue => ({ codigo: issue.code,
        caminho: issue.path.map(p => typeof p === 'number' || campos.has(p) ? String(p) : '[campo]').join('.'),
        ...(issue.code === 'invalid_type' ? { esperado: issue.expected, recebido: issue.received } : {}),
        ...(issue.code === 'invalid_string' && typeof issue.validation === 'string' ? { validacao: issue.validation } : {}) })) };
  }
  // SyntaxError.message pode conter a própria resposta do modelo.
  if (erro instanceof SyntaxError) return { etapa, codigo: 'JSON_INVALIDO', tipoErro: 'SyntaxError',
    mensagem: 'O conteúdo recebido não pôde ser interpretado como JSON.' };
  if (!(erro instanceof Error)) return { etapa, codigo: 'ERRO_NAO_MAPEADO', tipoErro: 'desconhecido',
    mensagem: 'A execução lançou uma falha sem estrutura de Error.' };
  const dados = erro as Error & { codigo?: unknown; code?: unknown; statusHttp?: unknown; constraint?: unknown };
  const codigo = [dados.codigo, dados.code, erro.message].find(codigoTecnico) ?? 'ERRO_NAO_MAPEADO';
  const mensagem = sanitizarTextoMedico(erro.message
    .replace(/https?:\/\/[^\s]+/gi, '[URL OCULTA]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[OCULTO]')
    .replace(/<[^>]*>[\s\S]*/g, '[OCULTO]')
    .replace(/"[^"\n]*"|'[^'\n]*'/g, '[OCULTO]')).slice(0, 500);
  const tipoErro = erro.name === 'Error' ? erro.constructor.name : erro.name;
  return { etapa, codigo, tipoErro: /^[A-Za-z]{1,60}$/.test(tipoErro) ? tipoErro : 'Error', mensagem,
    ...(typeof dados.statusHttp === 'number' && Number.isInteger(dados.statusHttp) && dados.statusHttp >= 100 && dados.statusHttp <= 599
      ? { statusHttp: dados.statusHttp } : {}),
    ...(typeof dados.constraint === 'string' && /^[a-z_][a-z0-9_]{0,100}$/.test(dados.constraint)
      ? { restricao: dados.constraint } : {}) };
}
