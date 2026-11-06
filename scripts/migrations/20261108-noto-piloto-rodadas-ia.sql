-- Noto piloto: orçamento atômico por rodada, global entre SDK e CRM/RQE.
-- Somente preparação para PR: NÃO EXECUTAR em homologação sem autorização.
BEGIN;
CREATE TABLE public.noto_piloto_rodadas_ia (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estado text NOT NULL CHECK (estado IN ('ativa','pausada','encerrada')),
  limite_nano_usd bigint NOT NULL DEFAULT 1000000000
    CHECK (limite_nano_usd=1000000000),
  reservado_nano_usd bigint NOT NULL DEFAULT 0 CHECK (reservado_nano_usd>=0),
  utilizado_nano_usd bigint NOT NULL DEFAULT 0 CHECK (utilizado_nano_usd>=0),
  aviso_estado text NOT NULL DEFAULT 'nenhum'
    CHECK (aviso_estado IN ('nenhum','pendente','reservado','aceito','incerto')),
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  encerrada_em timestamptz,
  CHECK (reservado_nano_usd+utilizado_nano_usd<=limite_nano_usd),
  CHECK ((estado='encerrada')=(encerrada_em IS NOT NULL))
);
-- Há no máximo uma rodada ativa. A pausa é irreversível; só um ato
-- administrativo explícito inicia uma rodada nova.
CREATE UNIQUE INDEX noto_piloto_rodada_ia_unica_ativa
 ON public.noto_piloto_rodadas_ia ((1)) WHERE estado='ativa';

CREATE TABLE public.noto_piloto_chamadas_ia (
  id uuid PRIMARY KEY,
  rodada_id uuid NOT NULL REFERENCES public.noto_piloto_rodadas_ia(id),
  finalidade text NOT NULL CHECK (finalidade IN ('conversa','crm_rqe')),
  modelo text NOT NULL CHECK (modelo='gpt-4o-mini'),
  reservado_nano_usd bigint NOT NULL CHECK (reservado_nano_usd>0),
  utilizado_nano_usd bigint CHECK (utilizado_nano_usd>=0),
  tokens_entrada bigint CHECK (tokens_entrada>=0),
  tokens_saida bigint CHECK (tokens_saida>=0),
  estado text NOT NULL CHECK (estado IN ('reservada','liquidada','incerta')),
  criada_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  finalizada_em timestamptz
);
CREATE INDEX noto_piloto_chamadas_ia_rodada
 ON public.noto_piloto_chamadas_ia(rodada_id,criada_em);

ALTER TABLE public.noto_piloto_rodadas_ia ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.noto_piloto_chamadas_ia ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.noto_piloto_rodadas_ia,public.noto_piloto_chamadas_ia
 FROM PUBLIC,anon,authenticated;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE ON public.noto_piloto_rodadas_ia,public.noto_piloto_chamadas_ia
      TO service_role;
  END IF;
  IF NOT EXISTS (
     SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='noto_piloto_rodadas_ia' AND c.relrowsecurity
  ) OR NOT EXISTS (
     SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='noto_piloto_chamadas_ia' AND c.relrowsecurity
  ) THEN RAISE EXCEPTION 'NOTO_PILOTO_IA_RLS_AUSENTE'; END IF;
END $$;
COMMIT;
