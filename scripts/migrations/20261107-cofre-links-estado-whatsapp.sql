-- APENAS PARA REVISAO. Depende de 20261106-cofre-links-reconciliar-homologacao.sql.
-- Nao aplicar sem autorizacao. Nao guarda token, URL, texto, senha ou telefone.
BEGIN;
SET LOCAL lock_timeout='10s';
DO $$
BEGIN
 IF to_regclass('public.cofre_links') IS NULL THEN
   RAISE EXCEPTION 'COFRE_LINKS_NAO_RECONCILIADOS';
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.cofre_links_entregas (
  link_id uuid PRIMARY KEY REFERENCES public.cofre_links(id) ON DELETE CASCADE,
  instancia text NOT NULL,
  mensagem_id text,
  destino_hash char(64) NOT NULL,
  estado text NOT NULL DEFAULT 'ACEITO_API',
  aceito_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT cofre_links_entregas_estado_check CHECK (
    estado IN ('ACEITO_API','PENDING','SERVER_ACK','DELIVERY_ACK','READ','ERROR')
  ),
  CONSTRAINT cofre_links_entregas_id_check CHECK (
    mensagem_id IS NULL OR length(mensagem_id) BETWEEN 5 AND 150
  ),
  CONSTRAINT cofre_links_entregas_hash_check CHECK (
    destino_hash ~ '^[0-9a-f]{64}$'
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS cofre_links_entregas_instancia_id
  ON public.cofre_links_entregas(instancia,mensagem_id)
  WHERE mensagem_id IS NOT NULL;
ALTER TABLE public.cofre_links_entregas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cofre_links_entregas FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
   GRANT SELECT,INSERT,UPDATE ON public.cofre_links_entregas TO service_role;
 END IF;
 IF NOT EXISTS (
   SELECT 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='cofre_links_entregas'
     AND column_name='link_id' AND udt_name='uuid' AND is_nullable='NO'
 ) OR NOT EXISTS (
   SELECT 1 FROM pg_constraint
   WHERE conrelid='public.cofre_links_entregas'::regclass
      AND conname='cofre_links_entregas_estado_check' AND contype='c' AND convalidated
 ) OR NOT EXISTS (
   SELECT 1 FROM pg_constraint
   WHERE conrelid='public.cofre_links_entregas'::regclass
      AND contype='f' AND confrelid='public.cofre_links'::regclass
 ) OR EXISTS (
   SELECT 1 FROM pg_class
   WHERE oid='public.cofre_links_entregas'::regclass AND NOT relrowsecurity
 ) OR EXISTS (
   SELECT 1 FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='cofre_links_entregas'
     AND grantee IN ('anon','authenticated')
     AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE')
 ) THEN RAISE EXCEPTION 'COFRE_ENTREGAS_ESQUEMA_INCOMPATIVEL'; END IF;
END $$;
COMMIT;
