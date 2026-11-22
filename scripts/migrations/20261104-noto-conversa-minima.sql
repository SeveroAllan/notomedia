-- Etapa conversacional da conta, nao um cadastro fiscal e nao um transcript.
-- A reserva da mensagem evita repeticao de baloes em webhook concorrente.
-- Nunca aplicar automaticamente; implantar apenas em homologacao isolada apos aprovacao.
BEGIN;
DO $pre$
BEGIN
 IF to_regclass('public.contas') IS NULL THEN
   RAISE EXCEPTION 'NOTO_AGENT_CONTAS_AUSENTES';
 END IF;
END $pre$;
CREATE TABLE IF NOT EXISTS public.noto_agent_conversas (
 conta_id uuid PRIMARY KEY REFERENCES public.contas(id) ON DELETE CASCADE,
 estado jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(estado)='object'),
 atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.noto_agent_mensagens (
 conta_id uuid NOT NULL REFERENCES public.contas(id) ON DELETE CASCADE,
 instancia text NOT NULL CHECK(length(instancia) BETWEEN 1 AND 128),
 mensagem_id text NOT NULL CHECK(length(mensagem_id) BETWEEN 5 AND 150),
 estado text NOT NULL DEFAULT 'reservada'
   CHECK(estado IN ('reservada','concluida','incerta')),
 baloes_confirmados integer NOT NULL DEFAULT 0 CHECK(baloes_confirmados >= 0),
 recebido_em timestamptz NOT NULL DEFAULT now(),
 atualizado_em timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(conta_id,instancia,mensagem_id)
);
ALTER TABLE public.noto_agent_conversas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.noto_agent_mensagens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.noto_agent_conversas, public.noto_agent_mensagens FROM PUBLIC, anon, authenticated;
DO $grants$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT SELECT,INSERT,UPDATE ON public.noto_agent_conversas,public.noto_agent_mensagens TO service_role;
 END IF;
END $grants$;
DO $assert$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['noto_agent_conversas','noto_agent_mensagens'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.'||t) AND relrowsecurity)
   THEN RAISE EXCEPTION 'NOTO_AGENT_RLS_AUSENTE: %',t; END IF;
  IF EXISTS(SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name=t
    AND grantee IN ('anon','authenticated') AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE'))
   THEN RAISE EXCEPTION 'NOTO_AGENT_CLIENTE_TEM_ACESSO: %',t; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='noto_agent_conversas' AND column_name='estado' AND udt_name='jsonb')
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.noto_agent_mensagens'::regclass
   AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (conta_id, instancia, mensagem_id)')
 THEN RAISE EXCEPTION 'NOTO_AGENT_SCHEMA_INCOMPATIVEL'; END IF;
END $assert$;
COMMIT;
