-- Preparação obrigatória ANTES da 20261105; não executar sem aprovação.
-- Compatível com base vazia e com a 20261020 original já aplicada.
BEGIN;
DO $$
DECLARE
  links boolean := to_regclass('public.cofre_links') IS NOT NULL;
  audit boolean := to_regclass('public.cofre_links_auditoria') IS NOT NULL;
BEGIN
  IF to_regclass('public.medicos') IS NULL OR to_regclass('public.contas') IS NULL THEN
    RAISE EXCEPTION 'COFRE_PRE_REQUISITOS_MEDICOS_CONTAS_AUSENTES';
  END IF;
  IF links <> audit THEN
    RAISE EXCEPTION 'COFRE_ESTADO_PARCIAL_EXIGE_REVISAO';
  END IF;
  IF NOT links THEN
    -- Mesmo contrato inicial de 20261020; 20261105 faz a evolução.
    CREATE TABLE public.cofre_links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      medico_id uuid NOT NULL REFERENCES public.medicos(id) ON DELETE CASCADE,
      agenda text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      expira_em timestamptz NOT NULL,
      usado_em timestamptz,
      criado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX cofre_links_medico_criado ON public.cofre_links(medico_id, criado_em);
    CREATE TABLE public.cofre_links_auditoria (
      link_id uuid NOT NULL REFERENCES public.cofre_links(id) ON DELETE CASCADE,
      evento text NOT NULL CHECK (evento IN ('criado','aberto','enviado','expirado')),
      criado_em timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (link_id, evento)
    );
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.cofre_links'::regclass AND contype='p')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.cofre_links_auditoria'::regclass AND contype='p')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.cofre_links'::regclass AND contype='u'
      AND pg_get_constraintdef(oid) LIKE '%token_hash%')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.cofre_links_auditoria'::regclass AND contype='f'
      AND confrelid='public.cofre_links'::regclass)
  THEN RAISE EXCEPTION 'COFRE_ESTRUTURA_LEGADA_INCOMPATIVEL'; END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('cofre_links','id','uuid'),('cofre_links','medico_id','uuid'),
      ('cofre_links','agenda','text'),('cofre_links','token_hash','text'),
      ('cofre_links','expira_em','timestamptz'),('cofre_links','usado_em','timestamptz'),
      ('cofre_links','criado_em','timestamptz'),
      ('cofre_links_auditoria','link_id','uuid'),
      ('cofre_links_auditoria','evento','text'),
      ('cofre_links_auditoria','criado_em','timestamptz')
    ) AS required(t,c,ty)
    LEFT JOIN information_schema.columns col
      ON col.table_schema='public' AND col.table_name=required.t
      AND col.column_name=required.c
    WHERE col.udt_name IS DISTINCT FROM CASE required.ty
      WHEN 'timestamptz' THEN 'timestamptz' ELSE required.ty END
  ) THEN RAISE EXCEPTION 'COFRE_COLUNAS_LEGADAS_INCOMPATIVEIS'; END IF;
END $$;
ALTER TABLE public.cofre_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cofre_links_auditoria ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cofre_links,public.cofre_links_auditoria FROM PUBLIC,anon,authenticated;
COMMIT;
