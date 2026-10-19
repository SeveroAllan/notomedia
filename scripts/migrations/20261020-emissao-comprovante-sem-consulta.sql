-- Depende de 20261019-emissao-comprovante.sql. Proposta: NÃO aplicada.
-- APP_PEPPER pertence à aplicação. Não gerar hashes sem pepper em SQL.
begin;

alter table public.noto_emissoes_comprovantes add column if not exists consulta_chave text;
do $$ begin
  if exists (select 1 from public.noto_emissoes_comprovantes where consulta_chave is null) then
    raise exception 'Reservas existentes exigem backfill HMAC pela aplicação antes desta migração';
  end if;
end $$;

do $$ declare vinculo record; begin
  for vinculo in select conname from pg_constraint
    where conrelid = 'public.noto_emissoes_comprovantes'::regclass
      and confrelid = 'public.noto_consultas_sincronizadas'::regclass
  loop execute format('alter table public.noto_emissoes_comprovantes drop constraint %I', vinculo.conname); end loop;
end $$;
alter table public.noto_emissoes_comprovantes drop column if exists fonte;
alter table public.noto_emissoes_comprovantes drop column if exists consulta_id_externo;
alter table public.noto_emissoes_comprovantes alter column consulta_chave set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.noto_emissoes_comprovantes'::regclass and conname = 'noto_emissoes_consulta_chave_hex') then
    alter table public.noto_emissoes_comprovantes add constraint noto_emissoes_consulta_chave_hex check (consulta_chave ~ '^[a-f0-9]{64}$');
  end if;
end $$;
create unique index if not exists noto_emissoes_medico_consulta_chave on public.noto_emissoes_comprovantes (medico_id, consulta_chave);

commit;
