-- Reconcilia o banco novo do Noto com o contrato do onboarding publicado.
-- Derivado das migrations 20261005, 20261009, 20261013 e 20261018
-- e dos campos que o codigo ja utiliza. Nao ativa emissao fiscal,
-- nao confirma cadastros e nao preenche valores tributarios.
BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.medicos') IS NULL
     OR to_regclass('public.usuarios') IS NULL
     OR to_regclass('public.medico_certificados') IS NULL
     OR to_regclass('public.medico_perfil_fiscal') IS NULL
     OR to_regclass('public.medico_servicos_fiscais') IS NULL
     OR to_regclass('public.whatsapp_instancias') IS NULL THEN
    RAISE EXCEPTION 'ONBOARDING_SCHEMA_BASE_INCOMPLETO';
  END IF;
END
$preflight$;

-- Preferencia operacional. FALSE significa apenas que a opcao nao foi ativada.
ALTER TABLE public.medicos
  ADD COLUMN IF NOT EXISTS solicitar_cpf_direto_paciente boolean NOT NULL DEFAULT false;

-- Campos fiscais permanecem desconhecidos (NULL) ate fonte e confirmacao.
ALTER TABLE public.medico_servicos_fiscais
  ADD COLUMN IF NOT EXISTS aliquota_iss numeric,
  ADD COLUMN IF NOT EXISTS parametros_emissao jsonb,
  ADD COLUMN IF NOT EXISTS ctrib_mun text;

ALTER TABLE public.medico_perfil_fiscal
  ADD COLUMN IF NOT EXISTS proximo_numero_dps bigint,
  ADD COLUMN IF NOT EXISTS serie_dps text,
  ADD COLUMN IF NOT EXISTS opcao_simples_nacional text,
  ADD COLUMN IF NOT EXISTS extraido_automaticamente boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dados_reforma_tributaria jsonb,
  ADD COLUMN IF NOT EXISTS cnae text;

-- Valida as opcoes possiveis sem escolher nenhuma delas para o usuario.
DO $restricoes$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.medico_perfil_fiscal'::regclass
      AND conname = 'medico_perfil_fiscal_opcao_simples_nacional_check'
  ) THEN
    ALTER TABLE public.medico_perfil_fiscal
      ADD CONSTRAINT medico_perfil_fiscal_opcao_simples_nacional_check
      CHECK (opcao_simples_nacional IN ('nao_optante','mei','me_epp'));
  END IF;
END
$restricoes$;

-- Modulo completo de trabalho do certificado: a tela de revisao faz LEFT JOIN
-- nesta tabela. As auxiliares mantem integridade para quando o fluxo for ativado.
CREATE TABLE IF NOT EXISTS public.cadastro_certificado_trabalhos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medico_id uuid NOT NULL REFERENCES public.medicos(id) ON DELETE CASCADE,
  certificado_id uuid NOT NULL UNIQUE REFERENCES public.medico_certificados(id) ON DELETE CASCADE,
  documento_titular text CHECK (documento_titular IS NULL OR documento_titular ~ '^(\d{11}|\d{14})$'),
  estado text NOT NULL DEFAULT 'pendente'
    CHECK (estado IN ('pendente','consultando','aguardando_confirmacao','concluido','falha','obsoleto')),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  dados jsonb NOT NULL DEFAULT '{}'::jsonb,
  tentativas integer NOT NULL DEFAULT 0,
  reserva uuid,
  reservado_em timestamptz,
  proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  diagnostico text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cadastro_certificado_fila
  ON public.cadastro_certificado_trabalhos (proxima_tentativa_em)
  WHERE estado IN ('pendente','consultando');

CREATE TABLE IF NOT EXISTS public.cadastro_certificado_avisos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trabalho_id uuid NOT NULL REFERENCES public.cadastro_certificado_trabalhos(id) ON DELETE CASCADE,
  chave text NOT NULL,
  pendencia_id uuid,
  tipo text NOT NULL CHECK (tipo IN ('pergunta','esclarecer','concluido')),
  mensagem_recebida text,
  texto text CHECK (texto IS NULL OR length(texto) BETWEEN 1 AND 500),
  estado text NOT NULL DEFAULT 'pendente'
    CHECK (estado IN ('pendente','preparado','enviando','confirmado','incerto','falha','obsoleto')),
  reserva uuid,
  reservado_em timestamptz,
  tentativas integer NOT NULL DEFAULT 0,
  proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  diagnostico text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trabalho_id, chave)
);

CREATE TABLE IF NOT EXISTS public.cadastro_certificado_respostas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trabalho_id uuid NOT NULL REFERENCES public.cadastro_certificado_trabalhos(id) ON DELETE CASCADE,
  pendencia_id uuid NOT NULL,
  instancia text NOT NULL,
  mensagem_id text NOT NULL,
  texto text NOT NULL CHECK (length(texto) BETWEEN 1 AND 2000),
  estado text NOT NULL DEFAULT 'pendente'
    CHECK (estado IN ('pendente','analisando','processado','falha')),
  reserva uuid,
  reservado_em timestamptz,
  tentativas integer NOT NULL DEFAULT 0,
  proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  diagnostico text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instancia, mensagem_id)
);

CREATE INDEX IF NOT EXISTS cadastro_avisos_fila
  ON public.cadastro_certificado_avisos (proxima_tentativa_em)
  WHERE estado IN ('pendente','preparado','enviando');

CREATE INDEX IF NOT EXISTS cadastro_respostas_fila
  ON public.cadastro_certificado_respostas (proxima_tentativa_em)
  WHERE estado IN ('pendente','analisando');

-- Privilegios das tabelas internas: apenas backend. Sem RLS permissiva.
ALTER TABLE public.cadastro_certificado_trabalhos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cadastro_certificado_avisos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cadastro_certificado_respostas ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.cadastro_certificado_trabalhos,
  public.cadastro_certificado_avisos, public.cadastro_certificado_respostas
  FROM PUBLIC, anon, authenticated;

DO $permissoes$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public.cadastro_certificado_trabalhos,
      public.cadastro_certificado_avisos, public.cadastro_certificado_respostas
      TO service_role;
  END IF;
END
$permissoes$;

-- Falha fechada se alguma coluna preexistente tiver tipo divergente.
DO $validar$
DECLARE
  c record;
  t text;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('medicos','solicitar_cpf_direto_paciente','bool'),
      ('medico_servicos_fiscais','aliquota_iss','numeric'),
      ('medico_servicos_fiscais','parametros_emissao','jsonb'),
      ('medico_servicos_fiscais','ctrib_mun','text'),
      ('medico_perfil_fiscal','proximo_numero_dps','int8'),
      ('medico_perfil_fiscal','serie_dps','text'),
      ('medico_perfil_fiscal','opcao_simples_nacional','text'),
      ('medico_perfil_fiscal','extraido_automaticamente','bool'),
      ('medico_perfil_fiscal','dados_reforma_tributaria','jsonb'),
      ('medico_perfil_fiscal','cnae','text'),
      ('cadastro_certificado_trabalhos','id','uuid'),
      ('cadastro_certificado_trabalhos','medico_id','uuid'),
      ('cadastro_certificado_trabalhos','certificado_id','uuid'),
      ('cadastro_certificado_trabalhos','estado','text'),
      ('cadastro_certificado_trabalhos','snapshot','jsonb'),
      ('cadastro_certificado_trabalhos','dados','jsonb'),
      ('cadastro_certificado_trabalhos','proxima_tentativa_em','timestamptz'),
      ('cadastro_certificado_avisos','trabalho_id','uuid'),
      ('cadastro_certificado_avisos','estado','text'),
      ('cadastro_certificado_avisos','texto','text'),
      ('cadastro_certificado_respostas','trabalho_id','uuid'),
      ('cadastro_certificado_respostas','instancia','text'),
      ('cadastro_certificado_respostas','mensagem_id','text')
    ) AS esperado(tabela,coluna,tipo)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns x
      WHERE x.table_schema='public' AND x.table_name=c.tabela
        AND x.column_name=c.coluna AND x.udt_name=c.tipo
    ) THEN
      RAISE EXCEPTION 'ONBOARDING_COLUNA_INCOMPATIVEL %.% (esperado %)',
        c.tabela, c.coluna, c.tipo;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='medico_perfil_fiscal'
      AND column_name='extraido_automaticamente' AND is_nullable='NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='medicos'
      AND column_name='solicitar_cpf_direto_paciente' AND is_nullable='NO'
  ) THEN
    RAISE EXCEPTION 'ONBOARDING_PREFERENCIAS_BOOLEANAS_INVALIDAS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.cadastro_certificado_trabalhos'::regclass
      AND contype = 'u' AND pg_get_constraintdef(oid) = 'UNIQUE (certificado_id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.cadastro_certificado_trabalhos'::regclass
      AND contype='f' AND confrelid='public.medico_certificados'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.cadastro_certificado_trabalhos'::regclass
      AND contype='f' AND confrelid='public.medicos'::regclass
  ) THEN
    RAISE EXCEPTION 'ONBOARDING_TRABALHOS_CONSTRAINTS_INVALIDAS';
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'cadastro_certificado_trabalhos','cadastro_certificado_avisos','cadastro_certificado_respostas'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE n.nspname='public' AND r.relname=t AND r.relrowsecurity=true
    ) THEN
      RAISE EXCEPTION 'ONBOARDING_RLS_AUSENTE: %',t;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public'
      AND table_name IN ('cadastro_certificado_trabalhos','cadastro_certificado_avisos','cadastro_certificado_respostas')
      AND grantee IN ('anon','authenticated')
      AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE')
  ) THEN
    RAISE EXCEPTION 'ONBOARDING_PRIVILEGIOS_CLIENTE_INDEVIDOS';
  END IF;

  -- Nenhum campo fiscal da migracao pode vir com valor padrao presumido.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND (
      (table_name='medico_servicos_fiscais' AND column_name IN ('aliquota_iss','parametros_emissao','ctrib_mun'))
      OR (table_name='medico_perfil_fiscal' AND column_name IN (
        'proximo_numero_dps','serie_dps','opcao_simples_nacional','dados_reforma_tributaria','cnae'))
    ) AND column_default IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ONBOARDING_VALOR_FISCAL_PRESUMIDO';
  END IF;
END
$validar$;

COMMIT;
