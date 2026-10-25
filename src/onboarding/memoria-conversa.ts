import type pg from 'pg';
import { sanitizarTextoMedico } from './contexto-conversa-medico.js';
import { LIMITE_MENSAGENS_CONTEXTO_MEDICO } from './regras/decidir-proxima-acao.js';

/**
 * Memória persistida por médico e conversa; histórico mantém os quatro textos recentes em ordem cronológica.
 * Falas são sanitizadas; boas-vindas e balões de agenda seguem o alcance legado entre conversas.
 * Marcas contexto:* são estado estruturado e nunca entram como fala no histórico.
 * Exceção legada preservada: a marca noto:cofre_agenda:solicitado também integra a leitura textual.
 * Resumo é sanitizado, avança por ateId e não é invalidado automaticamente por novas falas.
 * limparTudoDoMedico invalida resumo, falas e marcas de todas as conversas em uma instrução atômica.
 * Leituras granulares permanecem disponíveis para preservar ordem e momento das consultas existentes.
 */
export interface MemoriaConversa {
  ler(medicoId: string, conversa: string): string[] | Promise<string[]>;
  registrar(medicoId: string, conversa: string, id: string, texto: string, papel?: 'medico' | 'noto', origemOperador?: 'medico'|'secretaria'): void | boolean | Promise<void | boolean>;
}
export type ResumoConversa = { resumo: string; ateId: string };
export type PlanoConversa = {
  objetivo: string;
  etapa: string;
  faltando: string[];
  proximosPassos: string[];
  aguardando: string | null;
};
export type EntregaNotaContexto = {
  notaFiscalId: string;
  solicitacaoId: string;
  ndps: number | null;
  paciente: string | null;
  datasConsulta: string | null;
  valorCentavos: number | null;
  destino: 'medico' | 'paciente';
  origem: 'nota_nova' | 'pedido_historico';
  resultado: 'simulado' | 'enviado' | 'erro' | 'repetido' | 'sem_contato' | 'sem_permissao';
  registradaEm: string;
};

export type ChunkConversa = {
  id: string;
  nivel: number;
  inicioId: string;
  fimId: string;
  resumo: string;
};
export type CategoriaMemoriaSemantica = 'preferencia_agenda' | 'preferencia_comunicacao' | 'rotina' | 'decisao' | 'outro';
export type MemoriaSemantica = {
  chave: string;
  categoria: CategoriaMemoriaSemantica;
  valor: string;
  origemConversa: string;
  origemMensagemId: string;
  confianca: number;
};
export type FaseTrabalhoAgente = 'iniciada' | 'concluida' | 'recusada' | 'falhou';

export class PostgresMemoriaConversaMedico implements MemoriaConversa {
  constructor(private readonly pool: pg.Pool) {}

  async lerContextoParaModelo(medicoId: string, conversa: string): Promise<{ historicoRecente: string[]; marcas: { semAgendaDigital: boolean; linkAgendaSolicitado: boolean; boasVindasComunicadas: boolean }; resumo: ResumoConversa | null; plano?: PlanoConversa; entregasRecentes: EntregaNotaContexto[]; linhaDoTempo?: ChunkConversa[]; memoriasSemanticas?: MemoriaSemantica[] }> {
    const historicoRecente = await this.ler(medicoId, conversa);
    const marcas = {
      semAgendaDigital: await this.semAgendaDigital(medicoId, conversa),
      linkAgendaSolicitado: await this.temPedidoCofre(medicoId, conversa),
      boasVindasComunicadas: await this.temBoasVindas(medicoId, conversa),
    };
    const resumo = await this.lerResumo(medicoId, conversa);
    const plano = await this.lerPlano(medicoId, conversa);
    const entregasRecentes = await this.lerEntregasRecentes(medicoId, conversa);
    // Memória longa é enriquecimento. Durante rolling deploy, ausência das tabelas novas
    // não pode derrubar o WhatsApp; o runtime volta ao contrato anterior até a migração.
    const [linhaDoTempo, memoriasSemanticas] = await Promise.all([
      this.lerChunksRaiz(medicoId, conversa).catch(() => [] as ChunkConversa[]),
      this.lerMemoriasSemanticas(medicoId).catch(() => [] as MemoriaSemantica[])
    ]);
    const base = plano ? { historicoRecente, marcas, resumo, plano, entregasRecentes } : { historicoRecente, marcas, resumo, entregasRecentes };
    return { ...base, ...(linhaDoTempo.length ? { linhaDoTempo } : {}), ...(memoriasSemanticas.length ? { memoriasSemanticas } : {}) };
  }

  registrarFala(medicoId: string, conversa: string, id: string, texto: string, papel: 'medico' | 'noto' = 'medico', origemOperador?:'medico'|'secretaria'): Promise<boolean> {
    return this.registrar(medicoId, conversa, id, texto, papel, origemOperador);
  }

  async registrarMarca(medicoId: string, conversa: string, marca: 'sem_agenda_digital' | 'link_agenda_solicitado'): Promise<void> {
    if (marca === 'sem_agenda_digital') return this.registrarSemAgendaDigital(medicoId, conversa);
    await this.registrar(medicoId, conversa, 'noto:cofre_agenda:solicitado',
      'O link seguro já foi solicitado nesta conversa. Aguardo a conexão. Isso não confirma envio.', 'noto');
  }

  registrarResumo(medicoId: string, conversa: string, resumo: string, ateId: string): Promise<void> {
    return this.gravarResumo(medicoId, conversa, resumo, ateId);
  }

  async registrarPlano(medicoId: string, conversa: string, plano: PlanoConversa): Promise<void> {
    const seguro: PlanoConversa = {
      objetivo: sanitizarTextoMedico(plano.objetivo),
      etapa: sanitizarTextoMedico(plano.etapa),
      faltando: plano.faltando.map(sanitizarTextoMedico),
      proximosPassos: plano.proximosPassos.map(sanitizarTextoMedico),
      aguardando: plano.aguardando ? sanitizarTextoMedico(plano.aguardando) : null,
    };
    await this.pool.query(`insert into conversa_mensagens (medico_id, conversa, mensagem_id, texto, papel) values ($1,$2,$3,$4,$5)
      on conflict (medico_id, mensagem_id) do update set texto=excluded.texto, papel=excluded.papel`,
      [medicoId, conversa, 'contexto:plano_cognitivo', JSON.stringify(seguro), 'noto']);
  }

  async lerPlano(medicoId: string, conversa: string): Promise<PlanoConversa | null> {
    const { rows } = await this.pool.query<{ texto: string }>(
      'select texto from conversa_mensagens where medico_id=$1 and conversa=$2 and mensagem_id=$3 limit 1',
      [medicoId, conversa, 'contexto:plano_cognitivo']);
    if (!rows[0]) return null;
    try {
      const plano = JSON.parse(rows[0].texto) as PlanoConversa;
      if (!plano?.objetivo || !plano?.etapa || !Array.isArray(plano.faltando) || !Array.isArray(plano.proximosPassos)) return null;
      return plano;
    } catch { return null; }
  }

  async registrarEntregaNota(medicoId:string,conversa:string,chave:string,entrega:EntregaNotaContexto):Promise<void> {
    const seguro:EntregaNotaContexto={
      ...entrega,
      paciente:entrega.paciente?sanitizarTextoMedico(entrega.paciente):null,
      datasConsulta:entrega.datasConsulta?sanitizarTextoMedico(entrega.datasConsulta):null
    };
    await this.pool.query(`insert into conversa_mensagens (medico_id, conversa, mensagem_id, texto, papel) values ($1,$2,$3,$4,'noto')
      on conflict (medico_id, mensagem_id) do update set conversa=excluded.conversa,texto=excluded.texto,papel='noto',criada_em=now()`,
      [medicoId,conversa,`contexto:entrega_nota:${chave}`,JSON.stringify(seguro)]);
  }

  async lerEntregasRecentes(medicoId:string,conversa:string):Promise<EntregaNotaContexto[]> {
    const {rows}=await this.pool.query<{texto:string}>(`select texto from conversa_mensagens
      where medico_id=$1 and conversa=$2 and mensagem_id like 'contexto:entrega_nota:%'
      order by id desc limit 8`,[medicoId,conversa]);
    return rows.flatMap(r=>{try{
      const e=JSON.parse(r.texto) as EntregaNotaContexto;
      return e?.notaFiscalId&&e?.solicitacaoId&&e?.destino&&e?.resultado?[e]:[];
    }catch{return [];}});
  }

  async lerChunksRaiz(medicoId:string,conversa:string):Promise<ChunkConversa[]> {
    const {rows}=await this.pool.query<{id:string;nivel:number;inicio_mensagem_id:string;fim_mensagem_id:string;resumo:string}>(`
      select id::text,nivel,inicio_mensagem_id::text,fim_mensagem_id::text,resumo from (
        select id,nivel,inicio_mensagem_id,fim_mensagem_id,resumo
        from conversa_chunks where medico_id=$1 and conversa=$2 and pai_id is null
        order by inicio_mensagem_id desc limit 16
      ) raiz order by inicio_mensagem_id asc`,[medicoId,conversa]);
    return rows.map(r=>({id:r.id,nivel:Number(r.nivel),inicioId:r.inicio_mensagem_id,fimId:r.fim_mensagem_id,resumo:sanitizarTextoMedico(r.resumo)}));
  }

  async lerChunksParaConsolidar(medicoId:string,conversa:string,nivel:number,limite=4):Promise<ChunkConversa[]> {
    const {rows}=await this.pool.query<{id:string;nivel:number;inicio_mensagem_id:string;fim_mensagem_id:string;resumo:string}>(`
      select id::text,nivel,inicio_mensagem_id::text,fim_mensagem_id::text,resumo
      from conversa_chunks where medico_id=$1 and conversa=$2 and nivel=$3 and pai_id is null
      order by inicio_mensagem_id asc limit $4`,[medicoId,conversa,nivel,limite]);
    return rows.map(r=>({id:r.id,nivel:Number(r.nivel),inicioId:r.inicio_mensagem_id,fimId:r.fim_mensagem_id,resumo:sanitizarTextoMedico(r.resumo)}));
  }

  async registrarChunk(medicoId:string,conversa:string,nivel:number,inicioId:string,fimId:string,resumo:string,filhos:string[]=[]):Promise<string|null> {
    const seguro=sanitizarTextoMedico(resumo);
    const {rows}=await this.pool.query<{id:string}>(`
      insert into conversa_chunks (medico_id,conversa,nivel,inicio_mensagem_id,fim_mensagem_id,resumo)
      values ($1,$2,$3,$4::bigint,$5::bigint,$6)
      on conflict (medico_id,conversa,nivel,inicio_mensagem_id,fim_mensagem_id)
      do update set resumo=excluded.resumo
      returning id::text`,[medicoId,conversa,nivel,inicioId,fimId,seguro]);
    const id=rows[0]?.id??null;
    if(id&&filhos.length) await this.pool.query(
      'update conversa_chunks set pai_id=$1::bigint where medico_id=$2 and conversa=$3 and id=any($4::bigint[]) and pai_id is null',
      [id,medicoId,conversa,filhos]);
    return id;
  }

  async lerMemoriasSemanticas(medicoId:string):Promise<MemoriaSemantica[]> {
    const {rows}=await this.pool.query<{chave:string;categoria:CategoriaMemoriaSemantica;valor:string;origem_conversa:string;origem_mensagem_id:string;confianca:number}>(`
      select chave,categoria,valor,origem_conversa,origem_mensagem_id::text,confianca
      from conversa_memorias_semanticas where medico_id=$1 and ativa=true
      order by atualizado_em desc limit 12`,[medicoId]);
    return rows.map(r=>({chave:r.chave,categoria:r.categoria,valor:sanitizarTextoMedico(r.valor),origemConversa:r.origem_conversa,origemMensagemId:r.origem_mensagem_id,confianca:Number(r.confianca)}));
  }

  async registrarMemoriaSemantica(medicoId:string,memoria:MemoriaSemantica):Promise<void> {
    const categoriasAutomaticas:readonly CategoriaMemoriaSemantica[]=['preferencia_agenda','preferencia_comunicacao','rotina'];
    if(!/^[a-z0-9_:-]{3,80}$/.test(memoria.chave)||memoria.confianca<.9||!categoriasAutomaticas.includes(memoria.categoria))return;
    if(/\b(?:paciente|cpf|cnpj|telefone|e-?mail|nota\s+(?:do|da)|consulta\s+(?:do|da))\b|@/i.test(memoria.valor))return;
    await this.pool.query(`
      insert into conversa_memorias_semanticas
        (medico_id,chave,categoria,valor,origem_conversa,origem_mensagem_id,confianca)
      values ($1,$2,$3,$4,$5,$6::bigint,$7)
      on conflict (medico_id,chave) do update set
        categoria=excluded.categoria,valor=excluded.valor,origem_conversa=excluded.origem_conversa,
        origem_mensagem_id=excluded.origem_mensagem_id,confianca=excluded.confianca,ativa=true,atualizado_em=now()
      where conversa_memorias_semanticas.origem_mensagem_id <= excluded.origem_mensagem_id`,
      [medicoId,memoria.chave,memoria.categoria,sanitizarTextoMedico(memoria.valor),memoria.origemConversa,memoria.origemMensagemId,memoria.confianca]);
  }

  async registrarEventoTrabalho(medicoId:string,conversa:string,chaveProcessamento:string,ferramenta:string,fase:FaseTrabalhoAgente,metadados:Record<string,unknown>={}):Promise<void> {
    await this.pool.query(`
      insert into conversa_trabalho_eventos (medico_id,conversa,chave_processamento,ferramenta,fase,metadados)
      values ($1,$2,$3,$4,$5,$6::jsonb) on conflict do nothing`,
      [medicoId,conversa,chaveProcessamento,sanitizarTextoMedico(ferramenta),fase,JSON.stringify(metadados)]);
  }

  async limparTudoDoMedico(medicoId: string): Promise<void> {
    await this.pool.query(`with mensagens_removidas as (
      delete from conversa_mensagens where medico_id=$1 returning medico_id
    ), trabalho_removido as (
      delete from conversa_trabalho_eventos where medico_id=$1 returning medico_id
    ), memorias_removidas as (
      delete from conversa_memorias_semanticas where medico_id=$1 returning medico_id
    ), chunks_removidos as (
      delete from conversa_chunks where medico_id=$1 returning medico_id
    ) delete from conversa_resumos where medico_id=$1`, [medicoId]);
  }

  async ler(medicoId: string, conversa: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ texto: string }>(
      "select texto from conversa_mensagens where medico_id=$1 and (conversa=$2 or papel='noto' and (mensagem_id='noto:boas_vindas:unica' or mensagem_id like 'noto:agenda:%')) and mensagem_id not like 'contexto:%' order by id desc limit $3",
      [medicoId, conversa, LIMITE_MENSAGENS_CONTEXTO_MEDICO]);
    return rows.reverse().map(mensagem => sanitizarTextoMedico(mensagem.texto));
  }

  async lerFalasRecentes(medicoId: string, conversa: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ texto: string }>(
      "select texto from conversa_mensagens where medico_id=$1 and conversa=$2 and papel='noto' and mensagem_id not like 'contexto:%' and criada_em > now() - interval '10 minutes' order by id desc", [medicoId, conversa]);
    return rows.map(m => sanitizarTextoMedico(m.texto));
  }

  async lerUltimaFalaNoto(medicoId: string, conversa: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ texto: string }>(
      "select texto from conversa_mensagens where medico_id=$1 and (conversa=$2 or mensagem_id='noto:boas_vindas:unica' or mensagem_id like 'noto:agenda:%') and papel='noto' and mensagem_id not like 'contexto:%' order by id desc limit 1", [medicoId, conversa]);
    return rows[0] ? sanitizarTextoMedico(rows[0].texto) : undefined;
  }

  async lerUltimasFalasNoto(medicoId: string, conversa: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ texto: string }>(
      "select texto from conversa_mensagens where medico_id=$1 and (conversa=$2 or mensagem_id='noto:boas_vindas:unica' or mensagem_id like 'noto:agenda:%') and papel='noto' and mensagem_id not like 'contexto:%' order by id desc limit 6", [medicoId, conversa]);
    return rows.flatMap(m => sanitizarTextoMedico(m.texto).split('\n')).slice(0, 6);
  }

  async registrar(medicoId: string, conversa: string, id: string, texto: string, papel: 'medico' | 'noto' = 'medico', origemOperador?:'medico'|'secretaria'): Promise<boolean> {
    const origem=papel==='medico' ? (origemOperador??'medico') : null;
    const { rows } = await this.pool.query(
      'insert into conversa_mensagens (medico_id, conversa, mensagem_id, texto, papel, origem_operador) values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning id',
      [medicoId, conversa, id, sanitizarTextoMedico(texto), papel, origem]);
    return rows.length === 1;
  }

  async temResposta(medicoId: string, conversa: string, chave: string): Promise<boolean> {
    const { rows } = await this.pool.query('select 1 from conversa_mensagens where medico_id=$1 and mensagem_id=$3 and $2::text is not null limit 1',
      [medicoId, conversa, `noto:${chave}`]);
    return rows.length > 0;
  }

  async temPedidoCofre(medicoId: string, conversa: string): Promise<boolean> {
    const { rows } = await this.pool.query('select 1 from conversa_mensagens where medico_id=$1 and mensagem_id=$3 and $2::text is not null limit 1',
      [medicoId, conversa, 'noto:cofre_agenda:solicitado']);
    return rows.length > 0;
  }

  async registrarSemAgendaDigital(medicoId: string, conversa: string): Promise<void> {
    // Marca de contexto, nunca uma fala. O upsert também corrige a marca legada no próximo reconhecimento.
    await this.pool.query(`insert into conversa_mensagens (medico_id, conversa, mensagem_id, texto, papel) values ($1,$2,$3,$4,$5)
      on conflict (medico_id, mensagem_id) do update set texto=excluded.texto, papel=excluded.papel`,
      [medicoId, conversa, 'contexto:sem_agenda_digital', JSON.stringify({ semAgendaDigital: true }), 'noto']);
  }

  async semAgendaDigital(medicoId: string, conversa: string): Promise<boolean> {
    const { rows } = await this.pool.query('select 1 from conversa_mensagens where medico_id=$1 and mensagem_id=$3 and $2::text is not null limit 1',
      [medicoId, conversa, 'contexto:sem_agenda_digital']);
    return rows.length > 0;
  }

  async temBoasVindas(medicoId: string, conversa: string): Promise<boolean> {
    const { rows } = await this.pool.query('select 1 from conversa_mensagens where medico_id=$1 and mensagem_id=$3 and $2::text is not null limit 1',
      [medicoId, conversa, 'noto:boas_vindas:unica']);
    return rows.length > 0;
  }

  async lerResumo(medicoId: string, conversa: string): Promise<ResumoConversa | null> {
    const { rows } = await this.pool.query<{ resumo: string; ate_id: string }>(
      'select resumo, ate_id::text from conversa_resumos where medico_id=$1 and conversa=$2', [medicoId, conversa]);
    return rows[0] ? { resumo: sanitizarTextoMedico(rows[0].resumo), ateId: rows[0].ate_id } : null;
  }

  async lerAntigas(medicoId: string, conversa: string, ateId: string): Promise<Array<{ id: string; texto: string; papel?: 'medico'|'noto'; origemOperador?:'medico'|'secretaria'|null }>> {
    const { rows } = await this.pool.query<{ id: string; texto: string; papel?: 'medico'|'noto'; origem_operador?:'medico'|'secretaria'|null }>(
      `select id::text, texto, papel, origem_operador from (select id, texto, papel, origem_operador from conversa_mensagens where medico_id=$1 and conversa=$2 and mensagem_id not like 'contexto:%'
        order by id desc offset $4) antigas where id > $3::bigint order by antigas.id asc`,
      [medicoId, conversa, ateId, LIMITE_MENSAGENS_CONTEXTO_MEDICO]);
    return rows.map(({origem_operador,...mensagem}) => ({ ...mensagem, origemOperador:origem_operador??null, texto: sanitizarTextoMedico(mensagem.texto) }));
  }

  async gravarResumo(medicoId: string, conversa: string, resumo: string, ateId: string): Promise<void> {
    await this.pool.query(
      `insert into conversa_resumos (medico_id, conversa, resumo, ate_id) values ($1,$2,$3,$4)
        on conflict (medico_id, conversa) do update set resumo=excluded.resumo, ate_id=excluded.ate_id, atualizado_em=now()
        where conversa_resumos.ate_id < excluded.ate_id`,
      [medicoId, conversa, sanitizarTextoMedico(resumo), ateId]);
  }
}
