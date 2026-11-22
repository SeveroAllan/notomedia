-- Preferências conversacionais de emissão da conta (capturadas pela IA no WhatsApp).
-- Proposta local: aplicar somente após revisão/aprovação explícita em produção.

CREATE TABLE IF NOT EXISTS public.conta_preferencias_emissao (
  conta_id uuid PRIMARY KEY REFERENCES public.contas(id) ON DELETE CASCADE,
  emitir_apenas_com_comprovante boolean,
  revisao_diaria_agenda boolean,
  enviar_nota_para_paciente boolean,
  pedir_aprovacao_antes_emitir boolean,
  solicitar_cpf_direto_paciente boolean,
  configuracao_concluida_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.conta_preferencias_emissao ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.conta_preferencias_emissao FROM public;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.conta_preferencias_emissao FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.conta_preferencias_emissao FROM authenticated';
  END IF;
END $$;
