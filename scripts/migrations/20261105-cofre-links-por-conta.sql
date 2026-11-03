-- Pré-revisão. Não aplicar em banco nenhum sem autorização explícita.
-- O Cofre pertence à conta antes de existir um profissional confirmado.
-- Preserva links antigos por medico_id e suas auditorias, sem conversão/cópia.
BEGIN;
DO $$
BEGIN
 IF to_regclass('public.cofre_links') IS NULL
    OR to_regclass('public.cofre_links_auditoria') IS NULL
    OR to_regclass('public.contas') IS NULL
 THEN RAISE EXCEPTION 'COFRE_CONTA_PRE_REQUISITOS_AUSENTES'; END IF;
 IF NOT EXISTS (
   SELECT 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='cofre_links'
     AND column_name='medico_id' AND udt_name='uuid'
 ) THEN RAISE EXCEPTION 'COFRE_MEDICO_ID_INCOMPATIVEL'; END IF;
END $$;
-- Compatibilidade com o código anterior: campo opcional, sem perda de links.
ALTER TABLE public.cofre_links ADD COLUMN IF NOT EXISTS destino_telefone text;
DO $
DECLARE col_type text;
BEGIN
 SELECT udt_name INTO col_type FROM information_schema.columns
 WHERE table_schema='public' AND table_name='cofre_links'
   AND column_name='destino_telefone';
 IF col_type IS DISTINCT FROM 'text' THEN
   RAISE EXCEPTION 'COFRE_DESTINO_TELEFONE_INCOMPATIVEL';
 END IF;
END $;
-- O código grava 'concluido'. Trocar somente o CHECK conhecido da 20261020;
-- não remover restrições desconhecidas de um banco divergente.
DO $
DECLARE definition text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
 WHERE conrelid='public.cofre_links_auditoria'::regclass
   AND conname='cofre_links_auditoria_evento_check' AND contype='c';
 IF definition IS NOT NULL AND definition NOT ILIKE '%concluido%' THEN
   IF definition NOT ILIKE '%criado%' OR definition NOT ILIKE '%aberto%'
      OR definition NOT ILIKE '%enviado%' OR definition NOT ILIKE '%expirado%' THEN
     RAISE EXCEPTION 'COFRE_AUDITORIA_CHECK_DESCONHECIDO';
   END IF;
   ALTER TABLE public.cofre_links_auditoria
     DROP CONSTRAINT cofre_links_auditoria_evento_check;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint
   WHERE conrelid='public.cofre_links_auditoria'::regclass
     AND conname='cofre_links_auditoria_evento_check') THEN
   ALTER TABLE public.cofre_links_auditoria
     ADD CONSTRAINT cofre_links_auditoria_evento_check
     CHECK (evento IN ('criado','aberto','enviado','expirado','concluido'));
 END IF;
END $;
ALTER TABLE public.cofre_links
  ADD COLUMN IF NOT EXISTS conta_id uuid REFERENCES public.contas(id) ON DELETE CASCADE;
ALTER TABLE public.cofre_links ALTER COLUMN medico_id DROP NOT NULL;
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='cofre_links' AND column_name='conta_id' AND
    (udt_name <> 'uuid' OR is_nullable <> 'YES')) THEN
   RAISE EXCEPTION 'COFRE_CONTA_ID_ESTRUTURA_INCOMPATIVEL'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint
     WHERE conrelid='public.cofre_links'::regclass AND conname='cofre_links_titular_exclusivo') THEN
   ALTER TABLE public.cofre_links ADD CONSTRAINT cofre_links_titular_exclusivo
    CHECK ((medico_id IS NOT NULL AND conta_id IS NULL)
       OR (medico_id IS NULL AND conta_id IS NOT NULL));
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS cofre_links_conta_criado
 ON public.cofre_links(conta_id,criado_em DESC,id DESC) WHERE conta_id IS NOT NULL;
ALTER TABLE public.cofre_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cofre_links_auditoria ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cofre_links,public.cofre_links_auditoria FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
   GRANT SELECT,INSERT,UPDATE,DELETE ON public.cofre_links,public.cofre_links_auditoria TO service_role;
 END IF;
 IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name IN ('cofre_links','cofre_links_auditoria')
    AND grantee IN ('anon','authenticated')
    AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE')) THEN
   RAISE EXCEPTION 'COFRE_PRIVILEGIOS_ABERTOS';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint
   WHERE conrelid='public.cofre_links_auditoria'::regclass
     AND conname='cofre_links_auditoria_evento_check'
     AND contype='c' AND convalidated
     AND pg_get_constraintdef(oid) ILIKE '%concluido%')
 THEN RAISE EXCEPTION 'COFRE_AUDITORIA_CONCLUIDO_NAO_ACEITO'; END IF;
 IF NOT EXISTS(
   SELECT 1 FROM pg_constraint c JOIN pg_attribute a
     ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
   WHERE c.conrelid='public.cofre_links'::regclass
     AND c.confrelid='public.contas'::regclass
     AND c.contype='f' AND a.attname='conta_id'
 ) THEN RAISE EXCEPTION 'COFRE_CONTA_FK_AUSENTE'; END IF;
 IF NOT EXISTS(
   SELECT 1 FROM pg_constraint
   WHERE conrelid='public.cofre_links'::regclass
     AND conname='cofre_links_titular_exclusivo'
     AND contype='c' AND convalidated
     AND pg_get_constraintdef(oid) ILIKE '%medico_id IS NOT NULL%'
     AND pg_get_constraintdef(oid) ILIKE '%conta_id IS NOT NULL%'
     AND pg_get_constraintdef(oid) ILIKE '%medico_id IS NULL%'
     AND pg_get_constraintdef(oid) ILIKE '%conta_id IS NULL%'
 ) THEN RAISE EXCEPTION 'COFRE_TITULAR_ESTRUTURA_INCOMPATIVEL'; END IF;
END $$;
COMMIT;
