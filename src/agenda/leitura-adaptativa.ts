import { z } from 'zod';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';

/** Contrato comum de um adaptador de agenda (TribeMD, Amplimed, gerado). Só leitura. */
export const consultaAdaptadorSchema = z.object({
  idExterno: z.string().min(1),
  dataHora: z.string().min(1),
  profissional: z.string().trim().min(1).max(120),
  status: z.enum(['realizada', 'cancelada', 'faltou', 'agendada']),
  tipoCobranca: z.enum(['particular', 'cortesia', 'convenio', 'desconhecido']),
  valorCentavos: z.number().int().nonnegative().nullable(),
  telefone: z.string().nullable(),
  pacienteNome: z.string().trim().min(1).max(200)
}).strict();
export type ConsultaAdaptador = z.infer<typeof consultaAdaptadorSchema>;

export interface LeituraAdaptador {
  consultas: unknown[];
  /** Totais que a própria tela mostra, quando existirem. */
  totaisTela?: { atendimentos?: number; valorCentavos?: number };
  janela: { inicio: string; fim: string };
}
export type Problema = { codigo: string; idExterno?: string };
export interface ResultadoChecagem { consultas: ConsultaAdaptador[]; problemas: Problema[]; confiavel: boolean }

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/** Checagens de consistência. Qualquer problema torna a leitura não confiável: vira pergunta ao médico, nunca palpite. */
export function checarLeitura(leitura: LeituraAdaptador, profissionaisConfirmados: string[]): ResultadoChecagem {
  const problemas: Problema[] = [], consultas: ConsultaAdaptador[] = [], ids = new Set<string>();
  const permitidos = new Set(profissionaisConfirmados.map(norm));
  for (const bruto of leitura.consultas) {
    const r = consultaAdaptadorSchema.safeParse(bruto);
    if (!r.success) { problemas.push({ codigo: 'FORMATO_INVALIDO', idExterno: (bruto as { idExterno?: string })?.idExterno }); continue; }
    const c = r.data, t = Date.parse(c.dataHora), d = c.dataHora.slice(0, 10);
    if (ids.has(c.idExterno)) { problemas.push({ codigo: 'DUPLICADA', idExterno: c.idExterno }); continue; }
    ids.add(c.idExterno);
    if (!Number.isFinite(t) || d < leitura.janela.inicio || d > leitura.janela.fim) problemas.push({ codigo: 'FORA_DA_JANELA', idExterno: c.idExterno });
    if (!permitidos.has(norm(c.profissional))) problemas.push({ codigo: 'PROFISSIONAL_DESCONHECIDO', idExterno: c.idExterno });
    if (c.telefone && !gerarVariantesTelefoneBrasileiro(c.telefone).length) problemas.push({ codigo: 'TELEFONE_INVALIDO', idExterno: c.idExterno });
    if (c.telefone && !/^\d{10,13}$/.test(c.telefone.replace(/\D/g, ''))) problemas.push({ codigo: 'TELEFONE_INVALIDO', idExterno: c.idExterno });
    if (c.tipoCobranca === 'particular' && (c.valorCentavos === null || c.valorCentavos <= 0)) problemas.push({ codigo: 'VALOR_PARTICULAR_AUSENTE', idExterno: c.idExterno });
    if (c.valorCentavos !== null && c.valorCentavos > 5_000_000) problemas.push({ codigo: 'VALOR_IMPLAUSIVEL', idExterno: c.idExterno });
    consultas.push(c);
  }
  const tela = leitura.totaisTela;
  if (tela?.atendimentos !== undefined && tela.atendimentos !== leitura.consultas.length) problemas.push({ codigo: 'TOTAL_ATENDIMENTOS_DIVERGE' });
  if (tela?.valorCentavos !== undefined && tela.valorCentavos !== consultas.reduce((s, c) => s + (c.valorCentavos ?? 0), 0)) problemas.push({ codigo: 'TOTAL_VALOR_DIVERGE' });
  return { consultas, problemas, confiavel: problemas.length === 0 };
}

/** Cortesia, valor zero e convênio ficam fora até haver regra aprovada; só aparecem no aviso. */
export function separarElegiveis(consultas: ConsultaAdaptador[]) {
  const elegiveis = consultas.filter(c => c.status === 'realizada' && c.tipoCobranca === 'particular' && (c.valorCentavos ?? 0) > 0);
  const fora = consultas.filter(c => c.status === 'realizada' && !elegiveis.includes(c));
  return { elegiveis, foraCortesia: fora.filter(c => c.tipoCobranca === 'cortesia' || c.valorCentavos === 0).length, foraOutros: fora.filter(c => c.tipoCobranca !== 'cortesia' && c.valorCentavos !== 0).length };
}

/** Amostra para o médico conferir uma vez: poucos atendimentos, espalhados entre profissionais, sem telefone nem CPF. */
export function montarAmostraConferencia(consultas: ConsultaAdaptador[], max = 5) {
  const porProf = new Map<string, ConsultaAdaptador[]>();
  for (const c of consultas) porProf.set(c.profissional, [...(porProf.get(c.profissional) ?? []), c]);
  const amostra: ConsultaAdaptador[] = [];
  for (let i = 0; amostra.length < max; i++) {
    let achou = false;
    for (const lista of porProf.values()) if (lista[i] && amostra.length < max) { amostra.push(lista[i]); achou = true; }
    if (!achou) break;
  }
  return amostra.map(c => ({ idExterno: c.idExterno, dataHora: c.dataHora, profissional: c.profissional, status: c.status, tipoCobranca: c.tipoCobranca, valorCentavos: c.valorCentavos }));
}

/** Modo observação: resultado só para conferência, nunca cria nota, lote ou envio. */
export type ModoLeitor = 'observacao' | 'aprovado';
export function podeGerarNota(modo: ModoLeitor, aprovadoPeloMedico: boolean) { return modo === 'aprovado' && aprovadoPeloMedico; }

/** Só GET/HEAD de navegação e nada que pareça ação. */
export function requisicaoSomenteLeitura(metodo: string, caminho: string) {
  if (!['GET', 'HEAD'].includes(metodo.toUpperCase())) return false;
  return !/(?:^|\/)(?:logout|delete|remove|update|create|save|excluir|salvar|editar|novo|cancelar)(?:\/|$)/i.test(caminho);
}
