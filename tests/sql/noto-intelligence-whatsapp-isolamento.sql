-- Run against a disposable database with Noto Intelligence migrations 01-06 applied.
-- All fixtures are reverted.
BEGIN;
DO $$
DECLARE a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();ma uuid:=gen_random_uuid();mb uuid:=gen_random_uuid();wa uuid:=gen_random_uuid();p uuid:=gen_random_uuid();ag uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.contas(id,nome) VALUES(a,'contract-account-a'),(b,'contract-account-b');
 INSERT INTO public.medicos(id,conta_id,nome_completo) VALUES(ma,a,'contract-medico-a'),(mb,b,'contract-medico-b');
 BEGIN
  INSERT INTO public.whatsapp_instancias(medico_id,conta_id,nome_instancia) VALUES(mb,a,'invalid-cross-account');
  RAISE EXCEPTION 'FAIL cross-account instance allowed';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 INSERT INTO public.whatsapp_instancias(id,medico_id,conta_id,nome_instancia) VALUES(wa,ma,a,'contract-whatsapp');
 BEGIN
  INSERT INTO public.whatsapp_conversas(instancia_id,conta_id,medico_id,contato_telefone) VALUES(wa,a,mb,'51900000000');
  RAISE EXCEPTION 'FAIL cross-account conversation allowed';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 INSERT INTO public.pacientes(id,medico_id,telefone) VALUES(p,ma,'51911111111');
 INSERT INTO public.agendamentos(id,medico_id,paciente_id,data_hora) VALUES(ag,ma,p,now());
 BEGIN
  INSERT INTO public.pagamentos(medico_id,agendamento_id,paciente_id,valor_centavos,forma_pagamento) VALUES(mb,ag,p,10000,'pix');
  RAISE EXCEPTION 'FAIL cross-medico payment allowed';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN
  INSERT INTO public.agenda_slots(medico_id,data,hora_inicio,hora_fim,agendamento_id) VALUES(mb,current_date,'10:00','11:00',ag);
  RAISE EXCEPTION 'FAIL cross-medico slot allowed';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename IN ('whatsapp_instancias','whatsapp_conversas','whatsapp_mensagens','medico_respostas_rapidas','agenda_slots','pagamentos') AND NOT rowsecurity)
 THEN RAISE EXCEPTION 'FAIL missing RLS'; END IF;
 RAISE NOTICE 'PASS cross-tenant WhatsApp, agenda and payments';
END $$;
ROLLBACK;
