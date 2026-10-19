-- Proposta idempotente. NÃO aplicar automaticamente. Não altera OTP por WhatsApp.
begin;
create table if not exists public.login_otp_email (
  id uuid primary key default gen_random_uuid(),
  email_hash text not null check (email_hash ~ '^[a-f0-9]{64}$'),
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  codigo_hash text not null check (codigo_hash ~ '^[a-f0-9]{64}$'),
  tentativas integer not null default 0 check (tentativas between 0 and 5),
  expira_em timestamptz not null,
  criado_em timestamptz not null default now(),
  verificado_em timestamptz,
  envio_confirmado boolean not null default false,
  check (expira_em > criado_em),
  check (verificado_em is null or envio_confirmado)
);
create index if not exists login_otp_email_ultimo on public.login_otp_email (email_hash, criado_em desc, id desc);
create table if not exists public.login_otp_email_auditoria (
  id uuid primary key default gen_random_uuid(),
  email_hash text not null check (email_hash ~ '^[a-f0-9]{64}$'),
  evento text not null check (evento in ('solicitado', 'enviado', 'em_cooldown', 'falha_envio', 'identidade_indisponivel',
    'codigo_invalido', 'nao_encontrado', 'bloqueado_tentativas', 'expirado', 'envio_nao_confirmado', 'incorreto', 'verificado', 'falha_sessao')),
  criado_em timestamptz not null default now()
);
alter table public.login_otp_email enable row level security;
alter table public.login_otp_email_auditoria enable row level security;
revoke all on table public.login_otp_email from public;
revoke all on table public.login_otp_email_auditoria from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.login_otp_email from anon';
    execute 'revoke all on table public.login_otp_email_auditoria from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.login_otp_email from authenticated';
    execute 'revoke all on table public.login_otp_email_auditoria from authenticated';
  end if;
end $$;
commit;
