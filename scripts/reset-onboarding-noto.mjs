import pg from 'pg';
import { parseArgs } from 'node:util';

const candidato = {
  projeto: 'orsrfydizyylyycmyjcd',
  conta: '15649ef7-af76-4684-a036-90a50a88d67c',
  telefone: '5551981936133',
  usuario: '8f8cc5cb-e94d-4943-b959-234a99bb2633',
  medicos: ['1f434344-4a5d-4ccd-8d96-11325d2a2aa5', 'aeab12d5-6d5c-4f9f-a0f8-b644701df961']
};

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean' },
    'confirmar-execucao': { type: 'boolean' },
    'conta-id': { type: 'string' },
    'medico-id': { type: 'string' },
    telefone: { type: 'string' }
  }
});

const executar = values['confirmar-execucao'] === true;
const medicoId = values['medico-id'] ?? candidato.medicos[1];
const digitos = (values.telefone ?? candidato.telefone).replace(/\D/g, '');
const telefone = digitos.length === 11 ? '55' + digitos : digitos;
if ((executar && (values['dry-run'] || values['conta-id'] !== candidato.conta || !values.telefone)) ||
    (values['conta-id'] && values['conta-id'] !== candidato.conta) ||
    !candidato.medicos.includes(medicoId) || telefone !== candidato.telefone) {
  console.error('Alvo inválido. A exclusão exige --confirmar-execucao --conta-id e --telefone explícitos.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL deve apontar para o banco de homologação.');
  process.exit(1);
}
let destinoBanco;
try {
  destinoBanco = new URL(process.env.DATABASE_URL);
} catch {
  console.error('DATABASE_URL inválida.');
  process.exit(1);
}
const projetoCorreto = destinoBanco.hostname === `db.${candidato.projeto}.supabase.co` ||
  (destinoBanco.hostname.endsWith('.pooler.supabase.com') &&
    decodeURIComponent(destinoBanco.username) === `postgres.${candidato.projeto}`);
if (!projetoCorreto) {
  console.error('DATABASE_URL não identifica o projeto de homologação autorizado.');
  process.exit(1);
}

const telefoneLocal = telefone.slice(2);
const telefoneSemNono = telefoneLocal.slice(0, 2) + telefoneLocal.slice(3);
const variantesTelefone = [telefone, telefoneLocal, '55' + telefoneSemNono, telefoneSemNono];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
const identificador = nome => '"' + nome.replaceAll('"', '""') + '"';
try {
  await client.connect();
  await client.query(executar ? 'begin isolation level serializable' : 'begin isolation level repeatable read read only');
  await client.query('set local row_security = off');
  await client.query("set local lock_timeout = '5s'");
  await client.query("set local statement_timeout = '30s'");
  if (executar) {
    await client.query('select id from public.contas where id=$1 for update', [candidato.conta]);
    await client.query('select id from public.usuarios where conta_id=$1 for update', [candidato.conta]);
    await client.query('select id from public.medicos where conta_id=$1 for update', [candidato.conta]);
  }
  const { rows: [alvo] } = await client.query(
    'select id, conta_id, usuario_id, nome_completo from public.medicos where id=$1', [medicoId]);
  if (alvo?.conta_id !== candidato.conta) throw new Error('MEDICO_FORA_DA_CONTA_CANDIDATA');
  const contaId = alvo.conta_id;
  const { rows: [conta] } = await client.query('select id,nome,tipo from public.contas where id=$1', [contaId]);
  const { rows: usuarios } = await client.query(
    'select id,nome,telefone,papel,ativo,auth_user_id is not null as autenticado from public.usuarios where conta_id=$1 order by id', [contaId]);
  const { rows: destinos } = await client.query(`
    select distinct conta_id from public.usuarios
    where ativo and auth_user_id is not null and conta_id is not null
    and regexp_replace(telefone,'[^0-9]','','g')=any($1::text[])`, [variantesTelefone]);
  const { rows: medicos } = await client.query(
    'select id,nome_completo,usuario_id from public.medicos where conta_id=$1 order by id', [contaId]);
  const { rows: whatsapp } = await client.query(
    'select id,medico_id,numero_telefone,oficial,status from public.whatsapp_instancias where conta_id=$1 order by id', [contaId]);
  const { rows: conversas } = await client.query(`
    select estado->>'faseAgenda' as fase, estado->>'agendaEscolhida' as agenda,
      estado->>'profissionalConfirmadoId' as profissional, estado->'periodoConferencia' as periodo,
      estado->>'perguntaPendente' as pergunta_pendente,
      estado->'pesquisasRegistro'->($2::text)->>'estado' as revisao_do_alvo,
      array(select jsonb_object_keys(estado) order by 1) as campos
    from public.noto_agent_conversas where conta_id=$1`, [contaId, medicoId]);

  const { rows: tabelas } = await client.query(`
    select c.table_name as tabela, array_agg(c.column_name::text) as colunas
    from information_schema.columns c join information_schema.tables t using(table_schema,table_name)
    where c.table_schema='public' and t.table_type='BASE TABLE'
      and c.column_name in ('conta_id','medico_id','usuario_id') and c.udt_name='uuid'
    group by c.table_name order by c.table_name`);
  const contagens = [];
  const vinculosCruzados = [];
  for (const { tabela, colunas } of tabelas) {
    const filtros = [];
    const parametros = [];
    if (colunas.includes('conta_id')) {
      parametros.push(contaId);
      filtros.push('conta_id=$' + parametros.length);
    }
    if (colunas.includes('medico_id')) {
      parametros.push(medicos.map(medico => medico.id));
      filtros.push('medico_id=any($' + parametros.length + '::uuid[])');
    }
    if (colunas.includes('usuario_id')) {
      parametros.push(usuarios.map(usuario => usuario.id));
      filtros.push('usuario_id=any($' + parametros.length + '::uuid[])');
    }
    if (colunas.includes('conta_id') && filtros.length > 1) {
      const { rows } = await client.query(
        'select 1 from public.' + identificador(tabela) +
        ' where conta_id is distinct from $1 and (' + filtros.slice(1).join(' or ') + ') limit 1', parametros);
      if (rows.length) vinculosCruzados.push(tabela);
    }
    let contagemAlvo = 'null::int';
    if (colunas.includes('medico_id')) {
      parametros.push(medicoId);
      contagemAlvo = 'count(*) filter(where medico_id=$' + parametros.length + ')::int';
    }
    const { rows: [contagem] } = await client.query(
      'select count(*)::int as conta,' + contagemAlvo + ' as medico_alvo from public.' +
      identificador(tabela) + ' where ' + filtros.join(' or '), parametros);
    contagens.push({ tabela, ...contagem });
  }

  const { rows: indiretas } = await client.query(`
    select 'faturas_assinatura' as tabela,count(*)::int as conta
      from public.faturas_assinatura f join public.assinaturas a on a.id=f.assinatura_id where a.conta_id=$1
    union all select 'cofre_links_auditoria',count(*)::int
      from public.cofre_links_auditoria a join public.cofre_links l on l.id=a.link_id
      where l.conta_id=$1 or l.medico_id=any($2::uuid[])
    union all select 'cofre_links_entregas',count(*)::int
      from public.cofre_links_entregas e join public.cofre_links l on l.id=e.link_id
      where l.conta_id=$1 or l.medico_id=any($2::uuid[])
    union all select 'cadastro_certificado_respostas',count(*)::int
      from public.cadastro_certificado_respostas r join public.cadastro_certificado_trabalhos t on t.id=r.trabalho_id
      where t.medico_id=any($2::uuid[])
    union all select 'cadastro_certificado_avisos',count(*)::int
      from public.cadastro_certificado_avisos a join public.cadastro_certificado_trabalhos t on t.id=a.trabalho_id
      where t.medico_id=any($2::uuid[])
    union all select 'otp_verificacoes',count(*)::int from public.otp_verificacoes
      where regexp_replace(telefone,'[^0-9]','','g')=any($3::text[])
  `, [contaId, medicos.map(medico => medico.id),
    [...new Set([...variantesTelefone, ...usuarios.map(u => u.telefone?.replace(/\D/g, '')).filter(Boolean)])]]);
  const { rows: chavesEstrangeiras } = await client.query(`
    select conrelid::regclass::text as tabela, confrelid::regclass::text as referencia,
      pg_get_constraintdef(oid) as regra
    from pg_constraint where contype='f' and connamespace='public'::regnamespace
      and (conrelid in (select oid from pg_class where relnamespace='public'::regnamespace and relname=any($1::text[]))
        or confrelid in ('public.contas'::regclass,'public.medicos'::regclass,'public.usuarios'::regclass))
    order by 1,2,3
  `, [[...contagens, ...indiretas].map(linha => linha.tabela)]);

  const vinculosConferem = usuarios.length === 1 && usuarios[0].id === candidato.usuario &&
    medicos.length === candidato.medicos.length &&
    medicos.every(medico => candidato.medicos.includes(medico.id));
  const telefoneConfere = destinos.length === 1 && destinos[0].conta_id === contaId;
  console.log(JSON.stringify({
    modo: executar ? 'VALIDACAO_EXECUCAO' : 'DRY_RUN', projeto: candidato.projeto, conta, alvo, telefoneConsultado: telefone, telefoneConfere, vinculosConferem,
    contasEncontradasPorTelefone: destinos.map(destino => destino.conta_id),
    usuarios, medicos, whatsapp, conversas, contagens, indiretas, vinculosCruzados, chavesEstrangeiras
  }, null, 2));
  if (!telefoneConfere || !vinculosConferem) throw new Error('MAPA_DIVERGENTE');
  if (executar) {
    // O inventário candidato está vazio de dados clínicos e fiscais. Um novo
    // vínculo fora deste inventário exige revisar o escopo antes de excluir.
    const tabelasAutorizadas = new Set([
      'usuarios', 'medicos', 'whatsapp_instancias', 'cofre_links', 'auditoria',
      'noto_agent_conversas', 'noto_agent_mensagens', 'noto_boas_vindas_pareamento',
      'noto_agent_trabalhos', 'cofre_links_auditoria', 'cofre_links_entregas', 'otp_verificacoes'
    ]);
    if ([...contagens, ...indiretas].some(linha => linha.conta > 0 && !tabelasAutorizadas.has(linha.tabela))) {
      throw new Error('DEPENDENCIA_FORA_DO_MAPA');
    }
    if (vinculosCruzados.length) throw new Error('VINCULO_EM_OUTRA_CONTA');

    // As únicas cascatas com linhas neste mapa são os vínculos públicos e
    // os recibos do Cofre. Uma FK nova pode ampliar o efeito do reset.
    const { rows: cascatas } = await client.query(`
      select n.nspname as esquema,c.relname as tabela
      from pg_constraint f join pg_class c on c.oid=f.conrelid
      join pg_namespace n on n.oid=c.relnamespace
      where f.contype='f' and f.confdeltype in ('c','n','d')
        and f.confrelid in (
          'public.contas'::regclass,'public.medicos'::regclass,'public.usuarios'::regclass,
          'public.whatsapp_instancias'::regclass,'public.cofre_links'::regclass,
          'public.cofre_links_auditoria'::regclass,'public.cofre_links_entregas'::regclass,
          'public.noto_agent_conversas'::regclass,'public.noto_agent_mensagens'::regclass,
          'public.noto_boas_vindas_pareamento'::regclass,'public.noto_agent_trabalhos'::regclass,
          'public.auditoria'::regclass
        )
    `);
    const cascatasConhecidas = new Set([
      ...tabelasAutorizadas, 'assinaturas', 'consentimentos', 'contadores', 'secretarias',
      'contador_medico', 'secretaria_medico', 'medico_certificados', 'medico_perfil_fiscal',
      'medico_respostas_rapidas', 'noto_medico_agenda_referencias', 'cadastro_certificado_trabalhos',
      'uso_mensal_medico'
    ]);
    if (cascatas.some(fk => fk.esquema !== 'public' || !cascatasConhecidas.has(fk.tabela))) {
      throw new Error('CASCATA_FORA_DO_MAPA');
    }

    for (const tabela of ['whatsapp_instancias', 'noto_agent_trabalhos', 'auditoria']) {
      await client.query('delete from public.' + identificador(tabela) + ' where conta_id=$1', [contaId]);
    }
    const exclusao = await client.query('delete from public.contas where id=$1 returning id', [contaId]);
    if (exclusao.rowCount !== 1) throw new Error('CONTA_NAO_EXCLUIDA');
    await client.query('commit');
    console.log(JSON.stringify({ modo: 'EXCLUIDO', contaId }));
  }
} catch (erro) {
  console.error('Mapeamento interrompido:', erro.code ?? erro.message);
  process.exitCode = 1;
} finally {
  await client.query('rollback').catch(() => {});
  await client.end();
}
