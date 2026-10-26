begin;

-- Pré-requisito do modelo de visibilidade multi-médico. O schema-base já
-- define estas tabelas, mas homologações antigas podem não tê-las recebido.
create table if not exists public.contadores (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null unique references public.usuarios(id) on delete cascade,
  conta_id uuid not null references public.contas(id) on delete cascade,
  criado_em timestamptz not null default now()
);

create table if not exists public.contador_medico (
  contador_id uuid not null references public.contadores(id) on delete cascade,
  medico_id uuid not null references public.medicos(id) on delete cascade,
  primary key (contador_id, medico_id)
);

create index if not exists idx_contador_medico_medico
  on public.contador_medico(medico_id);

-- Tabelas de delegação são internas. A função SECURITY DEFINER de visibilidade
-- lê esses vínculos pelo owner/backend; clientes não recebem acesso direto.
alter table public.contadores enable row level security;
alter table public.contador_medico enable row level security;

revoke all on table
  public.contadores,
  public.contador_medico
from anon, authenticated;

do $validar_contadores$
declare
  tabela text;
  papel text;
begin
  -- CREATE TABLE IF NOT EXISTS não é suficiente: se a tabela já existir,
  -- todos os elementos estruturais exigidos abaixo precisam coincidir.
  if not exists (
    select 1
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='contadores' and c.relkind='r'
  ) then
    raise exception 'public.contadores não é uma tabela comum';
  end if;

  if not exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid=a.attrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='contadores'
      and a.attname='id' and not a.attisdropped and a.attnotnull
      and a.atttypid='uuid'::regtype
  ) then raise exception 'public.contadores.id incompatível'; end if;

  if not exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid=a.attrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='contadores'
      and a.attname='usuario_id' and not a.attisdropped and a.attnotnull
      and a.atttypid='uuid'::regtype
  ) then raise exception 'public.contadores.usuario_id incompatível'; end if;

  if not exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid=a.attrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='contadores'
      and a.attname='conta_id' and not a.attisdropped and a.attnotnull
      and a.atttypid='uuid'::regtype
  ) then raise exception 'public.contadores.conta_id incompatível'; end if;

  if not exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid=a.attrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='contadores'
      and a.attname='criado_em' and not a.attisdropped and a.attnotnull
      and a.atttypid='timestamptz'::regtype
  ) then raise exception 'public.contadores.criado_em incompatível'; end if;

  if not exists (
    select 1 from pg_attrdef d
    join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum
    join pg_class c on c.oid=a.attrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='contadores' and a.attname='id'
      and pg_get_expr(d.adbin,d.adrelid) ~ 'gen_random_uuid'
  ) then raise exception 'public.contadores.id precisa default gen_random_uuid()'; end if;

  if not exists (
    select 1 from pg_attrdef d
    join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum
    join pg_class c on c.oid=a.attrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='contadores' and a.attname='criado_em'
      and pg_get_expr(d.adbin,d.adrelid) ~ '^now\(\)$'
  ) then raise exception 'public.contadores.criado_em precisa default now()'; end if;

  if not exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid=con.conrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='contadores'
      and con.contype='p'
      and pg_get_constraintdef(con.oid)='PRIMARY KEY (id)'
  ) then raise exception 'PK de public.contadores incompatível'; end if;

  if not exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid=con.conrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='contadores'
      and con.contype='u'
      and pg_get_constraintdef(con.oid)='UNIQUE (usuario_id)'
  ) then raise exception 'UNIQUE de public.contadores.usuario_id ausente'; end if;

  if not exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid=con.conrelid
    join pg_namespace n on n.oid=c.relnamespace
    join pg_class ref on ref.oid=con.confrelid
    join pg_namespace rn on rn.oid=ref.relnamespace
    where n.nspname='public' and c.relname='contadores'
      and con.contype='f' and con.confdeltype='c'
      and rn.nspname='public' and ref.relname='usuarios'
      and pg_get_constraintdef(con.oid) like 'FOREIGN KEY (usuario_id)%'
  ) then raise exception 'FK contadores.usuario_id incompatível'; end if;

  if not exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid=con.conrelid
    join pg_namespace n on n.oid=c.relnamespace
    join pg_class ref on ref.oid=con.confrelid
    join pg_namespace rn on rn.oid=ref.relnamespace
    where n.nspname='public' and c.relname='contadores'
      and con.contype='f' and con.confdeltype='c'
      and rn.nspname='public' and ref.relname='contas'
      and pg_get_constraintdef(con.oid) like 'FOREIGN KEY (conta_id)%'
  ) then raise exception 'FK contadores.conta_id incompatível'; end if;

  if not exists (
    select 1
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='contador_medico' and c.relkind='r'
  ) then
    raise exception 'public.contador_medico não é uma tabela comum';
  end if;

  if (
    select count(*)
    from pg_attribute a join pg_class c on c.oid=a.attrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='contador_medico'
      and a.attname in ('contador_id','medico_id') and not a.attisdropped
      and a.attnotnull and a.atttypid='uuid'::regtype
  ) <> 2 then raise exception 'colunas de public.contador_medico incompatíveis'; end if;

  if not exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid=con.conrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='contador_medico'
      and con.contype='p'
      and pg_get_constraintdef(con.oid)='PRIMARY KEY (contador_id, medico_id)'
  ) then raise exception 'PK de public.contador_medico incompatível'; end if;

  if not exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid=con.conrelid
    join pg_namespace n on n.oid=c.relnamespace
    join pg_class ref on ref.oid=con.confrelid
    join pg_namespace rn on rn.oid=ref.relnamespace
    where n.nspname='public' and c.relname='contador_medico'
      and con.contype='f' and con.confdeltype='c'
      and rn.nspname='public' and ref.relname='contadores'
      and pg_get_constraintdef(con.oid) like 'FOREIGN KEY (contador_id)%'
  ) then raise exception 'FK contador_medico.contador_id incompatível'; end if;

  if not exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid=con.conrelid
    join pg_namespace n on n.oid=c.relnamespace
    join pg_class ref on ref.oid=con.confrelid
    join pg_namespace rn on rn.oid=ref.relnamespace
    where n.nspname='public' and c.relname='contador_medico'
      and con.contype='f' and con.confdeltype='c'
      and rn.nspname='public' and ref.relname='medicos'
      and pg_get_constraintdef(con.oid) like 'FOREIGN KEY (medico_id)%'
  ) then raise exception 'FK contador_medico.medico_id incompatível'; end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname='public' and tablename='contador_medico'
      and indexname='idx_contador_medico_medico'
      and position('(medico_id)' in replace(lower(indexdef),' ',''))>0
  ) then raise exception 'índice reverso de contador_medico ausente ou incompatível'; end if;

  foreach tabela in array array['contadores','contador_medico'] loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=tabela and c.relrowsecurity
    ) then raise exception 'RLS não habilitada em public.%', tabela; end if;

    foreach papel in array array['anon','authenticated'] loop
      if to_regrole(papel) is null then
        raise exception 'Role esperada do Supabase não existe: %', papel;
      end if;
      if has_table_privilege(papel,format('public.%I',tabela),'SELECT')
        or has_table_privilege(papel,format('public.%I',tabela),'INSERT')
        or has_table_privilege(papel,format('public.%I',tabela),'UPDATE')
        or has_table_privilege(papel,format('public.%I',tabela),'DELETE')
        or has_table_privilege(papel,format('public.%I',tabela),'TRUNCATE')
        or has_table_privilege(papel,format('public.%I',tabela),'REFERENCES')
        or has_table_privilege(papel,format('public.%I',tabela),'TRIGGER')
      then raise exception 'Privilégio residual de % em public.%', papel,tabela; end if;
    end loop;

    if not (
      has_table_privilege(current_user,format('public.%I',tabela),'SELECT')
      and has_table_privilege(current_user,format('public.%I',tabela),'INSERT')
      and has_table_privilege(current_user,format('public.%I',tabela),'UPDATE')
      and has_table_privilege(current_user,format('public.%I',tabela),'DELETE')
    ) then raise exception 'Role do backend % perdeu CRUD em public.%',current_user,tabela; end if;

    if not exists (
      select 1
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      join pg_roles atual on atual.rolname=current_user
      where n.nspname='public' and c.relname=tabela
        and (c.relowner=atual.oid or atual.rolsuper or atual.rolbypassrls)
    ) then raise exception 'Role do backend % seria bloqueada pela RLS em public.%',current_user,tabela; end if;
  end loop;
end
$validar_contadores$;

commit;
