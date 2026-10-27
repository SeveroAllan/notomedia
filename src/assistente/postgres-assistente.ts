import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';
import { memoriaSchema, type ContextoAssistente, type DecisaoAssistente } from './conversa.js';
import type { EntradaAssistente } from './entrada.js';
import type { DiagnosticoAssistente } from './diagnostico.js';

export type TipoTrabalho = 'conversa' | 'preparacao' | 'envio';
export interface TrabalhoAssistente {
  id: string; usuario_id: string; conta_id: string; medico_id: string | null;
  tipo: TipoTrabalho; chave: string; token: string;
  conteudo: { telefone: string; texto?: string; medicosContexto?: string[] };
}

export class PostgresAssistente {
  constructor(private readonly pool: pg.Pool, private readonly usuariosPiloto: string[]) {}

  private async transacao<T>(executar: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const resultado = await executar(client);
      await client.query('commit');
      return resultado;
    } catch (erro) {
      await client.query('rollback');
      throw erro;
    } finally { client.release(); }
  }

  async registrar(entrada: EntradaAssistente): Promise<void> {
    await this.transacao(async client => {
      const usuarios = await client.query(`select id,conta_id from usuarios where ativo=true
        and auth_user_id is not null and regexp_replace(telefone,'[^0-9]','','g')=any($1::text[])
        for share`, [entrada.telefone.startsWith('55') ? gerarVariantesTelefoneBrasileiro(entrada.telefone) : [entrada.telefone]]);
      // Telefones compartilhados/ambíguos não escolhem uma conta por conveniência.
      if (usuarios.rows.length !== 1) return;
      const usuario = usuarios.rows[0];
      if (!this.usuariosPiloto.includes(usuario.id)) return;
      const chave = `${entrada.instancia}:${entrada.mensagemId}`;
      await client.query(`insert into assistente_memorias(usuario_id,conta_id) values($1,$2)
        on conflict(usuario_id) do nothing`, [usuario.id, usuario.conta_id]);
      const trabalho = await client.query(`insert into assistente_trabalhos(usuario_id,conta_id,tipo,chave,conteudo)
        values($1,$2,'conversa',$3,$4) on conflict(usuario_id,tipo,chave) do nothing returning id`,
      [usuario.id, usuario.conta_id, chave, JSON.stringify({ telefone: entrada.telefone })]);
      if (!trabalho.rowCount) return;
      await client.query(`insert into assistente_mensagens(usuario_id,conta_id,chave,papel,texto)
        values($1,$2,$3,'cliente',$4)`, [usuario.id, usuario.conta_id, chave, entrada.texto]);
    });
  }

  async reservar(tipo: TipoTrabalho): Promise<TrabalhoAssistente | null> {
    const { rows } = await this.pool.query(`with proximo as (
      select t.id from assistente_trabalhos t join usuarios u on u.id=t.usuario_id
      and u.conta_id=t.conta_id and u.ativo=true
      where t.tipo=$1 and (t.estado='pendente' or (t.estado='executando' and t.lease_ate<now()))
      and t.usuario_id=any($3::uuid[])
      and (t.tipo<>'conversa' or not exists (
        select 1 from assistente_trabalhos anterior where anterior.usuario_id=t.usuario_id
        and anterior.tipo='conversa' and anterior.estado in ('pendente','executando')
        and (anterior.criado_em,anterior.id)<(t.criado_em,t.id)))
      and (t.tipo<>'envio' or not exists (
        select 1 from assistente_trabalhos anterior where anterior.usuario_id=t.usuario_id
        and anterior.tipo='envio' and anterior.estado in ('pendente','incerto')
        and (anterior.criado_em,anterior.id)<(t.criado_em,t.id)))
      order by t.criado_em,t.id for update of t skip locked limit 1
    ) update assistente_trabalhos t set estado=case when t.tipo='envio' then 'incerto' else 'executando' end,
      token=$2,lease_ate=now()+interval '3 minutes',atualizado_em=now()
      from proximo where t.id=proximo.id returning t.*`, [tipo, randomUUID(), this.usuariosPiloto]);
    return rows[0] ?? null;
  }

  async medicosPermitidos(trabalho: TrabalhoAssistente): Promise<Array<{ id: string; nome: string }>> {
    const { rows } = await this.pool.query(`select m.id,m.nome_completo as nome from medicos m
      join usuarios u on u.id=$1 and u.conta_id=m.conta_id and u.ativo=true
      where m.conta_id=$2
      order by m.id`, [trabalho.usuario_id, trabalho.conta_id]);
    return rows;
  }

  async contexto(trabalho: TrabalhoAssistente): Promise<ContextoAssistente> {
    const memoria = await this.pool.query(`select dados from assistente_memorias
      where usuario_id=$1 and conta_id=$2`, [trabalho.usuario_id, trabalho.conta_id]);
    const mensagens = await this.pool.query(`select papel,texto,criado_em as "criadoEm" from (
      select id,papel,texto,criado_em from assistente_mensagens where usuario_id=$1 and conta_id=$2
      and id<=(select id from assistente_mensagens where usuario_id=$1 and conta_id=$2 and chave=$3)
      order by id desc limit 20) recentes order by id`, [trabalho.usuario_id, trabalho.conta_id, trabalho.chave]);
    const medicos = await this.medicosPermitidos(trabalho);
    const trabalhos = await this.pool.query(`select id,medico_id as "medicoId",estado,resultado
      from assistente_trabalhos where usuario_id=$1 and conta_id=$2 and tipo='preparacao'
      and medico_id=any($3::uuid[]) order by criado_em desc,id desc limit 10`,
    [trabalho.usuario_id, trabalho.conta_id, medicos.map(m => m.id)]);
    return { memoria: memoriaSchema.parse(memoria.rows[0]?.dados), medicos,
      mensagens: mensagens.rows, trabalhos: trabalhos.rows };
  }

  private async conferirReserva(client: pg.PoolClient, trabalho: TrabalhoAssistente): Promise<void> {
    const reserva = await client.query(`select t.id from assistente_trabalhos t join usuarios u
      on u.id=t.usuario_id and u.conta_id=t.conta_id and u.ativo=true
      where t.id=$1 and t.usuario_id=$2 and t.conta_id=$3 and t.token=$4
      and t.estado='executando' and t.lease_ate>now() for update of t`,
    [trabalho.id, trabalho.usuario_id, trabalho.conta_id, trabalho.token]);
    if (!reserva.rowCount) throw Error('RESERVA_OBSOLETA');
  }

  private async enfileirar(client: pg.PoolClient, trabalho: TrabalhoAssistente, tipo: TipoTrabalho,
    chave: string, conteudo: unknown, medicoId: string | null = null): Promise<void> {
    await client.query(`insert into assistente_trabalhos(usuario_id,conta_id,medico_id,tipo,chave,conteudo)
      values($1,$2,$3,$4,$5,$6) on conflict(usuario_id,tipo,chave) do nothing`,
    [trabalho.usuario_id, trabalho.conta_id, medicoId, tipo, chave, JSON.stringify(conteudo)]);
  }

  async concluirConversa(trabalho: TrabalhoAssistente, decisao: DecisaoAssistente, medicosContexto: string[] = []): Promise<void> {
    // Revalida os vínculos depois da chamada ao modelo.
    const permitidos = new Set((await this.medicosPermitidos(trabalho)).map(m => m.id));
    if (decisao.consultarPreparacao.some(id => !permitidos.has(id))) throw Error('MEDICO_NAO_PERMITIDO');
    if (medicosContexto.some(id => !permitidos.has(id))) throw Error('CONTEXTO_REVOGADO');
    await this.transacao(async client => {
      await this.conferirReserva(client, trabalho);
      await client.query(`update assistente_memorias set dados=$3,atualizado_em=now()
        where usuario_id=$1 and conta_id=$2`, [trabalho.usuario_id, trabalho.conta_id, JSON.stringify(decisao.memoria)]);
      await this.enfileirar(client, trabalho, 'envio', trabalho.id, { telefone: trabalho.conteudo.telefone,
        texto: decisao.resposta, medicosContexto });
      for (const medicoId of decisao.consultarPreparacao) {
        await this.enfileirar(client, trabalho, 'preparacao', `${trabalho.id}:${medicoId}`,
          { telefone: trabalho.conteudo.telefone }, medicoId);
      }
      await client.query(`update assistente_trabalhos set estado='concluido',resultado=$2,atualizado_em=now()
        where id=$1`, [trabalho.id, JSON.stringify({ memoria: decisao.memoria, consultarPreparacao: decisao.consultarPreparacao })]);
    });
  }

  async concluirPreparacao(trabalho: TrabalhoAssistente, resultado: unknown): Promise<void> {
    await this.transacao(async client => {
      await this.conferirReserva(client, trabalho);
      await client.query(`update assistente_trabalhos set estado='concluido',resultado=$2,atualizado_em=now()
        where id=$1`, [trabalho.id, JSON.stringify(resultado)]);
      const chave = `resultado:${trabalho.id}`;
      await client.query(`insert into assistente_mensagens(usuario_id,conta_id,chave,papel,texto)
        values($1,$2,$3,'sistema',$4) on conflict(usuario_id,chave) do nothing`,
      [trabalho.usuario_id, trabalho.conta_id, chave, `A consulta de preparação ${trabalho.id} terminou. Consulte o resultado estruturado dos trabalhos antes de responder.`]);
      await this.enfileirar(client, trabalho, 'conversa', chave, { telefone: trabalho.conteudo.telefone });
    });
  }

  async destinoPermitido(trabalho: TrabalhoAssistente): Promise<boolean> {
    const telefone = trabalho.conteudo.telefone;
    const { rows } = await this.pool.query(`select id,conta_id from usuarios where ativo=true
      and auth_user_id is not null and regexp_replace(telefone,'[^0-9]','','g')=any($1::text[])`,
    [telefone.startsWith('55') ? gerarVariantesTelefoneBrasileiro(telefone) : [telefone]]);
    if (rows.length !== 1 || rows[0].id !== trabalho.usuario_id || rows[0].conta_id !== trabalho.conta_id) return false;
    const permitidos = new Set((await this.medicosPermitidos(trabalho)).map(m => m.id));
    return (trabalho.conteudo.medicosContexto ?? []).every(id => permitidos.has(id));
  }

  async confirmarEnvio(trabalho: TrabalhoAssistente, mensagemId: string): Promise<void> {
    await this.transacao(async client => {
      const confirmado = await client.query(`update assistente_trabalhos set estado='concluido',
        resultado=$3,atualizado_em=now() where id=$1 and token=$2 and estado='incerto' returning id`,
      [trabalho.id, trabalho.token, JSON.stringify({ mensagemId })]);
      if (!confirmado.rowCount) throw Error('RESERVA_OBSOLETA');
      await client.query(`insert into assistente_mensagens(usuario_id,conta_id,chave,papel,texto)
        values($1,$2,$3,'noto',$4) on conflict(usuario_id,chave) do nothing`,
      [trabalho.usuario_id, trabalho.conta_id, `saida:${trabalho.id}`, trabalho.conteudo.texto]);
    });
  }

  async registrarDiagnosticoEnvio(trabalho: TrabalhoAssistente, diagnostico: DiagnosticoAssistente): Promise<void> {
    await this.pool.query(`update assistente_trabalhos set resultado=coalesce(resultado,'{}'::jsonb)
      || jsonb_build_object('diagnostico',$3::jsonb),atualizado_em=now()
      where id=$1 and token=$2 and estado='incerto'`, [trabalho.id, trabalho.token, JSON.stringify(diagnostico)]);
  }

  async falhar(trabalho: TrabalhoAssistente, diagnostico: DiagnosticoAssistente): Promise<void> {
    await this.transacao(async client => {
      const falhou = await client.query(`update assistente_trabalhos set estado='falhou',
        resultado=$3,atualizado_em=now()
        where id=$1 and token=$2 and estado='executando' and lease_ate>now() returning id`,
      [trabalho.id, trabalho.token, JSON.stringify({ codigo: 'TRABALHO_NAO_CONCLUIDO', diagnostico })]);
      if (!falhou.rowCount) return;
      await this.enfileirar(client, trabalho, 'envio', `falha:${trabalho.id}`, { telefone: trabalho.conteudo.telefone,
        texto: 'Não consegui concluir esse pedido. A execução parou e não está sendo retomada automaticamente.' });
    });
  }
}
