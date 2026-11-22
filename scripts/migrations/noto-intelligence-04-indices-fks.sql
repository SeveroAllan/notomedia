-- Indexes for foreign keys reported by Supabase performance advisor.
BEGIN;
CREATE INDEX agendamentos_paciente_medico_idx ON public.agendamentos(paciente_id,medico_id);
CREATE INDEX agendamentos_servico_medico_idx ON public.agendamentos(servico_fiscal_id,medico_id);
CREATE INDEX assinaturas_plano_idx ON public.assinaturas(plano_id);
CREATE INDEX auditoria_usuario_idx ON public.auditoria(usuario_id);
CREATE INDEX consentimentos_usuario_idx ON public.consentimentos(usuario_id);
CREATE INDEX contador_medico_medico_idx ON public.contador_medico(medico_id);
CREATE INDEX contadores_conta_idx ON public.contadores(conta_id);
CREATE INDEX notas_fiscais_solicitacao_medico_idx ON public.notas_fiscais(solicitacao_id,medico_id);
CREATE INDEX secretaria_medico_medico_idx ON public.secretaria_medico(medico_id);
CREATE INDEX secretarias_conta_idx ON public.secretarias(conta_id);
CREATE INDEX solicitacao_nota_agendamentos_agendamento_medico_idx ON public.solicitacao_nota_agendamentos(agendamento_id,medico_id);
CREATE INDEX solicitacao_nota_agendamentos_solicitacao_medico_idx ON public.solicitacao_nota_agendamentos(solicitacao_id,medico_id);
CREATE INDEX solicitacoes_nota_medico_idx ON public.solicitacoes_nota(medico_id);
CREATE INDEX solicitacoes_nota_paciente_medico_idx ON public.solicitacoes_nota(paciente_id,medico_id);
CREATE INDEX solicitacoes_nota_servico_medico_idx ON public.solicitacoes_nota(servico_fiscal_id,medico_id);
COMMIT;
