-- Adiciona metadados opcionais (ex.: urlPortal e nomeAgenda descobertos online)
-- aos links de uso único do cofre, sem alterar colunas ou restrições existentes.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.cofre_links
  ADD COLUMN IF NOT EXISTS metadados jsonb;

COMMIT;
