-- Compatibility with PostgresOtpEmailRepositorio. Not applied to any database.
BEGIN;
CREATE TABLE public.login_otp_email (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 email_hash text NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
 auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 codigo_hash text NOT NULL,
 tentativas integer NOT NULL DEFAULT 0 CHECK(tentativas >= 0),
 expira_em timestamptz NOT NULL,
 verificado_em timestamptz,
 criado_em timestamptz NOT NULL DEFAULT now(),
 envio_confirmado boolean NOT NULL DEFAULT false
);
CREATE INDEX login_otp_email_email_recent_idx ON public.login_otp_email(email_hash,criado_em DESC,id DESC);
CREATE TABLE public.login_otp_email_auditoria (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 email_hash text NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
 evento text NOT NULL,
 criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_otp_email_auditoria_recent_idx ON public.login_otp_email_auditoria(email_hash,criado_em DESC);
ALTER TABLE public.login_otp_email ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_otp_email_auditoria ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.login_otp_email,public.login_otp_email_auditoria FROM PUBLIC,anon,authenticated;
DO $$
BEGIN
 IF EXISTS (
 SELECT 1 FROM information_schema.role_table_grants
 WHERE table_schema='public' AND table_name IN ('login_otp_email','login_otp_email_auditoria')
 AND grantee IN ('anon','authenticated') AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE')
 ) THEN RAISE EXCEPTION 'Client grants on private OTP tables'; END IF;
END $$;
COMMIT;
