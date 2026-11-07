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
  pool: pg.Pool, escopo: EscopoEmissaoWhatsApp, entrada: { contaId: string; mensagemRef: string; valor: number; proposta?: {id:string;conversaRef:string;respostaRef:string} }
): Promise<'enfileirada'|'ja_enfileirada'|'bloqueada'> {
  if (entrada.contaId !== escopo.contaId || !Number.isSafeInteger(entrada.valor) || entrada.valor <= 0)
    return 'bloqueada';
  const client = await pool.connect();
  try {
    await client.query('begin');
    const alvo = await lerAlvoProposta(client,escopo,entrada.valor,Boolean(entrada.proposta));
    if (!alvo) { await client.query('rollback'); return 'bloqueada'; }
    if (entrada.proposta) {
      const reserva = await client.query(`
        update public.noto_propostas_emissao_whatsapp set confirmada_em=now()
        where id=$1 and conta_id=$2 and medico_id=$3 and agendamento_id=$4
          and conversa_ref=$5 and resposta_ref=$6 and dados_hash=$7
          and revogada_em is null and confirmada_em is null and expira_em>clock_timestamp()
        returning id
      `,[entrada.proposta.id,escopo.contaId,escopo.medicoId,escopo.agendamentoId,
        entrada.proposta.conversaRef,entrada.proposta.respostaRef,hashAlvoProposta(alvo)]);
      if (!reserva.rows.length) { await client.query('rollback'); return 'bloqueada'; }
    }
    const chave = createHash('sha256').update(JSON.stringify([alvo.origem, alvo.referencia_externa])).digest('hex');
    const existente = await client.query(`
      select 1 from public.noto_emissoes_comprovantes where medico_id=$1 and consulta_chave=$2
      union all
      select 1 from public.solicitacao_nota_agendamentos where medico_id=$1 and agendamento_id=$3
    `, [escopo.medicoId,chave,escopo.agendamentoId]);
    if (existente.rows.length) { await client.query('rollback'); return 'ja_enfileirada'; }

    const auditoria = await client.query(`
      insert into public.noto_auditoria_comprovantes (medico_id,origem,conta_id,mensagem_ref,estado,decisao${entrada.proposta?',proposta_whatsapp_id':''})
      values ($1,'autorizacao_whatsapp',$2,$3,'{}',jsonb_build_object('motivo','AUTORIZACAO_EXPLICITA','valorCentavos',$4::integer)${entrada.proposta?',$5':''})
      returning id
    `, [escopo.medicoId,escopo.contaId,entrada.mensagemRef,entrada.valor,...(entrada.proposta?[entrada.proposta.id]:[])]);
    const solicitacao = await client.query(`
      insert into public.solicitacoes_nota (medico_id,paciente_id,servico_fiscal_id,referencia_externa,
        valor_servico_centavos,xdesc_serv,ctrib_nac,cnbs,datas_consulta_texto,competencia_emissao,origem,status,fila)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,'whatsapp','pronta','pronta') returning id
    `, [escopo.medicoId,alvo.paciente_id,alvo.servico_fiscal_id,'whatsapp:'+chave,entrada.valor,
      alvo.xdesc_serv,alvo.ctrib_nac,alvo.cnbs,alvo.data,alvo.competencia]);
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


async function lerAlvoProposta(client:pg.PoolClient, escopo:EscopoEmissaoWhatsApp, valor:number|null, conversacional=true) {
  const parametros = [escopo.agendamentoId,escopo.medicoId,escopo.contaId,valor];
    const { rows: [alvo] } = await client.query(`
      select a.paciente_id, a.servico_fiscal_id, a.origem, a.referencia_externa,
        to_char(a.data_hora at time zone 'America/Sao_Paulo', 'DD/MM/YYYY') data,
        (a.data_hora at time zone 'America/Sao_Paulo')::date::text competencia,
        f.xdesc_serv, f.ctrib_nac, f.cnbs, a.valor_consulta_centavos valor
        ${conversacional ? `,
        coalesce(nullif(btrim(pf.razao_social),''), m.nome_completo) emitente,
        p.nome tomador, f.nome_servico servico,
        encode(sha256(pf.cpf_cnpj_encriptado),'hex') documento_hash,
        pf.cod_municipio_ibge, pf.serie_dps, pf.opcao_simples_nacional,
        pf.regime_apuracao_sn, pf.regime_especial_tributacao, pf.percentual_tot_trib_sn,
        pf.dados_reforma_tributaria, f.parametros_emissao` : ''}
      from public.agendamentos a
      join public.medicos m on m.id=a.medico_id and m.conta_id=$3
      join public.medico_perfil_fiscal pf on pf.medico_id=m.id
      join public.medico_servicos_fiscais f on f.id=a.servico_fiscal_id and f.medico_id=m.id
      ${conversacional ? 'join public.pacientes p on p.id=a.paciente_id and p.medico_id=m.id' : ''}
      where ${conversacional ? "p.nome_validado and nullif(btrim(p.nome),'') is not null and" : ''} a.id=$1 and a.medico_id=$2 and a.valor_consulta_centavos>0 and ($4::integer is null or a.valor_consulta_centavos=$4)
        and a.identificacao_profissional_confirmada and a.status='realizado' and a.data_hora<=now()
        and a.origem in ('tribemd','amplimed') and nullif(btrim(a.referencia_externa),'') is not null
        and pf.ambiente='homologacao' and pf.confirmado_pelo_medico
        and pf.cpf_cnpj_encriptado is not null and nullif(btrim(pf.serie_dps),'') is not null
        and pf.proximo_numero_dps > 0 and nullif(btrim(pf.cod_municipio_ibge),'') is not null
        and pf.opcao_simples_nacional is not null and nullif(btrim(m.crm),'') is not null
        and f.ativo and f.parametros_emissao is not null
        and exists (select 1 from public.medico_certificados c where c.medico_id=m.id and c.status='ativo'
          and c.valido_ate>=current_date and (c.valido_de is null or c.valido_de<=current_date))
      for update of a${conversacional ? ',m,p,pf,f' : ''}
    `, parametros);
  return alvo;
}

function hashAlvoProposta(alvo:Awaited<ReturnType<typeof lerAlvoProposta>>):string {
  return createHash('sha256').update(JSON.stringify(alvo)).digest('hex');
}

export async function tratarPropostaEmissaoWhatsApp(
  pool:pg.Pool, escopo:EscopoEmissaoWhatsApp,
  entrada:{contaId:string; texto:string; mensagemRef:string; conversaRef:string; citadaRef?:string},
  publicar:(texto:string)=>Promise<string|null>
):Promise<string|null> {
  if (entrada.contaId !== escopo.contaId) return null;
  const texto = entrada.texto.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
  if (/^(?:quero |pode )?(?:emitir|propor) (?:uma |a )?nota(?: de teste| em homologacao)?[.!]?$/.test(texto)) {
    const client = await pool.connect();
    let proposta:{id:string;texto:string};
    try {
      await client.query('begin');
      const alvo = await lerAlvoProposta(client,escopo,null);
      if (!alvo?.emitente?.trim() || !alvo?.tomador?.trim() || !alvo?.servico?.trim()) {
        await client.query('rollback');
        return 'Ainda não posso preparar a nota de teste. Confira o atendimento aprovado e os dados fiscais.';
      }
      await client.query(`
        update public.noto_propostas_emissao_whatsapp set revogada_em=now()
        where conta_id=$1 and conversa_ref=$2 and revogada_em is null and confirmada_em is null
      `,[escopo.contaId,entrada.conversaRef]);
      const {rows:[registro]} = await client.query(`
        insert into public.noto_propostas_emissao_whatsapp
          (conta_id,medico_id,agendamento_id,conversa_ref,pedido_ref,dados_hash,valor_centavos)
        values ($1,$2,$3,$4,$5,$6,$7) returning id
      `,[escopo.contaId,escopo.medicoId,escopo.agendamentoId,entrada.conversaRef,
        entrada.mensagemRef,hashAlvoProposta(alvo),alvo.valor]);
      await client.query('commit');
      const valor = new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(alvo.valor/100);
      proposta={id:registro.id,texto:
        `Nota de teste em homologação\nEmitente: ${alvo.emitente}\nTomador: ${alvo.tomador}\nServiço: ${alvo.servico}\nValor: ${valor}\nCompetência: ${alvo.data}\n\nPosso emitir? Use Responder nesta mensagem e diga “sim, pode emitir” em até 10 minutos.`};
    } catch(erro) {
      await client.query('rollback').catch(()=>undefined);
      throw erro;
    } finally { client.release(); }
    const respostaRef = await publicar(proposta.texto);
    if (!respostaRef) return 'Não consegui confirmar o envio da proposta. Peça uma nova proposta antes de autorizar.';
    const registrada = await pool.query(`
      update public.noto_propostas_emissao_whatsapp set resposta_ref=$2 where id=$1
        and revogada_em is null and confirmada_em is null and expira_em>clock_timestamp()
    `,[proposta.id,respostaRef]);
    return registrada.rowCount===1 ? '' : 'Essa proposta perdeu a validade. Peça uma nova antes de autorizar.';
  }

  if (!entrada.citadaRef) return null;
  const afirmou = /^(?:sim(?:,? pode emitir)?|pode emitir|confirmo)[.!]?$/.test(texto);
  const recusou = /^(?:nao(?:,? (?:nao emita|obrigad[oa]))?|nao emita|cancelar)[.!]?$/.test(texto);
  if (!afirmou && !recusou) return null;
  const {rows:[proposta]} = await pool.query(`
    select id,valor_centavos from public.noto_propostas_emissao_whatsapp
    where conta_id=$1 and conversa_ref=$2 and resposta_ref=$3
      and medico_id=$4 and agendamento_id=$5
  `,[escopo.contaId,entrada.conversaRef,entrada.citadaRef,escopo.medicoId,escopo.agendamentoId]);
  if (!proposta) return null;
  if (recusou) {
    const cancelada = await pool.query(`update public.noto_propostas_emissao_whatsapp set revogada_em=now()
      where id=$1 and confirmada_em is null and revogada_em is null`,[proposta.id]);
    return cancelada.rowCount===1 ? 'A proposta foi encerrada.' : 'Essa proposta já foi processada.';
  }
  const resultado = await autorizarEmissaoWhatsApp(pool,escopo,{
    contaId:entrada.contaId,mensagemRef:entrada.mensagemRef,valor:proposta.valor_centavos,
    proposta:{id:proposta.id,conversaRef:entrada.conversaRef,respostaRef:entrada.citadaRef}
  });
  return resultado==='enfileirada'
    ? 'Registrei a solicitação de emissão em homologação. A autorização da nota ainda está pendente.'
    : 'Essa proposta não pode mais ser confirmada. Se ainda quiser emitir, peça uma nova.';
}
