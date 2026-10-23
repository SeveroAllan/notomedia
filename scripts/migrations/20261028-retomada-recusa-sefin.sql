-- Proposta: retomada de emissão após recusa definitiva comprovada da SEFIN. NÃO APLICADA.
-- Aplicar somente com "pode rodar" explícito do Allan, em homologação, depois da revisão.
-- Efeitos: colunas novas em noto_emissoes_comprovantes; índice único por consulta vira parcial
-- (uma emissão ATIVA por consulta; substituídas saem do índice). Nenhuma linha existente muda:
-- todas ficam com recusa_definitiva=false (travadas) e substituida_em nula (no índice).
begin;

alter table public.noto_emissoes_comprovantes
  add column if not exists dps_id text null,
  add column if not exists recusa_definitiva boolean not null default false,
  add column if not exists tentativa integer not null default 1,
  add column if not exists substituida_em timestamptz null,
  add column if not exists substituida_por uuid null references public.noto_emissoes_comprovantes(id);

-- Identificador oficial da DPS ("DPS" + 42 dígitos), persistido no momento da transmissão.
alter table public.noto_emissoes_comprovantes
  drop constraint if exists noto_emissoes_dps_id_formato;
alter table public.noto_emissoes_comprovantes
  add constraint noto_emissoes_dps_id_formato check (dps_id is null or dps_id ~ '^DPS[0-9]{42}$');

-- Substituição só vale para recusa definitiva sem nota gerada.
alter table public.noto_emissoes_comprovantes
  drop constraint if exists noto_emissoes_substituicao_check;
alter table public.noto_emissoes_comprovantes
  add constraint noto_emissoes_substituicao_check check (
    substituida_em is null
    or (estado = 'erro' and recusa_definitiva and nota_fiscal_id is null)
  );

-- Exclusão mútua: no máximo UMA emissão ativa por (medico, consulta), inclusive sob concorrência.
-- A recriação é atômica nesta transação; criarSolicitacao já serializa por médico com advisory lock.
drop index if exists public.noto_emissoes_medico_consulta_chave;
create unique index noto_emissoes_medico_consulta_chave
  on public.noto_emissoes_comprovantes (medico_id, consulta_chave)
  where substituida_em is null;

commit;
