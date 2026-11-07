import { createHash } from 'node:crypto';
import type pg from 'pg';

export interface EscopoEmissaoWhatsApp {
  contaId: string;
  medicoId: string;
  agendamentoId: string;
}

/** A autorização explícita traz atendimento e valor em centavos.
 * O servidor compara ambos com o atendimento aprovado para o ensaio. */
export async function autorizarEmissaoWhatsApp(
  pool: pg.Pool, escopo: EscopoEmissaoWhatsApp, entrada: { contaId: string; mensagemRef: string; valor: number }
): Promise<'enfileirada'|'ja_enfileirada'|'bloqueada'> {
  if (entrada.contaId !== escopo.contaId || !Number.isSafeInteger(entrada.valor) || entrada.valor <= 0)
    return 'bloqueada';
  const client = await pool.connect();
  try {
    await client.query('begin');
    const parametros = [escopo.agendamentoId, escopo.medicoId, escopo.contaId, entrada.valor];
    const { rows: [alvo] } = await client.query(`
      select a.paciente_id, a.servico_fiscal_id, a.origem, a.referencia_externa,
        to_char(a.data_hora at time zone 'America/Sao_Paulo', 'DD/MM/YYYY') data,
        f.xdesc_serv, f.ctrib_nac, f.cnbs
      from public.agendamentos a
      join public.medicos m on m.id=a.medico_id and m.conta_id=$3
      join public.medico_perfil_fiscal pf on pf.medico_id=m.id
      join public.medico_servicos_fiscais f on f.id=a.servico_fiscal_id and f.medico_id=m.id
      where a.id=$1 and a.medico_id=$2 and a.valor_consulta_centavos=$4
        and a.identificacao_profissional_confirmada and a.status='realizado'
        and a.origem in ('tribemd','amplimed') and nullif(btrim(a.referencia_externa),'') is not null
        and pf.ambiente='homologacao' and pf.confirmado_pelo_medico
        and pf.cpf_cnpj_encriptado is not null and nullif(btrim(pf.serie_dps),'') is not null
        and pf.proximo_numero_dps > 0 and nullif(btrim(pf.cod_municipio_ibge),'') is not null
        and pf.opcao_simples_nacional is not null and nullif(btrim(m.crm),'') is not null
        and f.ativo and f.parametros_emissao is not null
        and exists (select 1 from public.medico_certificados c where c.medico_id=m.id and c.status='ativo'
          and c.valido_ate>=current_date and (c.valido_de is null or c.valido_de<=current_date))
      for update of a
    `, parametros);
    if (!alvo) { await client.query('rollback'); return 'bloqueada'; }
    const chave = createHash('sha256').update(JSON.stringify([alvo.origem, alvo.referencia_externa])).digest('hex');
    const existente = await client.query(`
      select 1 from public.noto_emissoes_comprovantes where medico_id=$1 and consulta_chave=$2
      union all
      select 1 from public.solicitacao_nota_agendamentos where medico_id=$1 and agendamento_id=$3
    `, [escopo.medicoId,chave,escopo.agendamentoId]);
    if (existente.rows.length) { await client.query('rollback'); return 'ja_enfileirada'; }

    const auditoria = await client.query(`
      insert into public.noto_auditoria_comprovantes (medico_id,origem,conta_id,mensagem_ref,estado,decisao)
      values ($1,'autorizacao_whatsapp',$2,$3,'{}',jsonb_build_object('motivo','AUTORIZACAO_EXPLICITA','valorCentavos',$4::integer))
      returning id
    `, [escopo.medicoId,escopo.contaId,entrada.mensagemRef,entrada.valor]);
    const solicitacao = await client.query(`
      insert into public.solicitacoes_nota (medico_id,paciente_id,servico_fiscal_id,referencia_externa,
        valor_servico_centavos,xdesc_serv,ctrib_nac,cnbs,datas_consulta_texto,origem,status,fila)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'whatsapp','pronta','pronta') returning id
    `, [escopo.medicoId,alvo.paciente_id,alvo.servico_fiscal_id,'whatsapp:'+chave,entrada.valor,
      alvo.xdesc_serv,alvo.ctrib_nac,alvo.cnbs,alvo.data]);
    const solicitacaoId = solicitacao.rows[0].id;
    await client.query(`
      insert into public.solicitacao_nota_agendamentos (solicitacao_id,agendamento_id,medico_id) values ($1,$2,$3)
    `, [solicitacaoId,escopo.agendamentoId,escopo.medicoId]);
    await client.query(`
      insert into public.noto_emissoes_comprovantes (medico_id,origem,consulta_chave,auditoria_comprovante_id,solicitacao_id,estado)
      values ($1,'autorizacao_whatsapp',$2,$3,$4,'enfileirada')
    `, [escopo.medicoId,chave,auditoria.rows[0].id,solicitacaoId]);
    await client.query('commit');
    return 'enfileirada';
  } catch (erro) {
    await client.query('rollback').catch(()=>undefined);
    throw erro;
  } finally { client.release(); }
}


export async function tratarComandoEmissaoWhatsApp(
  pool: pg.Pool, escopo: EscopoEmissaoWhatsApp, contaId: string, texto: string, mensagemRef: string
): Promise<string|null> {
  const comando = /^confirmar emiss[aã]o teste ([a-f0-9-]{36}) ([1-9][0-9]{0,8}) centavos$/i.exec(texto.trim());
  if (!comando) return null;
  if (comando[1]?.toLowerCase() !== escopo.agendamentoId)
    return 'Esse atendimento está fora do escopo de emissão de teste.';
  const resultado = await autorizarEmissaoWhatsApp(pool,escopo,{contaId,mensagemRef,valor:Number(comando[2])});
  if (resultado === 'bloqueada') return 'A emissão de teste foi bloqueada. Confira o atendimento, o valor e a prontidão fiscal do emitente.';
  if (resultado === 'ja_enfileirada') return 'Já existe uma solicitação para esse atendimento.';
  return 'Registrei a solicitação de emissão em homologação. A autorização da nota ainda está pendente.';
}
