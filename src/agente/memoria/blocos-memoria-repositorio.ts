/**
 * Porta e implementação Postgres dos blocos de memória núcleo da conta
 * (`public.noto_memoria_blocos`). Separado da lógica pura para que o agente e
 * o consolidador Sleep-Time sejam testáveis com repositório em memória.
 */

import type pg from 'pg';
import {
  sanitizarConteudoBloco,
  type AutorBlocoMemoria,
  type BlocoMemoriaNucleo,
  type RotuloBlocoMemoria
} from './blocos-memoria-config.js';

export interface EntradaSalvarBlocoMemoria {
  contaId: string;
  rotulo: RotuloBlocoMemoria;
  conteudo: string;
  atualizadoPor: AutorBlocoMemoria;
}

export interface BlocosMemoriaRepositorio {
  listarBlocos(contaId: string): Promise<BlocoMemoriaNucleo[]>;
  salvarBloco(entrada: EntradaSalvarBlocoMemoria): Promise<BlocoMemoriaNucleo>;
}

interface LinhaBlocoSql {
  conta_id: string;
  rotulo: RotuloBlocoMemoria;
  conteudo: string;
  versao: number;
  atualizado_por: AutorBlocoMemoria;
  atualizado_em: string | Date;
}

function mapearLinhaBloco(row: LinhaBlocoSql): BlocoMemoriaNucleo {
  return {
    contaId: String(row.conta_id),
    rotulo: row.rotulo,
    conteudo: String(row.conteudo ?? ''),
    versao: Number(row.versao ?? 1),
    atualizadoPor: row.atualizado_por,
    atualizadoEm: row.atualizado_em instanceof Date
      ? row.atualizado_em.toISOString()
      : String(row.atualizado_em)
  };
}

export class PostgresBlocosMemoriaRepositorio implements BlocosMemoriaRepositorio {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  async listarBlocos(contaId: string): Promise<BlocoMemoriaNucleo[]> {
    const res = await this.pool.query(
      `select conta_id, rotulo, conteudo, versao, atualizado_por, atualizado_em
         from public.noto_memoria_blocos
        where conta_id = $1
        order by rotulo`,
      [contaId]
    );
    return (res.rows as LinhaBlocoSql[]).map(mapearLinhaBloco);
  }

  async salvarBloco(entrada: EntradaSalvarBlocoMemoria): Promise<BlocoMemoriaNucleo> {
    const conteudoSeguro = sanitizarConteudoBloco(entrada.conteudo);
    const res = await this.pool.query(
      `insert into public.noto_memoria_blocos (conta_id, rotulo, conteudo, versao, atualizado_por, atualizado_em)
       values ($1, $2, $3, 1, $4, now())
       on conflict (conta_id, rotulo) do update
         set conteudo = excluded.conteudo,
             versao = public.noto_memoria_blocos.versao + 1,
             atualizado_por = excluded.atualizado_por,
             atualizado_em = now()
       returning conta_id, rotulo, conteudo, versao, atualizado_por, atualizado_em`,
      [entrada.contaId, entrada.rotulo, conteudoSeguro, entrada.atualizadoPor]
    );
    return mapearLinhaBloco(res.rows[0] as LinhaBlocoSql);
  }
}
