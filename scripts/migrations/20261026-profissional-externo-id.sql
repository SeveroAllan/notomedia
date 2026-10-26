begin;

-- Vínculo médico-agenda com o código estável do profissional na agenda externa
-- (ex.: Amplimed .select_profs valor / FullCalendar resourceId).
-- Aditiva e não destrutiva: coluna nova, nullable, sem default, sem tocar em dados existentes.
-- Aprovada pelo Allan em 2026-10-26 09:22 (WhatsApp "Pode", wamid.HBgMNTU1MTkzNTI3MjcxFQIAEhggQTUzNTEzMTY5MDcwN0Y2OUFFNjYyRDQ3MENFMTg4NkEA,
-- resposta direta à pergunta 09:18 wamid.HBgMNTU1MTkzNTI3MjcxFQIAERgSQjQ2QjEzNjMwMTFGOEY2OEIyAA==).
-- Rollback documentado (NÃO executar automaticamente):
--   alter table public.noto_medico_agenda_referencias drop column if exists profissional_externo_id;

alter table public.noto_medico_agenda_referencias
  add column if not exists profissional_externo_id text;

do $profissional_externo_id$
begin
  if not exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid=a.attrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='noto_medico_agenda_referencias'
      and a.attname='profissional_externo_id' and not a.attisdropped and not a.attnotnull
  ) then
    raise exception 'profissional_externo_id precisa existir e ser nullable em noto_medico_agenda_referencias';
  end if;
end
$profissional_externo_id$;

commit;
