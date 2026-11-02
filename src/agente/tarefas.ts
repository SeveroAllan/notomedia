/** Referências mínimas de tarefas do WhatsApp; nunca contém texto, paciente ou credencial.
 * O ✅ só é aplicado ao ID original com prova gerada por uma ferramenta real.
 */
export type TipoTarefa =
  | 'verificar_agenda' | 'conectar_agenda' | 'descobrir_profissionais'
  | 'enviar_link_agenda' | 'vincular_profissionais' | 'salvar_dados_profissionais'
  | 'verificar_prontidao' | 'verificar_certificado';

export interface TarefaPendente {
  tipo: TipoTarefa;
  instancia: string;
  mensagemId: string;
  remetenteRef: string;
  criadaEm: number;
  profissionalId?: string;
  agenda?: 'tribemd' | 'amplimed';
}
export interface ComprovanteTarefa {
  tipo: TipoTarefa;
  profissionalId: string;
  agenda?: 'tribemd' | 'amplimed';
}
const TIPOS: readonly TipoTarefa[] = [
  'verificar_agenda', 'conectar_agenda', 'descobrir_profissionais',
  'enviar_link_agenda', 'vincular_profissionais', 'salvar_dados_profissionais',
  'verificar_prontidao', 'verificar_certificado'
];
export const PRAZO_TAREFA_MS = 48 * 60 * 60 * 1000;

function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export function cancelouTarefas(texto: string): boolean {
  return /^(?:cancela(?:r)?|desista|deixa pra la|nao precisa|esquece isso|pare de fazer)(?:\b|[.!])/i.test(normalizar(texto));
}

/** Intenção explícita, nunca "emiti uma nota" ou uma pergunta apenas sobre como fazer. */
export function classificarPedidoTarefa(texto: string): TipoTarefa | null {
  const t = normalizar(texto);
  if (cancelouTarefas(t) || /^(?:como|porque|por que|qual o procedimento)\b/.test(t)) return null;
  const pedido = /\b(?:consegue|pode|poderia|quero|preciso|por favor|faz|faca|mande|envie|verifica|verifique|verificar|confere|confira|conferir|consulta|consulte|consultar|checa|cheque|procure|buscar|busque|descubra|descobrir|identifique|identificar|cadastre|cadastrar|adicione|adicionar|vincule|vincular|registre|registrar|salve|salvar|atualize|atualizar|veja|me ajude|vamos|conecte|conectar)\b/.test(t);
  if (!pedido) return null;
  if (/\b(?:nota fiscal|nfse|nfs-e)\b/.test(t) && /\b(?:emiti|emitir|emissao|cancele|cancelar)\b/.test(t)) return null;
  if (/\b(?:link|acesso)\b/.test(t) && /\b(?:agenda|tribemd|amplimed|conexao)\b/.test(t) &&
      /\b(?:envi|mand|ger|solicit|quero|preciso|pode|consegue)\w*/.test(t)) return 'enviar_link_agenda';
  if (/\b(?:adicion|cadastr|inclu|vincul)\w*/.test(t) && /\b(?:medic|profission)\w*/.test(t)) return 'vincular_profissionais';
  if (/\b(?:salv|atualiz|registr|corrig|alter)\w*/.test(t) &&
      /\b(?:crm|rqe|dados profissionais|nome completo)\b/.test(t)) return 'salvar_dados_profissionais';
  if (/\b(?:conect|integr)\w*/.test(t) && /\b(?:agenda|tribemd|amplimed)\b/.test(t) &&
      /\b(?:quero|preciso|consegue|pode|vamos|conecte|conectar)\b/.test(t) &&
      !/\b(?:verific|confer|checa|consult)\w*/.test(t)) return 'conectar_agenda';
  if (/\b(?:profissionais|medicos|medicas|quem atende|quem atendeu)\b/.test(t) &&
      /\b(?:agenda|tribemd|amplimed)\b/.test(t) &&
      /\b(?:list|descubr|identific|encontr|procur|busc|consult|verific|quais|quem)\w*/.test(t)) return 'descobrir_profissionais';
  if (/\bcertificado\b/.test(t) && /\b(?:verific|confer|consult|checa)\w*/.test(t)) return 'verificar_certificado';
  if (/\b(?:prontidao|liberado|apto|preparado)\b/.test(t) &&
      /\b(?:verific|confer|consult|checa)\w*/.test(t)) return 'verificar_prontidao';
  if (/\b(?:agenda|tribemd|amplimed|conexao|conectad)\w*/.test(t) &&
      /\b(?:verific|confer|consult|checa|veja)\w*/.test(t)) return 'verificar_agenda';
  return null;
}

/** Apenas um profissional citado de forma não ambígua; não atribui a agenda ao único cadastrado. */
export function alvoExplicito(texto: string, profissionais: readonly { id: string; nome: string }[]): string | undefined {
  const tokens = new Set(normalizar(texto).split(/[^a-z0-9]+/).filter(t => t.length >= 4));
  const encontrados = profissionais.filter(p => {
    const nomes = normalizar(p.nome).split(/[^a-z0-9]+/)
      .filter(t => t.length >= 4 && !['doutor','doutora','medico','medica'].includes(t));
    return nomes.some(nome => tokens.has(nome));
  });
  return encontrados.length === 1 ? encontrados[0]!.id : undefined;
}

export function validarTarefas(valor: unknown, agora = Date.now()): TarefaPendente[] {
  if (!Array.isArray(valor)) return [];
  return valor.filter((item): item is TarefaPendente => {
    if (!item || typeof item !== 'object') return false;
    const t = item as Record<string, unknown>;
    return TIPOS.includes(t['tipo'] as TipoTarefa) &&
      typeof t['instancia'] === 'string' && t['instancia'].length > 0 && t['instancia'].length <= 128 &&
      typeof t['mensagemId'] === 'string' && /^[A-Za-z0-9_-]{5,150}$/.test(t['mensagemId']) &&
      typeof t['remetenteRef'] === 'string' && /^[a-f0-9]{24}$/.test(t['remetenteRef']) &&
      typeof t['criadaEm'] === 'number' && Number.isFinite(t['criadaEm']) &&
      t['criadaEm'] <= agora && agora - t['criadaEm'] < PRAZO_TAREFA_MS &&
      (t['profissionalId'] === undefined || typeof t['profissionalId'] === 'string' && t['profissionalId'].length <= 150) &&
      (t['agenda'] === undefined || t['agenda'] === 'tribemd' || t['agenda'] === 'amplimed');
  }).slice(-6).map(t => ({
    tipo: t.tipo, instancia: t.instancia, mensagemId: t.mensagemId,
    remetenteRef: t.remetenteRef, criadaEm: t.criadaEm,
    ...(t.profissionalId ? { profissionalId: t.profissionalId } : {}),
    ...(t.agenda ? { agenda: t.agenda } : {})
  }));
}

export function registrarPedido(
  anteriores: readonly TarefaPendente[], pedido: TarefaPendente, agora = Date.now()
): TarefaPendente[] {
  const ativos = validarTarefas(anteriores, agora).filter(t =>
    !(t.remetenteRef === pedido.remetenteRef && t.tipo === pedido.tipo &&
      t.profissionalId === pedido.profissionalId && t.agenda === pedido.agenda) &&
    !(t.instancia === pedido.instancia && t.mensagemId === pedido.mensagemId));
  return validarTarefas([...ativos, pedido], agora);
}

/** Sem alvo explícito, exige profissional confirmado em turno posterior.
 * Havendo duas pendências compatíveis, não escolhe uma por conta própria.
 */
export function selecionarConclusao(
  pendentes: readonly TarefaPendente[], comprovantes: readonly ComprovanteTarefa[],
  instancia: string, remetenteRef: string, profissionalConfirmadoId?: string, agora = Date.now()
): TarefaPendente | null {
  const candidatas = validarTarefas(pendentes, agora).filter(t =>
    t.instancia === instancia && t.remetenteRef === remetenteRef &&
    comprovantes.some(p => p.tipo === t.tipo &&
      p.profissionalId === (t.profissionalId ?? profissionalConfirmadoId) &&
      (!t.agenda || p.agenda === t.agenda)));
  return candidatas.length === 1 ? candidatas[0]! : null;
}

export function finalizarPedido(pendentes: readonly TarefaPendente[], concluido: TarefaPendente): TarefaPendente[] {
  return pendentes.filter(p => !(p.instancia === concluido.instancia &&
    p.mensagemId === concluido.mensagemId && p.remetenteRef === concluido.remetenteRef));
}
