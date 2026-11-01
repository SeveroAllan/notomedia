-- Noto Intelligence: missing baseline WhatsApp, scheduling and payment contracts.
-- Code-only migration: do not apply without integration testing.
BEGIN;
CREATE TABLE public.whatsapp_instancias (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 medico_id uuid REFERENCES public.medicos(id) ON DELETE CASCADE,
 conta_id uuid NOT NULL REFERENCES public.contas(id) ON DELETE CASCADE,
 oficial boolean NOT NULL DEFAULT false,
 nome_instancia text NOT NULL UNIQUE,
 numero_telefone text,
 status text NOT NULL DEFAULT 'pendente' CHECK(status IN ('pendente','conectado','desconectado','erro')),
 webhook_configurado boolean NOT NULL DEFAULT false,
 conectado_em timestamptz,
 criado_em timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,conta_id)
);
CREATE INDEX whatsapp_instancias_conta_idx ON public.whatsapp_instancias(conta_id);
CREATE INDEX whatsapp_instancias_medico_idx ON public.whatsapp_instancias(medico_id);
CREATE TABLE public.whatsapp_conversas (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 instancia_id uuid NOT NULL REFERENCES public.whatsapp_instancias(id) ON DELETE CASCADE,
 medico_id uuid NOT NULL REFERENCES public.medicos(id) ON DELETE CASCADE,
 contato_telefone text NOT NULL,
 contato_nome text,
 paciente_id uuid,
 aguardando_cpf_desde timestamptz,
 ultima_mensagem_em timestamptz,
 criado_em timestamptz NOT NULL DEFAULT now(),
 UNIQUE(instancia_id,contato_telefone),
 FOREIGN KEY(paciente_id,medico_id) REFERENCES public.pacientes(id,medico_id)
);
CREATE INDEX whatsapp_conversas_medico_idx ON public.whatsapp_conversas(medico_id);
CREATE INDEX whatsapp_conversas_paciente_idx ON public.whatsapp_conversas(paciente_id,medico_id);
CREATE TABLE public.medico_respostas_rapidas (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 medico_id uuid NOT NULL REFERENCES public.medicos(id) ON DELETE CASCADE,
 tipo text NOT NULL CHECK(tipo IN ('agendado','emissao')),
 texto_modelo text NOT NULL,
 UNIQUE(medico_id,tipo)
);
CREATE TABLE public.whatsapp_mensagens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 conversa_id uuid NOT NULL REFERENCES public.whatsapp_conversas(id) ON DELETE CASCADE,
 direcao text NOT NULL CHECK(direcao IN ('recebida','enviada')),
 tipo_mensagem text NOT NULL DEFAULT 'texto',
 conteudo text,
 payload_bruto jsonb,
 comando_detectado text,
 processada boolean NOT NULL DEFAULT false,
 criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_mensagens_conversa_data_idx ON public.whatsapp_mensagens(conversa_id,criado_em DESC);
CREATE TABLE public.agenda_slots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 medico_id uuid NOT NULL REFERENCES public.medicos(id) ON DELETE CASCADE,
 data date NOT NULL,
 hora_inicio time NOT NULL,
 hora_fim time NOT NULL,
 disponivel boolean NOT NULL DEFAULT true,
 agendamento_id uuid,
 criado_em timestamptz NOT NULL DEFAULT now(),
 UNIQUE(medico_id,data,hora_inicio),
 CHECK(hora_fim > hora_inicio),
 FOREIGN KEY(agendamento_id,medico_id) REFERENCES public.agendamentos(id,medico_id)
);
CREATE INDEX agenda_slots_agendamento_idx ON public.agenda_slots(agendamento_id,medico_id);
CREATE TABLE public.pagamentos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 medico_id uuid NOT NULL REFERENCES public.medicos(id) ON DELETE CASCADE,
 agendamento_id uuid,
 paciente_id uuid NOT NULL,
 valor_centavos integer NOT NULL CHECK(valor_centavos >= 0),
 forma_pagamento text NOT NULL CHECK(forma_pagamento IN ('pix','dinheiro','cartao_credito','cartao_debito','transferencia','outro')),
 status text NOT NULL DEFAULT 'pendente' CHECK(status IN ('pendente','confirmado','cancelado','estornado')),
 open_finance_transacao_id text,
 comprovante_storage_path text,
 confirmado_em timestamptz,
 criado_em timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(agendamento_id,medico_id) REFERENCES public.agendamentos(id,medico_id),
 FOREIGN KEY(paciente_id,medico_id) REFERENCES public.pacientes(id,medico_id)
);
CREATE INDEX pagamentos_medico_data_idx ON public.pagamentos(medico_id,criado_em DESC);
CREATE INDEX pagamentos_agendamento_idx ON public.pagamentos(agendamento_id,medico_id);
CREATE INDEX pagamentos_paciente_idx ON public.pagamentos(paciente_id,medico_id);
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['whatsapp_instancias','whatsapp_conversas','medico_respostas_rapidas','whatsapp_mensagens','agenda_slots','pagamentos'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',t);
 END LOOP;
 IF EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema='public'
 AND table_name IN ('whatsapp_instancias','whatsapp_conversas','medico_respostas_rapidas','whatsapp_mensagens','agenda_slots','pagamentos')
 AND grantee IN ('anon','authenticated') AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE'))
 THEN RAISE EXCEPTION 'Unexpected client privileges'; END IF;
END $$;
COMMIT;
