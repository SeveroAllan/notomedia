-- Test against disposable database with migrations 01-07.
BEGIN;
DO $$
DECLARE a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();ma uuid:=gen_random_uuid();mb uuid:=gen_random_uuid();wa uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.contas(id,nome) VALUES(a,'contract-account-a'),(b,'contract-account-b');
 INSERT INTO public.medicos(id,conta_id,nome_completo) VALUES(ma,a,'contract-medico-a'),(mb,b,'contract-medico-b');
 BEGIN
  INSERT INTO public.whatsapp_instancias(medico_id,conta_id,nome_instancia) VALUES(mb,a,'invalid-cross-account');
  RAISE EXCEPTION 'FAIL cross-account instance allowed';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 INSERT INTO public.whatsapp_instancias(id,medico_id,conta_id,nome_instancia) VALUES(wa,ma,a,'contract-whatsapp');
 IF to_regclass('public.whatsapp_conversas') IS NOT NULL OR to_regclass('public.agenda_slots') IS NOT NULL OR to_regclass('public.pagamentos') IS NOT NULL THEN
  RAISE EXCEPTION 'FAIL patient/appointment persistence tables created by migration 06';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename IN ('whatsapp_instancias','medico_respostas_rapidas') AND NOT rowsecurity)
 THEN RAISE EXCEPTION 'FAIL missing RLS'; END IF;
 RAISE NOTICE 'PASS operational WhatsApp and patient-data minimization';
END $$;
ROLLBACK;
