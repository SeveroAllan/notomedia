-- PREPARO PARA REVISAO: NAO EXECUTAR SEM AUTORIZACAO.
-- Entrada A: banco com contas/medicos, sem cofre_links nem auditoria.
-- Entrada B: as duas tabelas criadas EXATAMENTE por 20261020-cofre-links.sql.
-- Entrada C: banco com links por conta ja habilitados por 20261105.
-- Uma transacao, sem DELETE/TRUNCATE/UPDATE de links; compativel com o backend anterior.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '90s';

DO $$
BEGIN
  IF to_regclass('public.contas') IS NULL OR to_regclass('public.medicos') IS NULL THEN
    RAISE EXCEPTION 'COFRE_PRE_REQUISITOS_CONTAS_MEDICOS_AUSENTES';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    RAISE EXCEPTION 'COFRE_ROLES_SUPABASE_AUSENTES';
  END IF;
END $$;

-- O IF NOT EXISTS aqui so cuida do caso de tabela AUSENTE. A estrutura
-- existente e verificada explicitamente abaixo, antes do COMMIT.
CREATE TABLE IF NOT EXISTS public.cofre_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medico_id uuid REFERENCES public.medicos(id) ON DELETE CASCADE,
  conta_id uuid REFERENCES public.contas(id) ON DELETE CASCADE,
  agenda text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expira_em timestamptz NOT NULL,
  usado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  destino_telefone text,
  CONSTRAINT cofre_links_titular_exclusivo
    CHECK ((medico_id IS NOT NULL AND conta_id IS NULL)
        OR (medico_id IS NULL AND conta_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.cofre_links_auditoria (
  link_id uuid NOT NULL REFERENCES public.cofre_links(id) ON DELETE CASCADE,
  evento text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, evento),
  CONSTRAINT cofre_links_auditoria_evento_check
    CHECK (evento IN ('criado','aberto','enviado','expirado','concluido'))
);

-- Completar o formato antigo sem alterar ou recarimbar links anteriores.
ALTER TABLE public.cofre_links ADD COLUMN IF NOT EXISTS destino_telefone text;
ALTER TABLE public.cofre_links ADD COLUMN IF NOT EXISTS conta_id uuid;
ALTER TABLE public.cofre_links ALTER COLUMN medico_id DROP NOT NULL;

-- A FK de conta nao estava presente na migracao de 20261020.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
    WHERE c.conrelid='public.cofre_links'::regclass AND c.contype='f'
      AND a.attname='conta_id' AND c.confrelid='public.contas'::regclass
      AND c.confdeltype='c'
  ) THEN
    ALTER TABLE public.cofre_links ADD CONSTRAINT cofre_links_conta_id_fkey
      FOREIGN KEY (conta_id) REFERENCES public.contas(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Validar/normalizar a exclusividade do titular em todos os pontos de partida.
-- A adicao falha com rollback total se existirem links sem dono ou com dois donos.
ALTER TABLE public.cofre_links DROP CONSTRAINT IF EXISTS cofre_links_titular_exclusivo;
ALTER TABLE public.cofre_links ADD CONSTRAINT cofre_links_titular_exclusivo
  CHECK ((medico_id IS NOT NULL AND conta_id IS NULL)
      OR (medico_id IS NULL AND conta_id IS NOT NULL));

-- O antigo CHECK permitia somente criado/aberto/enviado/expirado.
-- Nao apagar eventos: substituir o CHECK e preservar integralmente a auditoria.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.cofre_links_auditoria
    WHERE evento IS NULL OR evento NOT IN ('criado','aberto','enviado','expirado','concluido')
  ) THEN RAISE EXCEPTION 'COFRE_AUDITORIA_EVENTO_DESCONHECIDO'; END IF;
  -- Nao remover outras restricoes ad-hoc silenciosamente: elas podem
  -- impedir 'concluido' e precisam de revisao especifica.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
    WHERE c.conrelid='public.cofre_links_auditoria'::regclass
      AND c.contype='c' AND a.attname='evento'
      AND c.conname <> 'cofre_links_auditoria_evento_check'
  ) THEN RAISE EXCEPTION 'COFRE_AUDITORIA_CHECK_ADICIONAL_INCOMPATIVEL'; END IF;
END $$;
ALTER TABLE public.cofre_links_auditoria
  DROP CONSTRAINT IF EXISTS cofre_links_auditoria_evento_check;
ALTER TABLE public.cofre_links_auditoria
  ADD CONSTRAINT cofre_links_auditoria_evento_check
    CHECK (evento IN ('criado','aberto','enviado','expirado','concluido'));

CREATE INDEX IF NOT EXISTS cofre_links_medico_criado
  ON public.cofre_links(medico_id, criado_em);
CREATE INDEX IF NOT EXISTS cofre_links_conta_criado
  ON public.cofre_links(conta_id, criado_em DESC, id DESC)
  WHERE conta_id IS NOT NULL;

ALTER TABLE public.cofre_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cofre_links_auditoria ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cofre_links, public.cofre_links_auditoria
  FROM PUBLIC, anon, authenticated;
-- Apenas o backend com credenciais de servico administra os links.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON public.cofre_links, public.cofre_links_auditoria TO service_role;
  END IF;
END $$;

DO $$
DECLARE
  alvo record;
BEGIN
  -- Verificacoes finais de forma, inclusive quando CREATE IF NOT EXISTS
  -- encontrou tabelas existentes (nenhuma estrutura incorreta e aceita).
  FOR alvo IN
    SELECT * FROM (VALUES
      ('cofre_links','id','uuid','NO'),
      ('cofre_links','medico_id','uuid','YES'),
      ('cofre_links','conta_id','uuid','YES'),
      ('cofre_links','agenda','text','NO'),
      ('cofre_links','token_hash','text','NO'),
      ('cofre_links','expira_em','timestamptz','NO'),
      ('cofre_links','usado_em','timestamptz','YES'),
      ('cofre_links','criado_em','timestamptz','NO'),
      ('cofre_links','destino_telefone','text','YES'),
      ('cofre_links_auditoria','link_id','uuid','NO'),
      ('cofre_links_auditoria','evento','text','NO'),
      ('cofre_links_auditoria','criado_em','timestamptz','NO')
    ) AS esperado(tabela,coluna,tipo,anulavel)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name=alvo.tabela
        AND c.column_name=alvo.coluna AND c.udt_name=alvo.tipo
        AND c.is_nullable=alvo.anulavel
    ) THEN
      RAISE EXCEPTION 'COFRE_COLUNA_INCOMPATIVEL: %.%',alvo.tabela,alvo.coluna;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.cofre_links'::regclass AND c.contype='p'
      AND c.conkey=ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='id')
      ]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.cofre_links_auditoria'::regclass AND c.contype='p'
      AND c.conkey=ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='link_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='evento')
      ]::smallint[]
  ) THEN RAISE EXCEPTION 'COFRE_CHAVE_PRIMARIA_INCOMPATIVEL'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
    WHERE c.conrelid='public.cofre_links'::regclass AND c.contype='u'
      AND a.attname='token_hash'
      AND array_length(c.conkey,1)=1
  ) THEN RAISE EXCEPTION 'COFRE_TOKEN_UNIQUE_AUSENTE'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
    WHERE c.conrelid='public.cofre_links'::regclass AND c.contype='f'
      AND a.attname='medico_id' AND c.confrelid='public.medicos'::regclass
      AND c.confdeltype='c' AND array_length(c.conkey,1)=1
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
    WHERE c.conrelid='public.cofre_links'::regclass AND c.contype='f'
      AND a.attname='conta_id' AND c.confrelid='public.contas'::regclass
      AND c.confdeltype='c' AND array_length(c.conkey,1)=1
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
    WHERE c.conrelid='public.cofre_links_auditoria'::regclass
      AND c.contype='f' AND a.attname='link_id'
      AND c.confrelid='public.cofre_links'::regclass
      AND c.confdeltype='c' AND array_length(c.conkey,1)=1
  ) THEN RAISE EXCEPTION 'COFRE_FK_INCOMPATIVEL'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.cofre_links'::regclass
      AND conname='cofre_links_titular_exclusivo'
      AND contype='c' AND convalidated
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.cofre_links_auditoria'::regclass
      AND conname='cofre_links_auditoria_evento_check'
      AND contype='c' AND convalidated
      AND pg_get_constraintdef(oid) LIKE '%concluido%'
  ) THEN RAISE EXCEPTION 'COFRE_CHECKS_INCOMPATIVEIS'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid IN ('public.cofre_links'::regclass,'public.cofre_links_auditoria'::regclass)
      AND NOT relrowsecurity
  ) THEN RAISE EXCEPTION 'COFRE_RLS_DESATIVADO'; END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public'
      AND table_name IN ('cofre_links','cofre_links_auditoria')
      AND grantee IN ('anon','authenticated')
      AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE')
  ) THEN RAISE EXCEPTION 'COFRE_ACESSO_PUBLICO_INESPERADO'; END IF;
END $$;
COMMIT;
