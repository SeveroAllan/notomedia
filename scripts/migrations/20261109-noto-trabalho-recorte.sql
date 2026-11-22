-- Aplicar antes de publicar o código que enfileira o recorte explícito.
begin;
alter table public.noto_agent_trabalhos add column if not exists inicio_periodo date;
commit;
