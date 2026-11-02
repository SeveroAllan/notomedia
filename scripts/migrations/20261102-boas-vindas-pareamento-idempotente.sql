-- Registro duravel de boas-vindas: uma tentativa por conta, mesmo apos
-- reconexao, replay de webhook ou reinicio de multiplas replicas.
-- Nenhum telefone, texto, mensagem ou dado fiscal e armazenado.
-- Se o resultado do provedor for incerto, NAO reenvie automaticamente.
BEGIN;
DO $preflight$
BEGIN
  IF to_regclass('public.contas') IS NULL OR
     to_regclass('public.whatsapp_instancias') IS NULL THEN
    RAISE EXCEPTION 'BOAS_VINDAS_DEPENDENCIAS_AUSENTES';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.noto_boas_vindas_pareamento (
  conta_id uuid PRIMARY KEY REFERENCES public.contas(id) ON DELETE CASCADE,
  nome_instancia text NOT NULL,
  estado text NOT NULL DEFAULT 'reservada'
    CHECK (estado IN ('reservada','enviada','incerta')),
  reservado_em timestamptz NOT NULL DEFAULT now(),
  enviado_em timestamptz,
  CHECK ((estado = 'enviada' AND enviado_em IS NOT NULL)
      OR (estado <> 'enviada' AND enviado_em IS NULL))
);

ALTER TABLE public.noto_boas_vindas_pareamento ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.noto_boas_vindas_pareamento FROM PUBLIC, anon, authenticated;

DO $verify$
DECLARE coluna record;
BEGIN
  FOR coluna IN SELECT * FROM (VALUES
    ('conta_id','uuid'),('nome_instancia','text'),('estado','text'),
    ('reservado_em','timestamptz'),('enviado_em','timestamptz')
  ) AS esperado(nome,tipo)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public'
         AND table_name='noto_boas_vindas_pareamento'
         AND column_name=coluna.nome AND udt_name=coluna.tipo
    ) THEN RAISE EXCEPTION 'BOAS_VINDAS_SCHEMA_INCOMPATIVEL: %', coluna.nome;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.noto_boas_vindas_pareamento'::regclass
      AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (conta_id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.noto_boas_vindas_pareamento'::regclass
      AND contype='f' AND confrelid='public.contas'::regclass
  ) THEN RAISE EXCEPTION 'BOAS_VINDAS_CONSTRAINTS_INCOMPATIVEIS'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid='public.noto_boas_vindas_pareamento'::regclass
      AND relrowsecurity
  ) THEN RAISE EXCEPTION 'BOAS_VINDAS_RLS_AUSENTE'; END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name='noto_boas_vindas_pareamento'
        AND grantee IN ('anon','authenticated')
        AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE')
  ) THEN RAISE EXCEPTION 'BOAS_VINDAS_ACESSO_PUBLICO'; END IF;
END
$verify$;
COMMIT;
