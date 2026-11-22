import { createHash, createHmac } from 'node:crypto';
import { gerarHashCpf } from '../../paciente/hash-cpf.js';
import { validarCpf } from '../../paciente/validar-cpf.js';
import { ehNomeCivilValido } from '../../paciente/regras/validar-nome-civil.js';
import { z } from 'zod';
import type pg from 'pg';
import type { EscopoEmissaoWhatsApp } from './postgres-emissao-whatsapp-repositorio.js';

const dadosSchema = z.object({
  pacienteId: z.string().uuid(),
  servicoId: z.string().uuid(),
  dataHora: z.string().datetime({offset:true}),
  valorCentavos: z.number().int().positive().max(2147483647),
  tomador: z.object({
    nome:z.string().trim().max(200).refine(ehNomeCivilValido),
    cpf:z.string().regex(/^\d{11}$/).refine(validarCpf),
    telefone:z.string().regex(/^55\d{10,11}$/)
  }).strict().optional()
});

export function prepararAtendimentoTeste(escopo:EscopoEmissaoWhatsApp, entrada:unknown, telefone:string, pepper?:string) {
  const dados = dadosSchema.parse(entrada);
  if (!escopo.atendimentoTesteAtivo || !/^55\d{10,11}$/.test(telefone) ||
      !Number.isFinite(Date.parse(dados.dataHora)) || Date.parse(dados.dataHora)>Date.now())
    throw new Error('ATENDIMENTO_TESTE_FORA_DO_ESCOPO');
  if (dados.tomador && (dados.tomador.telefone!==telefone || !pepper))
    throw new Error('TOMADOR_TESTE_FORA_DO_ESCOPO');
  const hash = dados.tomador ? createHmac('sha256',pepper!) : createHash('sha256');
  return {...dados, aprovacaoHash:hash.update(JSON.stringify([
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
  pool:pg.Pool, escopo:EscopoEmissaoWhatsApp, entrada:unknown, telefone:string, confirmacao:string, chaves?:{pepper:string; criptografia:string}
):Promise<void> {
  const dados = prepararAtendimentoTeste(escopo,entrada,telefone,chaves?.pepper);
  if (confirmacao !== dados.aprovacaoHash) throw new Error('APROVACAO_ATENDIMENTO_TESTE_DIVERGENTE');
  if (!dados.tomador) {
    await gravarAtendimento(pool,escopo,dados,telefone);
    return;
  }
  if (!chaves?.criptografia || !chaves.pepper) throw new Error('CRIPTOGRAFIA_TESTE_INDISPONIVEL');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',
      ['noto_tomador_teste:'+escopo.medicoId+':'+telefone]);
    const existente = await client.query(`
      select a.id from public.agendamentos a where a.id=$1 for update
    `,[escopo.agendamentoId]);
    const cpfHash=gerarHashCpf(dados.tomador.cpf,chaves.pepper);
    const tomador = await client.query(`
      insert into public.pacientes as p (id,medico_id,nome,telefone,nome_validado,cpf_cnpj_hash,cpf_cnpj_encriptado,origem_cadastro)
      select $1,m.id,$4,$5,true,$6,pgp_sym_encrypt($7,$8),'noto_teste_aprovado'
      from public.medicos m join public.medico_perfil_fiscal pf on pf.medico_id=m.id and pf.ambiente='homologacao'
      where m.id=$2 and m.conta_id=$3
        and exists (select 1 from public.usuarios u where u.conta_id=m.conta_id and u.ativo
          and u.auth_user_id is not null and regexp_replace(u.telefone,'[^0-9]','','g')=any($9::text[]))
        and not exists (select 1 from public.pacientes outro where outro.medico_id=m.id and outro.id<>$1
          and (outro.cpf_cnpj_hash=$6 or regexp_replace(outro.telefone,'[^0-9]','','g')=any($9::text[])))
      on conflict (id) do update set nome=excluded.nome,nome_validado=true,
        cpf_cnpj_hash=excluded.cpf_cnpj_hash,cpf_cnpj_encriptado=excluded.cpf_cnpj_encriptado,atualizado_em=now()
      where p.medico_id=excluded.medico_id and p.telefone=excluded.telefone and p.origem_cadastro='noto_teste_aprovado'
        and not exists (select 1 from public.agendamentos a where a.paciente_id=p.id and a.id<>$10)
        and not exists (select 1 from public.solicitacoes_nota s where s.paciente_id=p.id)
        and not exists (select 1 from public.noto_propostas_emissao_whatsapp n where n.agendamento_id=$10)
      returning id
    `,[dados.pacienteId,escopo.medicoId,escopo.contaId,dados.tomador.nome,telefone,cpfHash,
      dados.tomador.cpf,chaves.criptografia,[telefone,telefone.slice(2)],escopo.agendamentoId]);
    if (tomador.rowCount!==1) throw new Error('TOMADOR_TESTE_NAO_REGISTRADO');
    await gravarAtendimento(client,escopo,dados,telefone,existente.rowCount===1);
    await client.query('commit');
  } catch (erro) {
    await client.query('rollback').catch(()=>undefined);
    throw erro;
  } finally { client.release(); }
}

async function gravarAtendimento(
  banco:Pick<pg.Pool,'query'>,escopo:EscopoEmissaoWhatsApp,
  dados:ReturnType<typeof prepararAtendimentoTeste>,telefone:string,atualizar=false
):Promise<void> {
  const r = await banco.query(`
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
      on conflict (id) ${atualizar ? `do update set data_hora=excluded.data_hora,
        servico_fiscal_id=excluded.servico_fiscal_id,valor_consulta_centavos=excluded.valor_consulta_centavos,
        referencia_externa=excluded.referencia_externa,atualizado_em=now()
        where agendamentos.origem='noto_teste_aprovado' and agendamentos.medico_id=excluded.medico_id
          and agendamentos.paciente_id=excluded.paciente_id
          and exists (select 1 from public.noto_atendimentos_teste_aprovados t where t.agendamento_id=agendamentos.id and t.conta_id=$3)
          and not exists (select 1 from public.solicitacao_nota_agendamentos s where s.agendamento_id=agendamentos.id)
          and not exists (select 1 from public.noto_propostas_emissao_whatsapp n where n.agendamento_id=agendamentos.id)
      ` : 'do nothing'}
      returning id,medico_id,paciente_id,servico_fiscal_id,data_hora,valor_consulta_centavos
    )
    insert into public.noto_atendimentos_teste_aprovados (agendamento_id,conta_id,medico_id,
      paciente_id,servico_fiscal_id,data_hora,valor_centavos,aprovacao_hash)
    select id,$3,medico_id,paciente_id,servico_fiscal_id,data_hora,valor_consulta_centavos,$8 from inserido
    ${atualizar ? `on conflict (agendamento_id) do update set servico_fiscal_id=excluded.servico_fiscal_id,
      data_hora=excluded.data_hora,valor_centavos=excluded.valor_centavos,
      aprovacao_hash=excluded.aprovacao_hash,aprovado_em=now()` : ''}
    returning agendamento_id
  `,[escopo.agendamentoId,escopo.medicoId,escopo.contaId,dados.pacienteId,dados.servicoId,
    dados.dataHora,dados.valorCentavos,dados.aprovacaoHash,[telefone,telefone.slice(2)]]);
  if (r.rowCount!==1) throw new Error('ATENDIMENTO_TESTE_NAO_REGISTRADO');
}
