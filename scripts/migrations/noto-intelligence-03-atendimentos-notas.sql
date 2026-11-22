-- Noto Intelligence: patient/consultation/fiscal queue foundations.
-- Not sufficient to activate fiscal issuance; application contracts still need reconciliation.
BEGIN;
CREATE TABLE public.medico_servicos_fiscais (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 medico_id uuid NOT NULL REFERENCES public.medicos(id),
 nome_servico text NOT NULL,
 ctrib_nac text NOT NULL,
 cnbs text,
 xdesc_serv text NOT NULL,
 valor_padrao_centavos integer CHECK(valor_padrao_centavos >= 0),
 padrao boolean NOT NULL DEFAULT false,
 ativo boolean NOT NULL DEFAULT true,
 UNIQUE(medico_id,nome_servico),
 UNIQUE(id,medico_id)
);
CREATE UNIQUE INDEX medico_servico_padrao_unico ON public.medico_servicos_fiscais(medico_id) WHERE padrao AND ativo;
CREATE TABLE public.pacientes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 medico_id uuid NOT NULL REFERENCES public.medicos(id),
 nome text,
 nome_validado boolean NOT NULL DEFAULT false,
 data_nascimento date,
 cpf_cnpj_hash text,
 cpf_cnpj_encriptado bytea,
 email text,
 telefone text NOT NULL,
 origem_cadastro text NOT NULL DEFAULT 'conversa',
 cep text,
 cod_municipio_ibge text,
 logradouro text,
 numero text,
 complemento text,
 bairro text,
 criado_em timestamptz NOT NULL DEFAULT now(),
 atualizado_em timestamptz NOT NULL DEFAULT now(),
 UNIQUE(medico_id,telefone),
 UNIQUE(id,medico_id)
);
CREATE TABLE public.agendamentos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 medico_id uuid NOT NULL REFERENCES public.medicos(id),
 paciente_id uuid NOT NULL,
 data_hora timestamptz NOT NULL,
 servico_fiscal_id uuid,
 valor_consulta_centavos integer CHECK(valor_consulta_centavos >= 0),
 status text NOT NULL DEFAULT 'agendado' CHECK(status IN ('agendado','confirmado','realizado','cancelado','faltou')),
 origem text NOT NULL DEFAULT 'whatsapp_comando',
 identificacao_profissional_confirmada boolean NOT NULL DEFAULT false,
 referencia_externa text,
 criado_em timestamptz NOT NULL DEFAULT now(),
 atualizado_em timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,medico_id),
 FOREIGN KEY(paciente_id,medico_id) REFERENCES public.pacientes(id,medico_id),
 FOREIGN KEY(servico_fiscal_id,medico_id) REFERENCES public.medico_servicos_fiscais(id,medico_id)
);
CREATE UNIQUE INDEX agendamento_origem_unico ON public.agendamentos(medico_id,origem,referencia_externa) WHERE referencia_externa IS NOT NULL;
CREATE TABLE public.solicitacoes_nota (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 medico_id uuid NOT NULL REFERENCES public.medicos(id),
 paciente_id uuid NOT NULL,
 servico_fiscal_id uuid,
 xdesc_serv text NOT NULL,
 valor_servico_centavos integer NOT NULL CHECK(valor_servico_centavos >= 0),
 ctrib_nac text NOT NULL,
 cnbs text,
 cclass_trib text,
 cind_op text,
 origem text NOT NULL DEFAULT 'automatico_pagamento',
 status text NOT NULL DEFAULT 'pendente' CHECK(status IN ('pendente','pronta','simulada','emitida','erro','excecao','aguardando_garantia','pendente_cadastro','pronta_sem_endereco')),
 fila text CHECK(fila IN ('pronta','pendente_cadastro','aguardando_garantia','excecao','pronta_sem_endereco')),
 erro text,
 tentativas integer NOT NULL DEFAULT 0 CHECK(tentativas >= 0),
 proxima_tentativa_em timestamptz,
 bloqueada_por_worker text,
 bloqueada_em timestamptz,
 aguardando_dados_profissionais boolean NOT NULL DEFAULT false,
 aguardando_confirmacao_medico boolean NOT NULL DEFAULT false,
 datas_consulta_texto text,
 criado_em timestamptz NOT NULL DEFAULT now(),
 atualizado_em timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,medico_id),
 FOREIGN KEY(paciente_id,medico_id) REFERENCES public.pacientes(id,medico_id),
 FOREIGN KEY(servico_fiscal_id,medico_id) REFERENCES public.medico_servicos_fiscais(id,medico_id)
);
CREATE INDEX solicitacoes_fila_idx ON public.solicitacoes_nota(status,proxima_tentativa_em) WHERE status IN ('pronta','pendente');
CREATE TABLE public.solicitacao_nota_agendamentos (
 solicitacao_id uuid NOT NULL,
 agendamento_id uuid NOT NULL,
 medico_id uuid NOT NULL,
 PRIMARY KEY(solicitacao_id,agendamento_id),
 UNIQUE(agendamento_id),
 FOREIGN KEY(solicitacao_id,medico_id) REFERENCES public.solicitacoes_nota(id,medico_id),
 FOREIGN KEY(agendamento_id,medico_id) REFERENCES public.agendamentos(id,medico_id)
);
CREATE TABLE public.notas_fiscais (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 medico_id uuid NOT NULL REFERENCES public.medicos(id),
 solicitacao_id uuid NOT NULL UNIQUE,
 chave_acesso text NOT NULL UNIQUE,
 ndps integer NOT NULL CHECK(ndps > 0),
 serie text NOT NULL DEFAULT '00001',
 competencia char(7) NOT NULL CHECK(competencia ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 data_emissao timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'autorizada' CHECK(status IN ('autorizada','cancelada','erro','substituida')),
 valor_servicos_centavos integer NOT NULL CHECK(valor_servicos_centavos >= 0),
 valor_iss_centavos integer,
 valor_cbs_centavos integer,
 valor_ibs_centavos integer,
 xml_storage_path text,
 pdf_storage_path text,
 cancelada_em timestamptz,
 motivo_cancelamento text,
 enviada_por_email_em timestamptz,
 resposta_sefin_raw jsonb,
 criado_em timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(solicitacao_id,medico_id) REFERENCES public.solicitacoes_nota(id,medico_id),
 UNIQUE(medico_id,serie,ndps)
);
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['medico_servicos_fiscais','pacientes','agendamentos','solicitacoes_nota','solicitacao_nota_agendamentos','notas_fiscais'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',t);
 END LOOP;
 IF EXISTS(SELECT 1 FROM information_schema.role_table_grants
 WHERE table_schema='public' AND table_name IN ('medico_servicos_fiscais','pacientes','agendamentos','solicitacoes_nota','solicitacao_nota_agendamentos','notas_fiscais')
 AND grantee IN ('anon','authenticated') AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE'))
 THEN RAISE EXCEPTION 'unexpected client privilege'; END IF;
END $$;
COMMIT;
