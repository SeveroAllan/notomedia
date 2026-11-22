/**
 * Regras puras de formatação de relatos determinísticos para o fluxo legado de
 * piloto restrito (vínculo, revisão de CRM/RQE, período e certificado).
 * Separado de `agente.ts` para isolar a narração por evidência da execução do Runner.
 */

import { explicarVinculoNaoExecutado } from '../confirmacao-contextual.js';
import type { DiagnosticoAgente, EventoFerramenta } from '../diagnostico.js';
import type { EstadoConversa } from '../estado-conversa.js';
import { nomeProfissionalValido } from '../../conta/validar-dados-emissao.js';
import { respostaCompativelComFerramentas } from './validar-fala-com-evidencias.js';

export type OrientacaoCertificado =
  | { nome: string; ok: true; certificadoValido: boolean; url?: string }
  | { nome: string; ok: false; motivo: 'IDENTIDADE_PROFISSIONAL_NAO_CONFIRMADA' | 'PRONTIDAO_INDISPONIVEL' | 'ORIGEM_NAO_CONFIAVEL' };

export type DecisaoPeriodo =
  | { ok: true; nome: string; inicio: string; conferencia?: string }
  | { ok: false; motivo: string; rejeicao?: DiagnosticoAgente['rejeicaoPeriodo'] };

export type ResultadoRevisaoRegistro =
  | { ok: true; tipo: 'aprovacao'; nome: string; crm: string; rqe: string | null; rqeConfirmado?: boolean }
  | { ok: true; tipo: 'correcao'; nome: string; motivo?: string }
  | { ok: true; tipo: 'adiamento'; nome: string }
  | { ok: false; motivo: string };

export interface EntradaRelatoPiloto {
  semConta?: boolean;
  profissionais: ReadonlyArray<{ id: string; nome: string }>;
  estadoConversa?: EstadoConversa;
}

export function profissionalComVinculoConfirmado(entrada: EntradaRelatoPiloto) {
  if (entrada.semConta || entrada.estadoConversa?.faseAgenda !== 'VINCULO_CONFIRMADO') return undefined;
  return entrada.profissionais.find(
    p => p.id === entrada.estadoConversa?.profissionalConfirmadoId && nomeProfissionalValido(p.nome)
  );
}

export function descreverCertificado(r: OrientacaoCertificado, dadosConfirmados = false): string {
  if (dadosConfirmados) {
    if (!r.ok) return 'Ainda não consegui verificar o certificado de ' + r.nome + '.';
    if (r.certificadoValido) return 'O certificado de ' + r.nome + ' está válido.';
    return 'Para cadastrar o certificado de ' + r.nome + ', abra a página segura. O A1 e a senha entram somente nela.';
  }
  if (!r.ok) {
    if (r.motivo === 'IDENTIDADE_PROFISSIONAL_NAO_CONFIRMADA') {
      return 'Preciso identificar o médico confirmado antes de orientar o certificado. Qual profissional você quer configurar?';
    }
    if (r.motivo === 'PRONTIDAO_INDISPONIVEL') {
      return 'Não consegui consultar a situação do certificado. Isso não comprova que a página esteja indisponível. O próximo passo é recuperar essa consulta e retomar o certificado; o vínculo e o CRM pendente ficam preservados.';
    }
    return 'O endereço da página segura precisa ser corrigido na configuração do Noto. O próximo passo é conferir a origem HTTPS e retomar o certificado por essa página. O vínculo e o CRM pendente ficam preservados; não envie o A1 ou a senha pela conversa.';
  }
  if (r.certificadoValido) {
    return 'O certificado está válido para ' + r.nome + '. Podemos seguir com as demais pendências do onboarding, mantendo o CRM pendente.';
  }
  return 'Para cadastrar o certificado de ' + r.nome + ', abra esta página autenticada. O A1 e a senha entram somente nela. O CRM pode continuar pendente.\n' + r.url;
}

export function falaEnvioRegistro(motivo: string | undefined, nome: string, anteriorInvalidado = false): string {
  const alvo = nome ? ' de ' + nome : '';
  const troca = anteriorInvalidado ? 'Invalidei o link anterior para que apenas o novo possa ser usado. ' : '';
  switch (motivo) {
    case 'ACEITO_API':
    case 'ACEITO_SEM_ENTREGA':
      return troca + 'Se o link seguro' + alvo + ' apareceu na conversa, use a página para preencher os dados. Se não apareceu, posso substituir o link com a sua autorização.';
    case 'ENVIO_INCERTO':
      return troca + 'O resultado do envio do link seguro' + alvo + ' ficou incerto. Não sei se a mensagem chegou e não vou reenviá-la às cegas. Posso conferir o recibo; se você preferir, podemos invalidar o link anterior e pedir outro com sua autorização.';
    case 'FALHA_COMPROVADA':
      return troca + 'O envio do link seguro' + alvo + ' falhou de forma comprovada. Posso solicitar outro agora, com sua autorização, sem manter o link anterior utilizável.';
    case 'ENTREGUE':
      return 'O WhatsApp confirmou a entrega do link seguro' + alvo + '. Isso ainda não significa que o formulário foi preenchido.';
    case 'LIDO':
      return 'O WhatsApp confirmou a leitura da mensagem com o link seguro' + alvo + '. Ainda aguardo o preenchimento.';
    case 'LINK_ENTREGUE':
      return 'O link seguro' + alvo + ' já teve a entrega confirmada. Não gerei outro; posso ajudar se a página não abriu.';
    case 'PEDIDO_JA_PROCESSADO':
      return 'Esse pedido de link seguro' + alvo + ' já foi processado. Não reenviei nada. Posso verificar o estado atual.';
    case 'SEM_LINK_ATIVO':
      return 'Não existe um link seguro ativo' + alvo + '. Se você autorizar, posso solicitar um novo.';
    case 'LIMITE_LINKS':
      return 'O limite de criação de links seguros foi atingido. Não fiz outro envio; precisamos respeitar esse limite.';
    case 'SEM_AUTORIZACAO':
      return 'Não solicitei outro link. Preciso da sua autorização para realizar essa ação.';
    case 'REVISAO_NAO_AUTORIZADA':
    case 'REVISAO_NAO_DISPONIVEL':
      return 'A revisão dos dados' + alvo + ' ainda não está confirmada. Não gerei outro link nem alterei o cadastro.';
    default:
      return 'Ainda não tenho um estado verificável para o link seguro' + alvo + '. Não repeti o envio. Podemos verificar o que ficou pendente.';
  }
}

export function descreverRevisaoRegistro(
  r: ResultadoRevisaoRegistro,
  ferramentas: readonly EventoFerramenta[],
  resposta: string,
  certificado?: OrientacaoCertificado
): string {
  if (r.ok && r.tipo === 'adiamento') {
    const contexto = 'Deixei a confirmação do CRM/RQE pendente para você conferir depois. ' + r.nome + ' continua vinculada à sua conta.';
    const etapaConsultada = ferramentas.some(e => ['CERTIFICADO_EXISTENTE', 'CERTIFICADO_PENDENTE', 'PRONTIDAO_VERIFICADA'].includes(e.codigo));
    const continuacao = etapaConsultada && resposta && respostaCompativelComFerramentas(resposta, ferramentas)
      ? resposta
      : (certificado ? descreverCertificado(certificado) + '\n' : '') + 'Desde quando você quer conferir os atendimentos de ' + r.nome + '?';
    return contexto + '\n' + continuacao;
  }
  if (!r.ok && r.motivo === 'NAO_APROVADO') {
    return 'Entendi, não salvei CRM nem RQE. Podemos revisar os dados quando quiser.';
  }
  if (!r.ok) {
    if (r.motivo === 'PESQUISA_OU_VINCULO_AINDA_PENDENTE') {
      return 'Primeiro preciso concluir o vínculo e a pesquisa pública do profissional. Ainda não fiz validação de CRM/RQE.';
    }
    if (['FALHA_COMPROVADA', 'ENVIO_INCERTO', 'ACEITO_SEM_ENTREGA', 'ENTREGUE', 'LIDO', 'PEDIDO_JA_PROCESSADO', 'LINK_ENTREGUE', 'LIMITE_LINKS'].includes(r.motivo)) {
      return falaEnvioRegistro(r.motivo, '');
    }
    return 'Não salvei os dados: a confirmação ou a identificação do registro ainda não está completa.';
  }
  if (r.tipo === 'correcao') {
    return falaEnvioRegistro(r.motivo, r.nome) + ' Não alterei CRM nem RQE.';
  }
  return 'Registrei os dados confirmados de ' + r.nome + ': CRM ' + r.crm +
    (r.rqe && r.rqeConfirmado !== false ? ', RQE ' + r.rqe : '') + '.' +
    (certificado ? '\n' + descreverCertificado(certificado, true) : '');
}

export function descreverEstadoSemAcao(entrada: EntradaRelatoPiloto): string {
  const confirmado = profissionalComVinculoConfirmado(entrada);
  if (!confirmado) {
    return 'Não consegui conferir o vínculo do profissional no estado atual. Antes de avançar, precisamos verificar esse vínculo na conta. A data informada não permite concluir nada sobre emissão de notas.';
  }
  const e = entrada.estadoConversa!;
  const periodo = e.periodoConferencia?.profissionalId === confirmado.id ? e.periodoConferencia : null;
  const vinculo = confirmado.nome + ' já está vinculada à sua conta.';
  const pesquisa = e.pesquisasRegistro?.[confirmado.id];
  const crm = pesquisa?.estado === 'aguardando_confirmacao' && pesquisa.confirmacaoAdiada
    ? ' A confirmação do CRM/RQE continua adiada.'
    : '';
  return vinculo + crm + ' Ainda não consultei atendimentos ou notas neste turno.\n' +
    (periodo
      ? 'O início do período solicitado é ' + periodo.inicio.split('-').reverse().join('/') + '.'
      : 'Qual é a data inicial do período que você quer conferir nos atendimentos?');
}

export function descreverPeriodoRegistrado(
  p: Extract<DecisaoPeriodo, { ok: true }>,
  certificado?: OrientacaoCertificado
): string {
  const data = p.inicio.split('-').reverse().join('/');
  return 'O período solicitado para conferir os atendimentos de ' + p.nome + ' começa em ' + data + '. ' +
    (p.conferencia ?? 'Ainda não consultei atendimentos ou notas.') +
    (certificado ? '\n' + descreverCertificado(certificado) : '');
}

export function explicarResultadoVinculo(
  v: { ok: true; nome: string; registrado: boolean; pesquisa: 'agendada' | 'ja_existe' | 'indisponivel' } | { ok: false; motivo: string },
  descoberta: EstadoConversa['descoberta']
): string {
  if (!v.ok && v.motivo === 'ESCLARECIMENTO' && descoberta?.nomes.length === 1) {
    return 'Você confirma vincular ' + descoberta.nomes[0] + ' à sua conta?';
  }
  if (!v.ok) {
    if (v.motivo === 'CONEXAO_PENDENTE' || v.motivo === 'STATUS_INDISPONIVEL') {
      return 'Ainda não confirmei o acesso necessário para vincular o profissional. Não consultei nem validei CRM ou RQE.';
    }
    if (v.motivo === 'VINCULO_JA_PROCESSADO_NO_TURNO') {
      return 'A solicitação de vínculo já foi processada neste turno. Não repeti o cadastro nem a pesquisa.';
    }
    return explicarVinculoNaoExecutado(v.motivo);
  }
  if (!v.registrado) {
    return 'O cadastro aceitou o vínculo de ' + v.nome +
      ', mas ainda não confirmei a gravação da etapa na conversa. Vou conferir essa etapa antes de pesquisar CRM/RQE.';
  }
  const confirmacao = 'Vinculei ' + v.nome + ' à sua conta.';
  if (v.pesquisa !== 'indisponivel') return confirmacao;
  return confirmacao + ' A consulta pública de CRM/RQE não está disponível para iniciar agora; não vou inventar esses dados.';
}
