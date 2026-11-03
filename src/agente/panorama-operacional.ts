import type pg from 'pg';

/** Resumo somente de registros fiscais já existentes; não reconcilia atendimentos. */
export interface ContagemFiscal { status: string; quantidade: number }
export interface PanoramaFiscal {
  ok: true;
  janelaDias: 30;
  profissionais: Array<{ nome: string; solicitacoes: ContagemFiscal[]; notas: ContagemFiscal[] }>;
  limite: 'REGISTROS_FISCAIS_DA_BASE';
}
export type ResultadoPanoramaFiscal = PanoramaFiscal |
  { ok: false; motivo: 'SEM_PROFISSIONAIS_CONFIRMADOS' | 'ESCOPO_NAO_CONFERIDO' | 'DADOS_FISCAIS_INDISPONIVEIS' };

type Banco = Pick<pg.Pool, 'query'>;
const estadosSolicitacao = new Set([
  'pendente', 'pronta', 'simulada', 'emitida', 'erro', 'excecao',
  'aguardando_garantia', 'pendente_cadastro', 'pronta_sem_endereco'
]);
const estadosNota = new Set(['autorizada', 'cancelada', 'erro', 'substituida']);

function validarContagens(valor: unknown, permitidos: ReadonlySet<string>): ContagemFiscal[] | null {
  if (!Array.isArray(valor)) return null;
  const vistos = new Set<string>();
  const resultado: ContagemFiscal[] = [];
  for (const item of valor) {
    if (!item || typeof item !== 'object') return null;
    const registro = item as Record<string, unknown>;
    const status = registro['status'];
    const quantidade = Number(registro['quantidade']);
    if (typeof status !== 'string' || !permitidos.has(status) || vistos.has(status) ||
        !Number.isSafeInteger(quantidade) || quantidade < 1) return null;
    vistos.add(status);
    resultado.push({ status, quantidade });
  }
  return resultado;
}

/**
 * O isolamento é aplicado novamente no SQL, mesmo quando o caller já conferiu a conta.
 * Uma falha de schema/permissão NÃO é convertida em "zero notas".
 * Nunca lê pacientes, CPF, valores, mensagens ou conteúdo de documentos.
 */
export async function consultarPanoramaFiscalDaConta(
  pool: Banco, contaId: string, medicoIds: readonly string[]
): Promise<ResultadoPanoramaFiscal> {
  const ids = [...new Set(medicoIds)];
  if (!ids.length) return { ok: false, motivo: 'SEM_PROFISSIONAIS_CONFIRMADOS' };
  if (!contaId || ids.length > 20 || ids.some(id => !id)) {
    return { ok: false, motivo: 'ESCOPO_NAO_CONFERIDO' };
  }
  try {
    const sql = [
      'select m.id, m.nome_completo,',
      'coalesce((select jsonb_agg(jsonb_build_object(',
      "'status', x.status, 'quantidade', x.total) order by x.status)",
      'from (select s.status, count(*)::int as total',
      'from public.solicitacoes_nota s',
      "where s.medico_id=m.id and s.criado_em >= now() - interval '30 days'",
      "group by s.status) x), '[]'::jsonb) as solicitacoes,",
      'coalesce((select jsonb_agg(jsonb_build_object(',
      "'status', y.status, 'quantidade', y.total) order by y.status)",
      'from (select n.status, count(*)::int as total',
      'from public.notas_fiscais n',
      "where n.medico_id=m.id and n.criado_em >= now() - interval '30 days'",
      "group by n.status) y), '[]'::jsonb) as notas",
      'from public.medicos m',
      'where m.conta_id=$1 and m.id=any($2::uuid[])',
      'order by m.nome_completo, m.id'
    ].join('\n');
    const r = await pool.query(sql, [contaId, ids]);
    if (r.rows.length !== ids.length) return { ok: false, motivo: 'ESCOPO_NAO_CONFERIDO' };
    const profissionais: PanoramaFiscal['profissionais'] = [];
    for (const item of r.rows) {
      const solicitacoes = validarContagens(item.solicitacoes, estadosSolicitacao);
      const notas = validarContagens(item.notas, estadosNota);
      if (!solicitacoes || !notas || typeof item.nome_completo !== 'string' || !item.nome_completo.trim()) {
        return { ok: false, motivo: 'DADOS_FISCAIS_INDISPONIVEIS' };
      }
      profissionais.push({ nome: item.nome_completo.trim().slice(0, 150), solicitacoes, notas });
    }
    return { ok: true, janelaDias: 30, profissionais, limite: 'REGISTROS_FISCAIS_DA_BASE' };
  } catch {
    return { ok: false, motivo: 'DADOS_FISCAIS_INDISPONIVEIS' };
  }
}

/** A IA escolhe quando consultar; os números apresentados provêm da consulta, não da redação. */
export function descreverPanoramaFiscal(resultado: PanoramaFiscal): string {
  const rotulosSolicitacao: Record<string, string> = {
    pendente: 'pendente', pronta: 'pronta', simulada: 'simulada',
    emitida: 'marcada como emitida', erro: 'com erro', excecao: 'em exceção',
    aguardando_garantia: 'aguardando garantia', pendente_cadastro: 'aguardando cadastro',
    pronta_sem_endereco: 'pronta sem endereço'
  };
  const rotulosNota: Record<string, string> = {
    autorizada: 'autorizada', cancelada: 'cancelada', erro: 'com erro', substituida: 'substituída'
  };
  const formato = (itens: ContagemFiscal[], rotulos: Record<string, string>) =>
    itens.length ? itens.map(x => x.quantidade + ' ' + rotulos[x.status]).join(', ') : 'nenhum registro';
  const total = resultado.profissionais.length;
  const linhas = resultado.profissionais.slice(0, 5).map(p =>
    p.nome + ': solicitações — ' + formato(p.solicitacoes, rotulosSolicitacao) +
    '; notas — ' + formato(p.notas, rotulosNota) + '.');
  const resto = total > 5 ? ' Há outros ' + (total - 5) + ' profissionais; podemos conferir um por vez.' : '';
  return 'Consultei os registros fiscais dos últimos 30 dias. ' + linhas.join(' ') + resto +
    ' Esses registros não mostram, por si só, quais atendimentos estão sem nota.';
}
