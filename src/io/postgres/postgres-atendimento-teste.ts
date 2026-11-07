import { createHash } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import type { EscopoEmissaoWhatsApp } from './postgres-emissao-whatsapp-repositorio.js';

const dadosSchema = z.object({
  pacienteId: z.string().uuid(),
  servicoId: z.string().uuid(),
  dataHora: z.string().datetime({offset:true}),
  valorCentavos: z.number().int().positive().max(2147483647)
});

export function prepararAtendimentoTeste(escopo:EscopoEmissaoWhatsApp, entrada:unknown, telefone:string) {
  const dados = dadosSchema.parse(entrada);
  if (!escopo.atendimentoTesteAtivo || !/^55\d{10,11}$/.test(telefone) ||
      !Number.isFinite(Date.parse(dados.dataHora)) || Date.parse(dados.dataHora)>Date.now())
    throw new Error('ATENDIMENTO_TESTE_FORA_DO_ESCOPO');
  return {...dados, aprovacaoHash:createHash('sha256').update(JSON.stringify([
    'noto-atendimento-teste-v1',escopo.contaId,escopo.medicoId,escopo.agendamentoId,telefone,dados
  ])).digest('hex')};
}

// Fragmento usado exclusivamente quando a flag explícita foi validada.
export function atendimentoTesteAprovadoSql(conta:string):string {
  return `a.origem='noto_teste_aprovado' and exists (
    select 1 from public.noto_atendimentos_teste_aprovados t
    where t.agendamento_id=a.id and t.medico_id=a.medico_id and t.conta_id=${conta}::uuid
      and t.paciente_id=a.paciente_id and t.servico_fiscal_id=a.servico_fiscal_id
      and t.data_hora=a.data_hora and t.valor_centavos=a.valor_consulta_centavos
      and t.aprovacao_hash=a.referencia_externa)`;
}

export async function registrarAtendimentoTeste(
  pool:pg.Pool, escopo:EscopoEmissaoWhatsApp, entrada:unknown, telefone:string, confirmacao:string
):Promise<void> {
  const dados = prepararAtendimentoTeste(escopo,entrada,telefone);
  if (confirmacao !== dados.aprovacaoHash) throw new Error('APROVACAO_ATENDIMENTO_TESTE_DIVERGENTE');
  const r = await pool.query(`
    with inserido as (
      insert into public.agendamentos (id,medico_id,paciente_id,servico_fiscal_id,data_hora,
        valor_consulta_centavos,status,origem,identificacao_profissional_confirmada,referencia_externa)
      select $1,m.id,p.id,f.id,$6::timestamptz,$7,'realizado','noto_teste_aprovado',true,$8
      from public.medicos m
      join public.medico_perfil_fiscal pf on pf.medico_id=m.id and pf.ambiente='homologacao'
      join public.pacientes p on p.id=$4 and p.medico_id=m.id and p.nome_validado
      join public.medico_servicos_fiscais f on f.id=$5 and f.medico_id=m.id and f.ativo
      where m.id=$2 and m.conta_id=$3 and $6::timestamptz<=now()
        and regexp_replace(p.telefone,'[^0-9]','','g')=any($9::text[])
        and exists (select 1 from public.usuarios u where u.conta_id=m.conta_id and u.ativo
          and u.auth_user_id is not null and regexp_replace(u.telefone,'[^0-9]','','g')=any($9::text[]))
      on conflict (id) do nothing
      returning id,medico_id,paciente_id,servico_fiscal_id,data_hora,valor_consulta_centavos
    )
    insert into public.noto_atendimentos_teste_aprovados (agendamento_id,conta_id,medico_id,
      paciente_id,servico_fiscal_id,data_hora,valor_centavos,aprovacao_hash)
    select id,$3,medico_id,paciente_id,servico_fiscal_id,data_hora,valor_consulta_centavos,$8 from inserido
    returning agendamento_id
  `,[escopo.agendamentoId,escopo.medicoId,escopo.contaId,dados.pacienteId,dados.servicoId,
    dados.dataHora,dados.valorCentavos,dados.aprovacaoHash,[telefone,telefone.slice(2)]]);
  if (r.rowCount!==1) throw new Error('ATENDIMENTO_TESTE_NAO_REGISTRADO');
}
