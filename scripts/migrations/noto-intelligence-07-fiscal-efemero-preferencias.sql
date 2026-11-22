-- Fiscal idempotency and operator-approved contextual rules.
-- No patient identifiers, consultation dates or agenda payloads persisted.
BEGIN;
CREATE TABLE public.noto_fiscal_consultas_processadas (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 medico_id uuid NOT NULL REFERENCES public.medicos(id) ON DELETE CASCADE,
 origem_agenda text NOT NULL,
 chave_idempotencia text NOT NULL CHECK(chave_idempotencia ~ '^[0-9a-f]{64}$'),
 versao_chave smallint NOT NULL DEFAULT 1 CHECK(versao_chave > 0),
 lote_emissao uuid,
 estado text NOT NULL DEFAULT 'reservada' CHECK(estado IN ('reservada','em_processamento','emitida','falha_reconciliavel','cancelada')),
 nota_id uuid REFERENCES public.notas_fiscais(id),
 criado_em timestamptz NOT NULL DEFAULT now(),
 atualizado_em timestamptz NOT NULL DEFAULT now(),
 UNIQUE(medico_id,origem_agenda,versao_chave,chave_idempotencia)
);
CREATE INDEX noto_fiscal_consultas_lote_idx ON public.noto_fiscal_consultas_processadas(lote_emissao);
CREATE TABLE public.noto_preferencias_operacionais (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 conta_id uuid NOT NULL REFERENCES public.contas(id) ON DELETE CASCADE,
 medico_id uuid,
 contexto text NOT NULL CHECK(contexto IN ('consultas_mesmo_paciente_mesmo_dia')),
 decisao text NOT NULL CHECK(decisao IN ('agrupar','separar')),
 autorizado_por uuid NOT NULL REFERENCES public.usuarios(id),
 ativa boolean NOT NULL DEFAULT true,
 criado_em timestamptz NOT NULL DEFAULT now(),
 revogada_em timestamptz,
 FOREIGN KEY(medico_id,conta_id) REFERENCES public.medicos(id,conta_id),
 CHECK ((ativa AND revogada_em IS NULL) OR (NOT ativa))
);
CREATE UNIQUE INDEX noto_preferencias_ativas_conta_idx
 ON public.noto_preferencias_operacionais(conta_id,contexto) WHERE ativa AND medico_id IS NULL;
CREATE UNIQUE INDEX noto_preferencias_ativas_medico_idx
 ON public.noto_preferencias_operacionais(conta_id,medico_id,contexto) WHERE ativa AND medico_id IS NOT NULL;
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['noto_fiscal_consultas_processadas','noto_preferencias_operacionais'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
 END LOOP;
 IF EXISTS(SELECT 1 FROM information_schema.role_table_grants
 WHERE table_schema='public' AND table_name IN ('noto_fiscal_consultas_processadas','noto_preferencias_operacionais')
 AND grantee IN ('anon','authenticated') AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE'))
 THEN RAISE EXCEPTION 'client grants on private fiscal tables'; END IF;
END $$;
COMMIT;
