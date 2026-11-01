-- Noto Intelligence: protected fiscal and Cofre metadata foundations.
-- No fiscal worker or issuance is enabled by this migration.
BEGIN;
CREATE TABLE public.medico_perfil_fiscal (
 medico_id uuid PRIMARY KEY REFERENCES public.medicos(id) ON DELETE CASCADE,
 tipo_pessoa text NOT NULL DEFAULT 'PF' CHECK(tipo_pessoa IN ('PF','PJ')),
 cpf_cnpj_hash text UNIQUE,
 cpf_cnpj_encriptado bytea,
 razao_social text,
 inscricao_municipal text,
 uf char(2),
 cod_municipio_ibge char(7),
 ambiente text NOT NULL DEFAULT 'homologacao' CHECK(ambiente IN ('homologacao','producao')),
 confirmado_pelo_medico boolean NOT NULL DEFAULT false,
 criado_em timestamptz NOT NULL DEFAULT now(),
 atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.medico_certificados (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 medico_id uuid NOT NULL REFERENCES public.medicos(id) ON DELETE CASCADE,
 arquivo_storage_path text NOT NULL,
 senha_secret_id uuid NOT NULL,
 alias text,
 valido_de date,
 valido_ate date NOT NULL,
 status text NOT NULL DEFAULT 'pendente' CHECK(status IN ('pendente','ativo','vencido','revogado','erro')),
 erro_validacao text,
 criado_em timestamptz NOT NULL DEFAULT now(),
 atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX medico_certificados_medico_idx ON public.medico_certificados(medico_id);
CREATE TABLE public.consentimentos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 conta_id uuid NOT NULL REFERENCES public.contas(id) ON DELETE CASCADE,
 usuario_id uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
 tipo text NOT NULL CHECK(tipo IN ('termos_uso','politica_privacidade','consentimento_dados_sensiveis')),
 versao text NOT NULL,
 aceito_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consentimentos_conta_idx ON public.consentimentos(conta_id);
CREATE TABLE public.auditoria (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 conta_id uuid REFERENCES public.contas(id) ON DELETE SET NULL,
 usuario_id uuid REFERENCES public.usuarios(id) ON DELETE SET NULL,
 evento text NOT NULL,
 dados jsonb NOT NULL DEFAULT '{}'::jsonb,
 criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auditoria_conta_criado_idx ON public.auditoria(conta_id,criado_em DESC);
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['medico_perfil_fiscal','medico_certificados','consentimentos','auditoria'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',t);
 END LOOP;
 IF EXISTS (
  SELECT 1 FROM information_schema.role_table_grants
  WHERE table_schema='public'
    AND table_name IN ('medico_perfil_fiscal','medico_certificados','consentimentos','auditoria')
    AND grantee IN ('anon','authenticated')
    AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE')
 ) THEN RAISE EXCEPTION 'unexpected public access'; END IF;
END $$;
COMMIT;
