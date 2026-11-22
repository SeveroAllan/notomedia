-- Incremental foundation for hosted Supabase Noto Intelligence.
-- Deliberately does not enable fiscal issuance or create public client policies.
BEGIN;
CREATE TABLE public.planos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 nome text NOT NULL UNIQUE,
 descricao text,
 preco_mensal_centavos integer NOT NULL CHECK (preco_mensal_centavos >= 0),
 preco_anual_centavos integer CHECK (preco_anual_centavos >= 0),
 limite_medicos integer NOT NULL DEFAULT 1 CHECK (limite_medicos > 0),
 limite_notas_mes integer CHECK (limite_notas_mes >= 0),
 limite_conexoes_whatsapp integer NOT NULL DEFAULT 1 CHECK (limite_conexoes_whatsapp > 0),
 recursos jsonb NOT NULL DEFAULT '{}'::jsonb,
 ativo boolean NOT NULL DEFAULT true,
 criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.assinaturas (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 conta_id uuid NOT NULL UNIQUE REFERENCES public.contas(id) ON DELETE CASCADE,
 plano_id uuid NOT NULL REFERENCES public.planos(id),
 status text NOT NULL DEFAULT 'trial' CHECK(status IN ('trial','ativa','inadimplente','suspensa','cancelada')),
 ciclo text NOT NULL DEFAULT 'mensal' CHECK(ciclo IN ('mensal','anual')),
 trava_emissao boolean NOT NULL DEFAULT false,
 data_inicio timestamptz NOT NULL DEFAULT now(),
 data_fim_trial timestamptz,
 data_proxima_cobranca timestamptz,
 stripe_customer_id text,
 stripe_subscription_id text,
 criado_em timestamptz NOT NULL DEFAULT now(),
 atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assinaturas_stripe_customer_idx ON public.assinaturas(stripe_customer_id);
CREATE INDEX assinaturas_stripe_subscription_idx ON public.assinaturas(stripe_subscription_id);
CREATE TABLE public.faturas_assinatura (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 assinatura_id uuid NOT NULL REFERENCES public.assinaturas(id) ON DELETE CASCADE,
 valor_centavos integer NOT NULL CHECK(valor_centavos >= 0),
 status text NOT NULL DEFAULT 'pendente' CHECK(status IN ('pendente','paga','atrasada','cancelada')),
 vencimento date NOT NULL,
 pago_em timestamptz,
 gateway_referencia text,
 metodo_pagamento text,
 criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX faturas_assinatura_assinatura_status_idx ON public.faturas_assinatura(assinatura_id,status);
CREATE TABLE public.uso_mensal_medico (
 medico_id uuid NOT NULL REFERENCES public.medicos(id) ON DELETE CASCADE,
 competencia char(7) NOT NULL CHECK(competencia ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 notas_emitidas integer NOT NULL DEFAULT 0 CHECK(notas_emitidas >= 0),
 PRIMARY KEY(medico_id,competencia)
);
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['planos','assinaturas','faturas_assinatura','uso_mensal_medico'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',t);
 END LOOP;
 IF EXISTS (
  SELECT 1 FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name IN ('planos','assinaturas','faturas_assinatura','uso_mensal_medico')
    AND grantee IN ('anon','authenticated') AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE')
 ) THEN RAISE EXCEPTION 'Unexpected public table privilege'; END IF;
END $$;
COMMIT;
