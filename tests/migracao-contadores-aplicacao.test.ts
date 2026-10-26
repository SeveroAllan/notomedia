import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';

const url=process.env.MIGRATION_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const migration=await readFile(new URL('../scripts/migrations/20261031-contadores-delegacoes.sql',import.meta.url),'utf8');
const medicosConta=await readFile(new URL('../scripts/migrations/20261101-medicos-por-conta.sql',import.meta.url),'utf8');
const memoriaVisibilidade=await readFile(new URL('../scripts/migrations/20261103-memoria-conta-e-visibilidade.sql',import.meta.url),'utf8');

suite('migration de contadores aplicada sobre o estado da homologação',()=>{
  const pool=new pg.Pool({connectionString:url});

  beforeAll(async()=>{
    await pool.query(`
      drop schema if exists auth cascade;
      drop schema public cascade;
      create schema public;
      create schema auth;
      create extension if not exists pgcrypto with schema public;

      do $roles$
      begin
        if not exists(select 1 from pg_roles where rolname='anon') then execute 'create role anon nologin'; end if;
        if not exists(select 1 from pg_roles where rolname='authenticated') then execute 'create role authenticated nologin'; end if;
        if not exists(select 1 from pg_roles where rolname='service_role') then execute 'create role service_role nologin'; end if;
      end
      $roles$;

      create function auth.uid() returns uuid language sql stable
      as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    `);
  });

  afterAll(async()=>{await pool.end();});

  async function estadoHomologSemContadores(){
    await pool.query(`
      drop schema public cascade;
      create schema public;
      create extension if not exists pgcrypto with schema public;

      create table public.contas (
        id uuid primary key default gen_random_uuid()
      );
      create table public.usuarios (
        id uuid primary key default gen_random_uuid(),
        auth_user_id uuid not null unique,
        conta_id uuid not null references public.contas(id) on delete cascade,
        ativo boolean not null default true
      );
      create table public.medicos (
        id uuid primary key default gen_random_uuid(),
        usuario_id uuid not null unique references public.usuarios(id) on delete cascade,
        conta_id uuid not null references public.contas(id) on delete cascade,
        nome_completo text not null,
        criado_em timestamptz not null default now()
      );
      create table public.secretarias (
        id uuid primary key default gen_random_uuid(),
        usuario_id uuid not null unique references public.usuarios(id) on delete cascade,
        conta_id uuid not null references public.contas(id) on delete cascade,
        criado_em timestamptz not null default now()
      );
      create table public.secretaria_medico (
        secretaria_id uuid not null references public.secretarias(id) on delete cascade,
        medico_id uuid not null references public.medicos(id) on delete cascade,
        primary key(secretaria_id,medico_id)
      );
      create table public.conversa_memorias_semanticas (
        id bigserial primary key,
        medico_id uuid not null references public.medicos(id) on delete cascade,
        chave text not null,
        categoria text not null,
        valor text not null,
        origem_conversa text not null,
        origem_mensagem_id bigint not null,
        confianca numeric(4,3) not null,
        ativa boolean not null default true,
        criado_em timestamptz not null default now(),
        atualizado_em timestamptz not null default now(),
        unique(medico_id,chave)
      );
    `);
  }

  it('cria o pré-requisito ausente e permite aplicar 20261101 + 20261103 com delegação cross-account',async()=>{
    await estadoHomologSemContadores();
    expect((await pool.query("select to_regclass('public.contadores') as t")).rows[0].t).toBeNull();
    expect((await pool.query("select to_regclass('public.contador_medico') as t")).rows[0].t).toBeNull();

    await pool.query(migration);

    const protecao=(await pool.query(`
      select c.relname,c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname in ('contadores','contador_medico')
      order by c.relname
    `)).rows;
    expect(protecao).toEqual([
      {relname:'contador_medico',relrowsecurity:true},
      {relname:'contadores',relrowsecurity:true}
    ]);
    for(const role of ['anon','authenticated']){
      expect((await pool.query(
        "select has_table_privilege($1,'public.contadores','SELECT') as p",[role])).rows[0].p).toBe(false);
      expect((await pool.query(
        "select has_table_privilege($1,'public.contador_medico','SELECT') as p",[role])).rows[0].p).toBe(false);
    }

    const ids={
      contaA:'00000000-0000-4000-8000-000000000001',
      contaB:'00000000-0000-4000-8000-000000000002',
      usuarioA:'00000000-0000-4000-8000-000000000011',
      usuarioB:'00000000-0000-4000-8000-000000000012',
      authA:'00000000-0000-4000-8000-000000000021',
      authB:'00000000-0000-4000-8000-000000000022',
      medicoA:'00000000-0000-4000-8000-000000000031',
      medicoB:'00000000-0000-4000-8000-000000000032'
    };
    await pool.query('insert into public.contas(id) values($1),($2)',[ids.contaA,ids.contaB]);
    await pool.query(
      'insert into public.usuarios(id,auth_user_id,conta_id) values($1,$2,$3),($4,$5,$6)',
      [ids.usuarioA,ids.authA,ids.contaA,ids.usuarioB,ids.authB,ids.contaB]);
    await pool.query(
      "insert into public.medicos(id,usuario_id,conta_id,nome_completo) values($1,$2,$3,'Médico A'),($4,$5,$6,'Médico B')",
      [ids.medicoA,ids.usuarioA,ids.contaA,ids.medicoB,ids.usuarioB,ids.contaB]);
    await pool.query('insert into public.contadores(usuario_id,conta_id) values($1,$2)',[ids.usuarioA,ids.contaA]);
    await pool.query(`
      insert into public.contador_medico(contador_id,medico_id)
      select id,$2 from public.contadores where usuario_id=$1
    `,[ids.usuarioA,ids.medicoB]);

    await pool.query(medicosConta);
    await pool.query(memoriaVisibilidade);

    await pool.query("select set_config('request.jwt.claim.sub',$1,false)",[ids.authA]);
    const visiveis=(await pool.query(
      'select public.medicos_visiveis_para($1::uuid)::text as id order by 1',[ids.authA]
    )).rows.map(r=>r.id);
    expect(visiveis).toEqual([ids.medicoA,ids.medicoB]);

    const identidadeAlheia=(await pool.query(
      'select public.medicos_visiveis_para($1::uuid)::text as id',[ids.authB]
    )).rows;
    expect(identidadeAlheia).toEqual([]);
  });

  it('aborta se contadores já existir com estrutura incompatível em vez de aceitar IF NOT EXISTS cegamente',async()=>{
    await estadoHomologSemContadores();
    await pool.query(`
      create table public.contadores (
        id uuid primary key default gen_random_uuid(),
        usuario_id uuid not null unique references public.usuarios(id) on delete cascade,
        conta_id uuid not null references public.contas(id) on delete cascade,
        criado_em timestamptz default now()
      );
      create table public.contador_medico (
        contador_id uuid not null references public.contadores(id) on delete cascade,
        medico_id uuid not null references public.medicos(id) on delete cascade,
        primary key(contador_id,medico_id)
      );
    `);

    await expect(pool.query(migration)).rejects.toThrow(/contadores\.criado_em incompatível/);
    const estado=(await pool.query(`
      select c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname='contadores'
    `)).rows[0];
    expect(estado.relrowsecurity).toBe(false);
  });
});
