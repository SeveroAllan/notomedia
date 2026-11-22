-- Memória conversacional em duas camadas (curto prazo do dia + resumos compactados
-- dos dias anteriores) isolada por conta, com sanitização na aplicação antes de gravar.
-- Proposta local: aplicar somente após revisão/aprovação explícita em produção.

CREATE TABLE IF NOT EXISTS public.noto_memoria_mensagens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_id uuid NOT NULL REFERENCES public.contas(id) ON DELETE CASCADE,
  autor text NOT NULL CHECK (autor IN ('medico', 'noto')),
  texto text NOT NULL CHECK (char_length(texto) BETWEEN 1 AND 800),
  dia_referencia date NOT NULL,
  compactada_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_noto_memoria_mensagens_conta_dia_criado
  ON public.noto_memoria_mensagens (conta_id, dia_referencia DESC, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_noto_memoria_mensagens_pendentes_compactacao
  ON public.noto_memoria_mensagens (conta_id, criado_em ASC)
  WHERE compactada_em IS NULL;

CREATE TABLE IF NOT EXISTS public.noto_memoria_resumos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_id uuid NOT NULL REFERENCES public.contas(id) ON DELETE CASCADE,
  periodo_inicio date NOT NULL,
  periodo_fim date NOT NULL,
  resumo text NOT NULL CHECK (char_length(resumo) BETWEEN 1 AND 2500),
  fatos_combinados jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_mensagens integer NOT NULL CHECK (total_mensagens > 0),
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_noto_memoria_resumos_conta_periodo
  ON public.noto_memoria_resumos (conta_id, periodo_fim DESC, criado_em DESC);

ALTER TABLE public.noto_memoria_mensagens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.noto_memoria_resumos ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.noto_memoria_mensagens FROM public;
REVOKE ALL ON TABLE public.noto_memoria_resumos FROM public;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.noto_memoria_mensagens FROM anon';
    EXECUTE 'REVOKE ALL ON TABLE public.noto_memoria_resumos FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.noto_memoria_mensagens FROM authenticated';
    EXECUTE 'REVOKE ALL ON TABLE public.noto_memoria_resumos FROM authenticated';
  END IF;
END $$;
