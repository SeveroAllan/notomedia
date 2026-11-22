-- Noto Intelligence: only operational WhatsApp instance and physician response templates.\n-- No patient, appointment, slot, payment or message persistence.
-- Code-only migration: do not apply without integration testing.
BEGIN;
ALTER TABLE public.medicos ADD CONSTRAINT medicos_id_conta_unique UNIQUE(id,conta_id);
CREATE TABLE public.whatsapp_instancias (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 medico_id uuid,
 conta_id uuid NOT NULL REFERENCES public.contas(id) ON DELETE CASCADE,
 oficial boolean NOT NULL DEFAULT false,
 nome_instancia text NOT NULL UNIQUE,
 numero_telefone text,
 status text NOT NULL DEFAULT 'pendente' CHECK(status IN ('pendente','conectado','desconectado','erro')),
 webhook_configurado boolean NOT NULL DEFAULT false,
 conectado_em timestamptz,
 criado_em timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,conta_id),
 FOREIGN KEY(medico_id,conta_id) REFERENCES public.medicos(id,conta_id)
);
CREATE INDEX whatsapp_instancias_conta_idx ON public.whatsapp_instancias(conta_id);
CREATE INDEX whatsapp_instancias_medico_idx ON public.whatsapp_instancias(medico_id);
CREATE TABLE public.medico_respostas_rapidas (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 medico_id uuid NOT NULL REFERENCES public.medicos(id) ON DELETE CASCADE,
 tipo text NOT NULL CHECK(tipo IN ('agendado','emissao')),
 texto_modelo text NOT NULL,
 UNIQUE(medico_id,tipo)
);
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['whatsapp_instancias','medico_respostas_rapidas'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',t);
 END LOOP;
 IF EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema='public'
 AND table_name IN ('whatsapp_instancias','medico_respostas_rapidas')
 AND grantee IN ('anon','authenticated') AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE'))
 THEN RAISE EXCEPTION 'Unexpected client privileges'; END IF;
END $$;
COMMIT;
