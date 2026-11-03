-- Fila independente do turno do WhatsApp. NÃO aplicar sem autorização.
-- Sem pacientes, consultas, CPF, valores, credenciais ou transcrições.
BEGIN;
DO $$
BEGIN
 IF to_regclass('public.contas') IS NULL OR to_regclass('public.medicos') IS NULL
    OR to_regclass('public.usuarios') IS NULL THEN
   RAISE EXCEPTION 'NOTO_TRABALHOS_DEPENDENCIAS_AUSENTES';
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.noto_agent_trabalhos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 conta_id uuid NOT NULL REFERENCES public.contas(id) ON DELETE CASCADE,
 instancia text NOT NULL CHECK(length(instancia) BETWEEN 1 AND 128),
 mensagem_id text NOT NULL CHECK(length(mensagem_id) BETWEEN 5 AND 150),
 telefone_destino text NOT NULL CHECK(telefone_destino ~ '^55[0-9]{10,11}$'),
 tipo text NOT NULL CHECK(tipo IN ('descoberta_agenda','conferencia_fiscal')),
 agenda text NOT NULL CHECK(agenda IN ('tribemd','amplimed')),
 medico_id uuid REFERENCES public.medicos(id),
 estado text NOT NULL DEFAULT 'pendente'
   CHECK(estado IN ('pendente','executando','resultado_pronto','notificando','concluido','falhou','envio_incerto')),
 tentativas smallint NOT NULL DEFAULT 0 CHECK(tentativas BETWEEN 0 AND 2),
 executado_por text,
 bloqueado_ate timestamptz,
 resultado jsonb CHECK(resultado IS NULL OR
   (jsonb_typeof(resultado)='object' AND pg_column_size(resultado)<=6000)),
 criado_em timestamptz NOT NULL DEFAULT now(),
 atualizado_em timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conta_id,instancia,mensagem_id,tipo)
);
CREATE UNIQUE INDEX IF NOT EXISTS noto_trabalhos_ativos_por_conta ON public.noto_agent_trabalhos(
 conta_id,instancia,tipo,agenda,coalesce(medico_id,'00000000-0000-0000-0000-000000000000'::uuid)
) WHERE estado IN ('pendente','executando','resultado_pronto','notificando');
CREATE INDEX IF NOT EXISTS noto_trabalhos_pendentes ON public.noto_agent_trabalhos(criado_em)
 WHERE estado IN ('pendente','resultado_pronto','executando');
ALTER TABLE public.noto_agent_trabalhos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.noto_agent_trabalhos FROM PUBLIC,anon,authenticated;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT SELECT,INSERT,UPDATE ON public.noto_agent_trabalhos TO service_role;
 END IF;
END $$;

-- Falhar se tabela preexistente divergir, sem mascarar com IF NOT EXISTS.
DO $check$
DECLARE coluna text; tipo text;
BEGIN
 FOR coluna,tipo IN
  SELECT * FROM (VALUES
   ('id','uuid'),('conta_id','uuid'),('instancia','text'),
   ('mensagem_id','text'),('telefone_destino','text'),
   ('tipo','text'),('agenda','text'),('medico_id','uuid'),
   ('estado','text'),('tentativas','int2'),('executado_por','text'),
   ('bloqueado_ate','timestamptz'),('resultado','jsonb'),
   ('criado_em','timestamptz'),('atualizado_em','timestamptz')
  ) AS c(nome,udt)
 LOOP
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='noto_agent_trabalhos'
      AND column_name=coluna AND udt_name=tipo) THEN
   RAISE EXCEPTION 'NOTO_TRABALHOS_COLUNA_INCOMPATIVEL: %',coluna;
  END IF;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_class
   WHERE oid='public.noto_agent_trabalhos'::regclass AND relrowsecurity) THEN
  RAISE EXCEPTION 'NOTO_TRABALHOS_RLS_AUSENTE';
 END IF;
 IF EXISTS(SELECT 1 FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='noto_agent_trabalhos'
    AND grantee IN('anon','authenticated')
    AND privilege_type IN('SELECT','INSERT','UPDATE','DELETE','TRUNCATE')) THEN
  RAISE EXCEPTION 'NOTO_TRABALHOS_GRANT_CLIENTE_INSEGURO';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint
    WHERE conrelid='public.noto_agent_trabalhos'::regclass AND contype='p')
 OR NOT EXISTS(SELECT 1 FROM pg_constraint
    WHERE conrelid='public.noto_agent_trabalhos'::regclass AND contype='u')
 OR NOT EXISTS(SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='noto_agent_trabalhos'
      AND indexname='noto_trabalhos_ativos_por_conta') THEN
  RAISE EXCEPTION 'NOTO_TRABALHOS_CONTRATO_UNICO_INCOMPATIVEL';
 END IF;
END $check$;
COMMIT;
