import type pg from 'pg';
import { nomeProfissionalValido } from '../conta/validar-dados-emissao.js';
import type { AgendaEscolhida } from './estado-conversa.js';

export type MotivoConferencia =
  'ESCOPO_NAO_CONFERIDO' | 'MEDICO_NAO_CONFIRMADO' | 'LEITURA_INCOMPLETA' |
  'IDENTIDADE_INCOMPLETA' | 'REFERENCIAS_AMBIGUAS' | 'RECORTE_MUITO_GRANDE' |
  'INTEGRACAO_INDISPONIVEL' | 'CONCILIACAO_INDISPONIVEL';

export type LeituraParaConferencia =
  | { ok: true; agenda: AgendaEscolhida; totalRealizados: number;
      /** Apenas IDs de consultas verificadas do profissional, nunca dados de pacientes. */
      referencias: string[]; semReferencia: number }
  | { ok: false; motivo: MotivoConferencia };

export type ResultadoConferencia =
  | { ok: true; agenda: AgendaEscolhida; profissional: string; janelaDias: 30;
      realizados: number; comReferencia: number; semReferencia: number;
      comVinculoConfirmado: number; comSolicitacaoVinculada: number;
      comNotaAutorizadaVinculada: number; semVinculoConfirmado: number;
      limite: 'VINCULOS_EXATOS_NAO_COMPROVAM_AUSENCIA_DE_NOTA' }
  | { ok: false; motivo: MotivoConferencia };

type Banco = Pick<pg.Pool, 'query'>;
const LIMITE = 200;

function seguroInteiro(valor: unknown): number | null {
  const numero = Number(valor);
  return Number.isSafeInteger(numero) && numero >= 0 ? numero : null;
}

/**
 * Diagnóstico somente leitura e sem pacientes. Nomes e escopo validados pelo banco
 * ANTES de abrir o navegador; agendamentos só correspondem por origem + ID externo
 * e identidade do profissional confirmada. Nenhuma comparação por paciente, data
 * aproximada, telefone ou valor pode criar um vínculo fiscal.
 */
export async function conferirAgendaComFiscal(
  pool: Banco, contaId: string, medicoId: string, agenda: AgendaEscolhida,
  lerAgenda: (medicoId: string, nome: string, agenda: AgendaEscolhida) => Promise<LeituraParaConferencia>
): Promise<ResultadoConferencia> {
  if (!contaId || !medicoId || !['tribemd', 'amplimed'].includes(agenda)) {
    return { ok: false, motivo: 'ESCOPO_NAO_CONFERIDO' };
  }
  let nome: string;
  try {
    const autorizado = await pool.query(
      'select nome_completo from public.medicos where conta_id=$1 and id=$2 limit 2',
      [contaId, medicoId]
    );
    if (autorizado.rows.length !== 1 || !nomeProfissionalValido(autorizado.rows[0]?.nome_completo)) {
      return { ok: false, motivo: 'MEDICO_NAO_CONFIRMADO' };
    }
    nome = autorizado.rows[0].nome_completo;
  } catch {
    return { ok: false, motivo: 'CONCILIACAO_INDISPONIVEL' };
  }

  let leitura: LeituraParaConferencia;
  try { leitura = await lerAgenda(medicoId, nome, agenda); }
  catch { return { ok: false, motivo: 'INTEGRACAO_INDISPONIVEL' }; }
  if (!leitura.ok) return leitura;
  if (leitura.agenda !== agenda) return { ok: false, motivo: 'LEITURA_INCOMPLETA' };
  const referencias = leitura.referencias;
  if (!Number.isSafeInteger(leitura.totalRealizados) || leitura.totalRealizados < 0 ||
      !Number.isSafeInteger(leitura.semReferencia) || leitura.semReferencia < 0 ||
      !Array.isArray(referencias) ||
      referencias.some(id => typeof id !== 'string' || !id.trim() || id.length > 250) ||
      referencias.length + leitura.semReferencia !== leitura.totalRealizados) {
    return { ok: false, motivo: 'LEITURA_INCOMPLETA' };
  }
  if (referencias.length > LIMITE || leitura.totalRealizados > LIMITE) {
    return { ok: false, motivo: 'RECORTE_MUITO_GRANDE' };
  }
  if (new Set(referencias).size !== referencias.length) {
    return { ok: false, motivo: 'REFERENCIAS_AMBIGUAS' };
  }

  let comVinculo = 0, comSolicitacao = 0, comNota = 0;
  if (referencias.length) {
    try {
      const sql = [
        'select a.referencia_externa,',
        'count(distinct a.id)::int as vinculos,',
        'count(distinct s.id)::int as solicitacoes,',
        "count(distinct n.id) filter (where n.status='autorizada')::int as notas_autorizadas",
        'from public.medicos m',
        'join public.agendamentos a on a.medico_id=m.id',
        'and a.identificacao_profissional_confirmada=true',
        'left join public.solicitacao_nota_agendamentos sna',
        'on sna.agendamento_id=a.id and sna.medico_id=m.id',
        'left join public.solicitacoes_nota s',
        'on s.id=sna.solicitacao_id and s.medico_id=m.id',
        'left join public.notas_fiscais n',
        'on n.solicitacao_id=s.id and n.medico_id=m.id',
        'where m.conta_id=$1 and m.id=$2',
        'and a.origem=$3 and a.referencia_externa=any($4::text[])',
        'group by a.referencia_externa'
      ].join('\n');
      const resultado = await pool.query(sql, [contaId, medicoId, agenda, referencias]);
      const esperadas = new Set(referencias), vistas = new Set<string>();
      for (const linha of resultado.rows) {
        const id = linha.referencia_externa;
        const vinculos = seguroInteiro(linha.vinculos);
        const solicitacoes = seguroInteiro(linha.solicitacoes);
        const notas = seguroInteiro(linha.notas_autorizadas);
        if (typeof id !== 'string' || !esperadas.has(id) || vistas.has(id) ||
            vinculos !== 1 || solicitacoes === null || notas === null ||
            solicitacoes > 1 || notas > solicitacoes) {
          return { ok: false, motivo: 'REFERENCIAS_AMBIGUAS' };
        }
        vistas.add(id);
        comVinculo++;
        if (solicitacoes > 0) comSolicitacao++;
        if (notas > 0) comNota++;
      }
    } catch {
      return { ok: false, motivo: 'CONCILIACAO_INDISPONIVEL' };
    }
  }
  return {
    ok: true, agenda, profissional: nome, janelaDias: 30,
    realizados: leitura.totalRealizados, comReferencia: referencias.length,
    semReferencia: leitura.semReferencia, comVinculoConfirmado: comVinculo,
    comSolicitacaoVinculada: comSolicitacao, comNotaAutorizadaVinculada: comNota,
    semVinculoConfirmado: referencias.length - comVinculo,
    limite: 'VINCULOS_EXATOS_NAO_COMPROVAM_AUSENCIA_DE_NOTA'
  };
}

export function descreverConferencia(resultado: ResultadoConferencia): string {
  if (!resultado.ok) {
    switch (resultado.motivo) {
      case 'MEDICO_NAO_CONFIRMADO':
      case 'ESCOPO_NAO_CONFERIDO':
        return 'Ainda não consegui confirmar qual profissional desta conta posso consultar. Preciso dessa identificação antes de conferir a agenda.';
      case 'IDENTIDADE_INCOMPLETA':
        return 'A agenda não identificou com segurança o profissional responsável por todas as consultas. Não atribuí atendimentos por suposição.';
      case 'LEITURA_INCOMPLETA':
      case 'RECORTE_MUITO_GRANDE':
        return 'A agenda não trouxe cobertura suficiente para uma conferência segura. Não vou apresentar números parciais como se fossem completos.';
      case 'REFERENCIAS_AMBIGUAS':
        return 'Encontrei referências de atendimentos repetidas ou incompatíveis. Suspendi a conferência fiscal para evitar associações erradas.';
      case 'CONCILIACAO_INDISPONIVEL':
        return 'Consegui iniciar a conferência, mas não pude verificar os vínculos fiscais no banco. Isso não significa que existam notas faltando.';
      default:
        return 'Não consegui confirmar a leitura da agenda agora. Mantive o trabalho sem presumir atendimentos ou notas pendentes.';
    }
  }
  const fonte = resultado.agenda === 'tribemd' ? 'TribeMD' : 'Amplimed';
  return 'Na ' + fonte + ', conferi os últimos 30 dias de ' + resultado.profissional + '. ' +
    'Atendimentos realizados identificados: ' + resultado.realizados + '. ' +
    'Com vínculo exato e confirmado no Noto: ' + resultado.comVinculoConfirmado + '. ' +
    'Com solicitação fiscal ligada: ' + resultado.comSolicitacaoVinculada + '. ' +
    'Com nota autorizada ligada: ' + resultado.comNotaAutorizadaVinculada + '. ' +
    'Sem vínculo fiscal comprovado aqui: ' +
    (resultado.semVinculoConfirmado + resultado.semReferencia) + '. ' +
    'Isso não significa que estejam sem nota: podem existir documentos fora dos vínculos registrados. Não emiti nem alterei nada.';
}
