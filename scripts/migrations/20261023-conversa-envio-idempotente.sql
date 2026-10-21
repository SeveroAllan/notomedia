-- Preparada para aplicação manual. Não executada pelo aplicativo.
begin;
lock table public.conversa_mensagens in share row exclusive mode;
-- As antigas cópias por variante de telefone mantêm somente a primeira linha.
delete from public.conversa_mensagens duplicada using public.conversa_mensagens primeira
where duplicada.medico_id=primeira.medico_id and duplicada.mensagem_id=primeira.mensagem_id
  and duplicada.id>primeira.id;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.conversa_mensagens'::regclass
      and conname='conversa_mensagens_medico_mensagem_unica') then
    alter table public.conversa_mensagens add constraint conversa_mensagens_medico_mensagem_unica unique (medico_id, mensagem_id);
  end if;
end $$;
alter table public.cofre_links_auditoria drop constraint if exists cofre_links_auditoria_evento_check;
alter table public.cofre_links_auditoria add constraint cofre_links_auditoria_evento_check
  check (evento in ('criado', 'aberto', 'enviado', 'expirado', 'concluido'));
commit;
