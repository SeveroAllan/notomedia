-- Nova permissão solicitar_cpf (valores 'medico' | 'paciente'): a quem o Noto pergunta
-- quando o CPF do paciente falta na agenda e na conversa recente. Só alarga CHECKs;
-- nenhum dado muda e a ausência de escolha continua sem autorizar nada.
begin;

alter table public.noto_permissoes drop constraint noto_permissoes_permissao_check;
alter table public.noto_permissoes add constraint noto_permissoes_permissao_check
  check (permissao in ('emitir_autonomo','entregar_paciente','solicitar_cpf'));

alter table public.noto_permissoes drop constraint noto_permissoes_check;
alter table public.noto_permissoes add constraint noto_permissoes_check
  check (
    (permissao='emitir_autonomo' and valor in ('autonomo','sempre_perguntar'))
    or (permissao='entregar_paciente' and valor in ('paciente','so_medico'))
    or (permissao='solicitar_cpf' and valor in ('medico','paciente')));

alter table public.noto_permissoes_links drop constraint noto_permissoes_links_permissao_check;
alter table public.noto_permissoes_links add constraint noto_permissoes_links_permissao_check
  check (permissao in ('emitir_autonomo','entregar_paciente','solicitar_cpf'));

commit;
