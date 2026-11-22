-- Run only in an isolated test database after migrations 01-05.
-- psql -v ON_ERROR_STOP=1 -f tests/sql/noto-intelligence-contratos.sql
BEGIN;
DO $$
DECLARE c1 uuid:=gen_random_uuid();c2 uuid:=gen_random_uuid();m1 uuid:=gen_random_uuid();m2 uuid:=gen_random_uuid();p1 uuid:=gen_random_uuid();a1 uuid:=gen_random_uuid();s1 uuid:=gen_random_uuid();v text;
BEGIN
 INSERT INTO public.contas(id,nome) VALUES(c1,'sql-test-one'),(c2,'sql-test-two');
 INSERT INTO public.medicos(id,conta_id,nome_completo) VALUES(m1,c1,'sql-test-doctor-one'),(m2,c2,'sql-test-doctor-two');
 INSERT INTO public.pacientes(id,medico_id,telefone) VALUES(p1,m1,'sql-test-phone');
 BEGIN
  INSERT INTO public.agendamentos(medico_id,paciente_id,data_hora) VALUES(m2,p1,now());
  RAISE EXCEPTION 'FAIL cross-physician appointment accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 INSERT INTO public.agendamentos(id,medico_id,paciente_id,data_hora,origem,referencia_externa) VALUES(a1,m1,p1,now(),'amplimed','sql-test-external');
 BEGIN
  INSERT INTO public.agendamentos(medico_id,paciente_id,data_hora,origem,referencia_externa) VALUES(m1,p1,now(),'amplimed','sql-test-external');
  RAISE EXCEPTION 'FAIL duplicate appointment accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 INSERT INTO public.solicitacoes_nota(id,medico_id,paciente_id,xdesc_serv,valor_servico_centavos,ctrib_nac) VALUES(s1,m1,p1,'sql-test',10000,'010101');
 INSERT INTO public.notas_fiscais(medico_id,solicitacao_id,chave_acesso,ndps,competencia,data_emissao,valor_servicos_centavos) VALUES(m1,s1,'sql-test-key',1,'2026-11',now(),10000);
 BEGIN
  INSERT INTO public.notas_fiscais(medico_id,solicitacao_id,chave_acesso,ndps,competencia,data_emissao,valor_servicos_centavos) VALUES(m1,s1,'sql-test-key-2',2,'2026-11',now(),10000);
  RAISE EXCEPTION 'FAIL duplicate invoice accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 IF EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee IN ('anon','authenticated') AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE')) THEN
 RAISE EXCEPTION 'FAIL direct client grants detected';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity) THEN
 RAISE EXCEPTION 'FAIL public table without RLS';
 END IF;
 IF to_regclass('public.login_otp_email') IS NULL OR to_regclass('public.login_otp_email_auditoria') IS NULL THEN
 RAISE EXCEPTION 'FAIL email OTP tables missing';
 END IF;
 RAISE NOTICE 'PASS Noto Intelligence schema constraints';
END $$;
ROLLBACK;
