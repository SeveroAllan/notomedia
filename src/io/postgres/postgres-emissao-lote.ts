import type pg from 'pg';
import { createHash } from 'node:crypto';
import { registroErroNoto } from '../../observabilidade/erros.js';
import { chaveConsulta } from '../../atendimento/comprovante.js';
import { resolverContatoConsulta } from '../../agenda/fonte-agenda.js';
import { montarDescricaoServico } from '../../emissao/montar-descricao-servico.js';
import { prepararTomadorAoVivo, type TomadorAoVivo } from '../fiscal/postgres-emissor-dps-service.js';
import { processarItemFila } from '../../worker/processar-item-fila.js';
import type { EmissorDpsService } from '../../worker/emissor-dps-service.js';
import type { ItemFilaComTentativas } from '../../worker/fila-repositorio.js';
import { PostgresEmissaoApiRepositorio } from './postgres-emissao-api-repositorio.js';
import { PostgresLotesEmissao } from './postgres-lotes-emissao.js';
import { PostgresFilaRepositorio } from './postgres-fila-repositorio.js';

export interface EntradaEmissaoLote {
  medicoId: string; loteId: string;
  item: {id: string; fonte: string; idExterno: string; chave: string; assinatura: string | null};
  detalhe: TomadorAoVivo;
}
export interface ExecutorFiscalLote {
  emissorDps: EmissorDpsService;
  entregar: (medicoId: string, solicitacaoId: string) => Promise<string>;
}
export type ResultadoEmissaoLote = {estado: 'emitida'; entrega: string; semContato: boolean} | {estado: 'ja_faturada' | 'repetida' | 'erro'};

/** Reutiliza a fila conservadora e sua reserva global por consulta, sem criar comprovante fictício. */
export class PostgresEmissaoLote extends PostgresFilaRepositorio {
  private readonly solicitacoes: PostgresEmissaoApiRepositorio;
  constructor(private readonly banco: pg.Pool, chave: string, private readonly pepper: string,
    private readonly permitido: (medicoId: string) => Promise<boolean>) {
    super(banco, true, true);
    this.solicitacoes = new PostgresEmissaoApiRepositorio(banco, chave, pepper);
  }
  async emitir(entrada: EntradaEmissaoLote, executor: ExecutorFiscalLote): Promise<ResultadoEmissaoLote> {
    if (!await this.permitido(entrada.medicoId)) return {estado:'erro'};
    const preparado = prepararTomadorAoVivo(entrada.detalhe);
    if (!preparado.ok) return {estado:'erro'};
    const reservado = await this.criarSolicitacao(entrada, preparado.valorCentavos);
    if (!('id' in reservado)) return reservado;
    const semContato = !resolverContatoConsulta(entrada.detalhe.contato);
    let entrega = 'nao_enviada';
    // O caminho protegido já conserva a reserva em caso de resultado fiscal incerto, sem retentativa autônoma.
    const resultado = await processarItemFila({...reservado, origemLote:true, emissaoComprovante:true, tomadorAoVivo:entrada.detalhe}, {
      filaRepositorio:this, emissorDps:executor.emissorDps,
      enviarPdfDanfse:{enviarPdf:async()=>{throw Error('ENTREGA_FORA_DAS_TRAVAS');}},
      notificadorAlertas:{notificarMedicoWhatsApp:async p=>{
        const codigo=['CERTIFICADO_AUSENTE','CERTIFICADO_INVALIDO','SEFIN_TIMEOUT','SEFIN_INDISPONIVEL','PARAMETROS_FISCAIS_PENDENTES','AMBIENTE_FISCAL_BLOQUEADO','PERSISTENCIA_COMPROVANTE_PENDENTE'].includes(p.codigoErro??'') ? p.codigoErro! : 'EMISSAO_LOTE_FALHOU';
        console.warn(registroErroNoto(codigo,'tecnico',{medicoId:entrada.medicoId,solicitacaoId:reservado.id,etapa:'emissao_lote'}));
      },notificarDesenvolvedorEmail:async()=>{}},
      aoAutorizarComprovante:async()=>{if (!semContato) entrega = await executor.entregar(entrada.medicoId,reservado.id);}
    });
    return resultado.ok ? {estado:'emitida',entrega,semContato} : {estado:'erro'};
  }
  private async criarSolicitacao(e: EntradaEmissaoLote, valor: number): Promise<ItemFilaComTentativas | {estado:'ja_faturada' | 'repetida' | 'erro'}> {
    const client = await this.banco.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))',[e.medicoId]);
      const {rows} = await client.query(`select c.paciente_id, c.data_hora, pf.ambiente, i.assinatura
        from public.noto_lotes_itens i join public.noto_lotes_emissao l on l.id=i.lote_id and l.medico_id=i.medico_id
        join public.noto_consultas_sincronizadas c on c.medico_id=i.medico_id and c.fonte=i.fonte and c.id_externo=i.id_externo
        join medico_perfil_fiscal pf on pf.medico_id=i.medico_id
        where i.id=$1 and i.lote_id=$2 and i.medico_id=$3 and i.fonte=$4 and i.id_externo=$5 and i.consulta_chave=$6
          and c.status='realizada' and c.data_hora >= (l.desde::timestamp at time zone 'America/Sao_Paulo') and c.data_hora<=l.ate
          and i.estado='processando' and l.estado='processando' and l.confirmado_em is not null
          and l.mensagem_confirmacao_id is not null and l.resposta_confirmacao_id is not null and pf.ambiente='homologacao'
        for update of i,l`,[e.item.id,e.loteId,e.medicoId,e.item.fonte,e.item.idExterno,e.item.chave]);
      const c=rows[0];
      if (!c || c.ambiente !== 'homologacao' || c.assinatura !== e.item.assinatura ||
          e.item.chave !== chaveConsulta(this.pepper,e.medicoId,e.item.fonte,e.item.idExterno) ||
          c.assinatura !== new PostgresLotesEmissao(this.banco,this.pepper).assinatura(e.medicoId,e.item.fonte,e.item.idExterno,valor) || !await this.permitido(e.medicoId)) {
        await client.query('rollback'); return {estado:'erro'};
      }
      const {rows: existentes} = await client.query(`select estado from public.noto_emissoes_comprovantes where medico_id=$1 and consulta_chave=$2 for update`,[e.medicoId,e.item.chave]);
      if (existentes.length) {await client.query('commit');return {estado:existentes[0].estado==='nota_gerada'?'ja_faturada':'repetida'};}
      const perfil = await this.solicitacoes.buscarPerfilFiscalMedico(e.medicoId,client);
      if (!perfil?.configuracaoCompleta) {await client.query('rollback');return {estado:'erro'};}
      const datas = new Date(c.data_hora).toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});
      const params={origem:'lote' as const,ref:`lote:${e.item.id}`,medicoId:e.medicoId,pacienteId:c.paciente_id,valorServicoCentavos:valor,
        xdescServ:montarDescricaoServico(perfil,datas),datasConsultaTexto:datas,ctribNac:perfil.ctribNacPadrao,cnbs:perfil.cnbs,cclassTrib:perfil.cclassTrib,cindOp:perfil.cindOp,
        contatoPaciente:resolverContatoConsulta(e.detalhe.contato)};
      const criada = await this.solicitacoes.enfileirarSolicitacao(params,client);
      await client.query(`insert into public.noto_emissoes_comprovantes (medico_id, consulta_chave, lote_item_id, solicitacao_id, estado)
        values ($1,$2,$3,$4,'enfileirada')`,[e.medicoId,e.item.chave,e.item.id,criada.id]);
      await client.query('commit');
      return {...params,id:criada.id,tentativas:0};
    } catch (erro) {await client.query('rollback');throw erro;} finally {client.release();}
  }
  async pendentesReenvio(medicoId: string) {
    if (!await this.permitido(medicoId)) return [];
    const {rows} = await this.banco.query(`select i.id, i.medico_id, i.id_externo, nf.id as nota_id,
        sn.paciente_id, sn.valor_servico_centavos, sn.xdesc_serv, sn.ctrib_nac, sn.cnbs, sn.cclass_trib, sn.cind_op, sn.datas_consulta_texto
      from public.noto_lotes_itens i join public.noto_lotes_emissao l on l.id=i.lote_id and l.medico_id=i.medico_id
      join public.noto_emissoes_comprovantes ec on ec.lote_item_id=i.id and ec.medico_id=i.medico_id and ec.estado='nota_gerada'
      join notas_fiscais nf on nf.id=ec.nota_fiscal_id and nf.medico_id=i.medico_id and nf.status='autorizada'
      join solicitacoes_nota sn on sn.id=nf.solicitacao_id and sn.medico_id=i.medico_id
      join medico_perfil_fiscal pf on pf.medico_id=i.medico_id and pf.ambiente='homologacao'
      where i.medico_id=$1 and l.estado='concluido' and sn.origem='lote' and sn.contato_paciente_encriptado is null
      order by l.criado_em, i.id`,[medicoId]);
    return rows;
  }
  async reenviarSemContato(medicoId: string, mensagemId: string, candidatos: Awaited<ReturnType<PostgresEmissaoLote['pendentesReenvio']>>,
    lerDetalhe: (medicoId: string,idExterno: string)=>Promise<TomadorAoVivo>, entregar: ExecutorFiscalLote['entregar']) {
    let entregues=0,semContato=0;
    for (const c of candidatos) {
      if(c.medico_id!==medicoId || !await this.permitido(medicoId)) continue;
      const ref=`reenvio:${c.id}:${createHash('sha256').update(mensagemId).digest('hex')}`;
      // Reentrega do evento não relê a agenda nem substitui o contato já capturado.
      if (await this.solicitacoes.buscarPorReferencia(medicoId,ref)) continue;
      const contato=resolverContatoConsulta((await lerDetalhe(medicoId,c.id_externo)).contato);
      if(!contato) {semContato++;continue;}
      const client=await this.banco.connect(); let solicitacaoId:string|null=null;
      try {
        await client.query('begin');
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))',[medicoId]);
        const {rows: anteriores}=await client.query('select id from solicitacoes_nota where medico_id=$1 and referencia_externa=$2',[medicoId,ref]);
        if(!anteriores.length && await this.permitido(medicoId)) {
          const nova=await this.solicitacoes.enfileirarSolicitacao({origem:'lote',ref,medicoId,pacienteId:c.paciente_id,
            valorServicoCentavos:Number(c.valor_servico_centavos),xdescServ:c.xdesc_serv,ctribNac:c.ctrib_nac,
            cnbs:c.cnbs,cclassTrib:c.cclass_trib,cindOp:c.cind_op,datasConsultaTexto:c.datas_consulta_texto,contatoPaciente:contato},client);
          // Apenas entrega da nota existente: nunca deixa uma emissão na fila.
          await client.query(`update solicitacoes_nota set nota_reenvio_id=$2, status='emitida', fila=null where id=$1 and medico_id=$3`,[nova.id,c.nota_id,medicoId]);
          solicitacaoId=nova.id;
        }
        await client.query('commit');
      } catch(e) {await client.query('rollback');throw e;} finally {client.release();}
      if(solicitacaoId && await entregar(medicoId,solicitacaoId)==='enviado') entregues++;
    }
    return {entregues,semContato,total:candidatos.length};
  }
  override async iniciarEmissaoComprovante(solicitacaoId: string): Promise<'iniciada' | 'ocupada' | 'bloqueada'> {
    const {rows: donos} = await this.banco.query('select medico_id from solicitacoes_nota where id=$1 and origem=\'lote\'',[solicitacaoId]);
    if (!donos[0] || !await this.permitido(donos[0].medico_id)) return 'bloqueada';
    const {rowCount} = await this.banco.query(`update public.noto_emissoes_comprovantes ec set estado='emitindo', atualizado_em=now()
      from solicitacoes_nota sn, public.noto_lotes_itens i, public.noto_lotes_emissao l, medico_perfil_fiscal pf
      where ec.solicitacao_id=$1 and ec.estado='enfileirada' and sn.id=ec.solicitacao_id and sn.medico_id=ec.medico_id
        and sn.origem='lote' and not coalesce(sn.aguardando_confirmacao_medico,false)
        and i.id=ec.lote_item_id and i.medico_id=ec.medico_id and i.estado='processando'
        and l.id=i.lote_id and l.medico_id=i.medico_id and l.estado='processando' and l.confirmado_em is not null
        and pf.medico_id=ec.medico_id and pf.ambiente='homologacao'`,[solicitacaoId]);
    return rowCount===1?'iniciada':'ocupada';
  }
}
