import type pg from 'pg';
import type { ContextoPendencias, RepositorioContextoPendencias } from '../../onboarding/pendencias-medico.js';
export class PostgresContextoPendencias implements RepositorioContextoPendencias {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}
  async ler(medicoId: string): Promise<ContextoPendencias> {
    const { rows } = await this.pool.query('select data_inicio::text, aguardando_data, ultimo_aviso, sync_estado from public.noto_contexto_pendencias where medico_id=$1', [medicoId]);
    return { dataInicio: rows[0]?.data_inicio ?? null, aguardandoData: rows[0]?.aguardando_data === true, ultimoAviso: rows[0]?.ultimo_aviso ?? null, syncAtiva: rows[0]?.sync_estado === 'executando' };
  }
  async perguntarData(medicoId: string) {
    const { rows } = await this.pool.query(`insert into public.noto_contexto_pendencias (medico_id, aguardando_data) values ($1,true)
      on conflict (medico_id) do update set aguardando_data=true, atualizado_em=now()
      where not noto_contexto_pendencias.aguardando_data returning medico_id`, [medicoId]);
    return rows.length === 1;
  }
  async definirInicio(medicoId: string, data: string) {
    await this.pool.query(`insert into public.noto_contexto_pendencias (medico_id,data_inicio) values ($1,$2)
      on conflict (medico_id) do update set data_inicio=$2, aguardando_data=false,
      atualizado_em=case when noto_contexto_pendencias.sync_estado='executando' then noto_contexto_pendencias.atualizado_em else now() end`, [medicoId, data]);
  }
  async reservarSync(medicoId: string, chave: string) {
    const { rows } = await this.pool.query(`insert into public.noto_contexto_pendencias (medico_id,chave_sync,sync_estado) values ($1,$2,'executando')
      on conflict (medico_id) do update set chave_sync=$2, sync_estado='executando', atualizado_em=now()
      where noto_contexto_pendencias.chave_sync is distinct from $2 and (noto_contexto_pendencias.sync_estado is distinct from 'executando' or noto_contexto_pendencias.atualizado_em < now()-interval '10 minutes') returning medico_id`, [medicoId, chave]);
    return rows.length === 1;
  }
  async concluirSync(medicoId: string, chave: string, sucesso: boolean) {
    await this.pool.query(`update public.noto_contexto_pendencias set sync_estado=$3, atualizado_em=now() where medico_id=$1 and chave_sync=$2`, [medicoId, chave, sucesso ? 'concluida' : 'erro']);
  }
  async registrarAviso(medicoId: string, texto: string) {
    await this.pool.query('update public.noto_contexto_pendencias set ultimo_aviso=$2 where medico_id=$1', [medicoId, texto]);
  }
}
