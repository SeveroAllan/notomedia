/**
 * Adaptador Postgres da memória conversacional em duas camadas. Isola todo o
 * SQL de `noto_memoria_mensagens` e `noto_memoria_resumos` atrás da porta
 * `MemoriaConversaRepositorio`, sempre filtrando estritamente por `conta_id`.
 */

import type pg from 'pg';
import { repararMojibakeUtf8 } from '../humanizar-saida-whatsapp.js';
import { MAX_ITENS_BUSCA_MEMORIA } from './memoria-config.js';
import type {
  AutorMemoria,
  EntradaBuscaMemoria,
  MemoriaConversaRepositorio,
  MensagemMemoria,
  ResultadoBuscaMemoria,
  ResumoMemoria
} from './memoria-repositorio.js';

interface LinhaMensagemDb {
  id: string;
  conta_id: string;
  autor: AutorMemoria;
  texto: string;
  dia_referencia: string | Date;
  criado_em: string | Date;
}

interface LinhaResumoDb {
  id: string;
  conta_id: string;
  periodo_inicio: string | Date;
  periodo_fim: string | Date;
  resumo: string;
  fatos_combinados: unknown;
  total_mensagens: number;
  criado_em: string | Date;
}

function formatarDataIso(valor: string | Date): string {
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  return String(valor).slice(0, 10);
}

function formatarTimestampIso(valor: string | Date): string {
  if (valor instanceof Date) return valor.toISOString();
  return String(valor);
}

function mapearMensagem(r: LinhaMensagemDb): MensagemMemoria {
  return {
    id: r.id,
    contaId: r.conta_id,
    autor: r.autor,
    texto: repararMojibakeUtf8(r.texto),
    diaReferencia: formatarDataIso(r.dia_referencia),
    criadoEm: formatarTimestampIso(r.criado_em)
  };
}

function mapearResumo(r: LinhaResumoDb): ResumoMemoria {
  const fatos = Array.isArray(r.fatos_combinados)
    ? r.fatos_combinados.filter((f): f is string => typeof f === 'string')
    : [];
  return {
    id: r.id,
    contaId: r.conta_id,
    periodoInicio: formatarDataIso(r.periodo_inicio),
    periodoFim: formatarDataIso(r.periodo_fim),
    resumo: r.resumo,
    fatosCombinados: fatos,
    totalMensagens: Number(r.total_mensagens),
    criadoEm: formatarTimestampIso(r.criado_em)
  };
}

export class PostgresMemoriaRepositorio implements MemoriaConversaRepositorio {
  constructor(private readonly pool: pg.Pool) {}

  async registrarMensagem(entrada: {
    contaId: string;
    autor: AutorMemoria;
    texto: string;
    diaReferencia: string;
  }): Promise<void> {
    await this.pool.query(
      `insert into public.noto_memoria_mensagens (conta_id, autor, texto, dia_referencia)
       values ($1, $2, $3, $4::date)`,
      [entrada.contaId, entrada.autor, repararMojibakeUtf8(entrada.texto), entrada.diaReferencia]
    );
  }

  async listarNaoCompactadas(contaId: string, limite: number): Promise<MensagemMemoria[]> {
    const { rows } = await this.pool.query(
      `select id, conta_id, autor, texto, dia_referencia, criado_em
         from public.noto_memoria_mensagens
        where conta_id = $1 and compactada_em is null
        order by criado_em asc
        limit $2`,
      [contaId, limite]
    );
    return (rows as LinhaMensagemDb[]).map(mapearMensagem);
  }

  async listarRecentesDoDiaOuJanela(
    contaId: string,
    diaAtual: string,
    limite: number
  ): Promise<MensagemMemoria[]> {
    // Carrega mensagens do dia atual; se ainda houver poucas hoje, mantém janela aberta não compactada.
    const { rows } = await this.pool.query(
      `select id, conta_id, autor, texto, dia_referencia, criado_em
         from (
           select id, conta_id, autor, texto, dia_referencia, criado_em
             from public.noto_memoria_mensagens
            where conta_id = $1
              and (dia_referencia = $2::date or compactada_em is null)
            order by criado_em desc
            limit $3
         ) sub
        order by criado_em asc`,
      [contaId, diaAtual, limite]
    );
    return (rows as LinhaMensagemDb[]).map(mapearMensagem);
  }

  async salvarResumoEMarcarCompactadas(entrada: {
    contaId: string;
    periodoInicio: string;
    periodoFim: string;
    resumo: string;
    fatosCombinados: string[];
    mensagemIds: readonly string[];
  }): Promise<ResumoMemoria> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(
        `insert into public.noto_memoria_resumos (
           conta_id, periodo_inicio, periodo_fim, resumo, fatos_combinados, total_mensagens
         ) values ($1, $2::date, $3::date, $4, $5::jsonb, $6)
         returning id, conta_id, periodo_inicio, periodo_fim, resumo, fatos_combinados, total_mensagens, criado_em`,
        [
          entrada.contaId,
          entrada.periodoInicio,
          entrada.periodoFim,
          entrada.resumo,
          JSON.stringify(entrada.fatosCombinados),
          entrada.mensagemIds.length
        ]
      );
      await client.query(
        `update public.noto_memoria_mensagens
            set compactada_em = now()
          where conta_id = $1 and id = any($2::uuid[])`,
        [entrada.contaId, entrada.mensagemIds]
      );
      await client.query('commit');
      return mapearResumo(rows[0] as LinhaResumoDb);
    } catch (erro) {
      await client.query('rollback').catch(() => undefined);
      throw erro;
    } finally {
      client.release();
    }
  }

  async listarResumosRecentes(contaId: string, limite: number): Promise<ResumoMemoria[]> {
    const { rows } = await this.pool.query(
      `select id, conta_id, periodo_inicio, periodo_fim, resumo, fatos_combinados, total_mensagens, criado_em
         from (
           select id, conta_id, periodo_inicio, periodo_fim, resumo, fatos_combinados, total_mensagens, criado_em
             from public.noto_memoria_resumos
            where conta_id = $1
            order by periodo_fim desc, criado_em desc
            limit $2
         ) sub
        order by periodo_inicio asc, criado_em asc`,
      [contaId, limite]
    );
    return (rows as LinhaResumoDb[]).map(mapearResumo);
  }

  async buscar(entrada: EntradaBuscaMemoria): Promise<ResultadoBuscaMemoria> {
    const limite = Math.min(Math.max(entrada.limite ?? MAX_ITENS_BUSCA_MEMORIA, 1), 20);
    const padrao = entrada.termo?.trim() ? `%${entrada.termo.trim()}%` : null;
    const dataInicio = entrada.dataInicio && /^\d{4}-\d{2}-\d{2}$/.test(entrada.dataInicio)
      ? entrada.dataInicio : null;
    const dataFim = entrada.dataFim && /^\d{4}-\d{2}-\d{2}$/.test(entrada.dataFim)
      ? entrada.dataFim : null;

    const [resumosRes, mensagensRes] = await Promise.all([
      this.pool.query(
        `select id, conta_id, periodo_inicio, periodo_fim, resumo, fatos_combinados, total_mensagens, criado_em
           from public.noto_memoria_resumos
          where conta_id = $1
            and ($2::text is null or resumo ilike $2 or fatos_combinados::text ilike $2)
            and ($3::date is null or periodo_fim >= $3::date)
            and ($4::date is null or periodo_inicio <= $4::date)
          order by periodo_fim desc, criado_em desc
          limit $5`,
        [entrada.contaId, padrao, dataInicio, dataFim, Math.min(limite, 6)]
      ),
      this.pool.query(
        `select id, conta_id, autor, texto, dia_referencia, criado_em
           from public.noto_memoria_mensagens
          where conta_id = $1
            and ($2::text is null or texto ilike $2)
            and ($3::date is null or dia_referencia >= $3::date)
            and ($4::date is null or dia_referencia <= $4::date)
          order by criado_em desc
          limit $5`,
        [entrada.contaId, padrao, dataInicio, dataFim, limite]
      )
    ]);

    return {
      resumosEncontrados: (resumosRes.rows as LinhaResumoDb[]).map(r => {
        const mapped = mapearResumo(r);
        return {
          periodo: mapped.periodoInicio === mapped.periodoFim
            ? mapped.periodoInicio
            : `${mapped.periodoInicio} a ${mapped.periodoFim}`,
          resumo: mapped.resumo,
          fatosCombinados: mapped.fatosCombinados
        };
      }),
      mensagensEncontradas: (mensagensRes.rows as LinhaMensagemDb[]).reverse().map(m => ({
        dia: formatarDataIso(m.dia_referencia),
        autor: m.autor,
        texto: m.texto
      }))
    };
  }
}
