import { ZodError, ZodIssueCode, ZodParsedType } from 'zod';

const etapas = ['reservar_trabalho', 'carregar_contexto', 'decidir_conversa', 'salvar_conversa',
  'verificar_permissoes', 'consultar_preparacao', 'revalidar_permissoes', 'salvar_preparacao',
  'verificar_destino', 'enviar_mensagem', 'confirmar_envio', 'registrar_falha', 'etapa_desconhecida'] as const;
export type EtapaAssistente = typeof etapas[number];
const etapasPermitidas = new Set<string>(etapas);
export interface DiagnosticoAssistente {
  etapa: EtapaAssistente;
  codigo: string;
  tipoErro: string;
  mensagem: string;
  statusHttp?: number;
  problemas?: Array<{ caminho: string; codigo: string; validacao?: string; esperado?: string; recebido?: string }>;
}
const campos = new Set(['resposta', 'memoria', 'agenda', 'periodo', 'profissionais', 'consultarPreparacao']);
const codigosValidacao = new Set<string>(Object.values(ZodIssueCode));
const tiposValidacao = new Set<string>(Object.values(ZodParsedType));
const codigosModelo = new Set(['IA_NAO_CONFIGURADA', 'IA_HTTP_ERRO', 'IA_CONEXAO_FALHOU', 'IA_TEMPO_ESGOTADO', 'IA_RESPOSTA_INVALIDA']);
const codigosBanco = new Set(['08000', '08001', '08003', '08004', '08006', '08007', '08P01', '22001', '22P02',
  '23502', '23503', '23505', '23514', '40001', '40P01', '42501', '42601', '42703', '42P01', '53300',
  '53400', '55000', '55P03', '57014', '57P01', '57P02', '57P03', '58000', '58030']);
const codigosRede = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH']);
const codigosInternos = new Set(['MEDICO_NAO_PERMITIDO', 'CONTEXTO_REVOGADO', 'RESERVA_OBSOLETA', 'DESTINO_NAO_PERMITIDO', 'ENVIO_NAO_CONFIRMADO']);
const codigosPermitidos = new Set([...codigosModelo, ...codigosBanco, ...codigosRede, ...codigosInternos]);

export function diagnosticarFalhaAssistente(erro: unknown, etapa: EtapaAssistente): DiagnosticoAssistente {
  etapa = etapasPermitidas.has(etapa) ? etapa : 'etapa_desconhecida';
  if (erro instanceof ZodError) {
    return { etapa, codigo: 'CONTRATO_INVALIDO', tipoErro: 'ZodError', mensagem: 'Dados incompatíveis com o contrato esperado.',
      problemas: erro.issues.slice(0, 20).map(issue => ({
        caminho: issue.path.slice(0, 8).map(p => typeof p === 'number'
          ? Number.isSafeInteger(p) && p >= 0 && p < 50 ? String(p) : '[indice]'
          : campos.has(p) ? p : '[campo]').join('.'),
        ...(issue.code === 'invalid_type' && tiposValidacao.has(issue.expected) ? { esperado: issue.expected } : {}),
        ...(issue.code === 'invalid_type' && tiposValidacao.has(issue.received) ? { recebido: issue.received } : {}),
        ...(issue.code === 'invalid_string' && issue.validation === 'uuid' ? { validacao: 'uuid' } : {}),
        codigo: codigosValidacao.has(issue.code) ? issue.code : 'custom' })) };
  }
  // SyntaxError.message pode conter a própria resposta do modelo.
  if (erro instanceof SyntaxError) return { etapa, codigo: 'JSON_INVALIDO', tipoErro: 'SyntaxError',
    mensagem: 'O conteúdo recebido não pôde ser interpretado como JSON.' };
  if (!(erro instanceof Error)) return { etapa, codigo: 'ERRO_NAO_MAPEADO', tipoErro: 'desconhecido',
    mensagem: 'A execução lançou uma falha sem estrutura de Error.' };
  const dados = erro as Error & { codigo?: unknown; code?: unknown; statusHttp?: unknown };
  // message só pode selecionar um código por igualdade exata. Seu texto nunca é registrado.
  const codigo = [dados.codigo, dados.code, erro.message]
    .find((valor): valor is string => typeof valor === 'string' && codigosPermitidos.has(valor)) ?? 'ERRO_NAO_MAPEADO';
  const [tipoErro, mensagem] = codigosModelo.has(codigo) ? ['ErroNvidiaChat', 'A chamada ao modelo não foi concluída.']
    : codigosBanco.has(codigo) ? ['PostgresError', 'A operação no banco de dados não foi concluída.']
    : codigosRede.has(codigo) ? ['TransporteError', 'A comunicação com um serviço não foi concluída.']
    : codigosInternos.has(codigo) ? ['Error', 'A execução foi interrompida por uma verificação interna.']
    : ['Error', 'A execução não foi concluída.'];
  return { etapa, codigo, tipoErro, mensagem,
    ...(typeof dados.statusHttp === 'number' && Number.isInteger(dados.statusHttp) && dados.statusHttp >= 100 && dados.statusHttp <= 599
      ? { statusHttp: dados.statusHttp } : {}) };
}
