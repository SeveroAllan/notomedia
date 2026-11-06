#!/usr/bin/env node
/** Controle ADMINISTRATIVO local: não expor como rota HTTP nem ferramenta IA.
 * Não inicia worker, não envia WhatsApp nem executa pesquisas.
 * Uma nova rodada NÃO é criada por deploy ou reinício.
 */
import 'dotenv/config';
import pg from 'pg';
const modo=process.argv.slice(2);
if(modo.length!==1||!['--status','--confirmar-nova-rodada'].includes(modo[0])){
  console.error('Uso: node scripts/rodada-ia-noto.mjs --status | --confirmar-nova-rodada');
  process.exitCode=2;
}else if(process.env.NOTO_PILOTO_RESTRITO!=='true'||!process.env.DATABASE_URL){
  console.error('RODADA_IA_EXIGE_PILOTO_RESTRITO_E_BANCO_CONFIGURADOS');
  process.exitCode=2;
}else{
  const client=new pg.Client({connectionString:process.env.DATABASE_URL});
  try{
    await client.connect();
    if(modo[0]==='--status'){
      const r=await client.query([
        'select id,estado,limite_nano_usd,reservado_nano_usd,utilizado_nano_usd,criada_em',
        'from public.noto_piloto_rodadas_ia order by criada_em desc limit 1'
      ].join('\n'));
      const x=r.rows[0];
      console.info(x?JSON.stringify({rodada:x.id,estado:x.estado,
        tetoUsd:Number(x.limite_nano_usd)/1e9,
        reservadoUsd:Number(x.reservado_nano_usd)/1e9,
        contabilizadoUsd:Number(x.utilizado_nano_usd)/1e9,
        iniciadaEm:x.criada_em}):'SEM_RODADA');
    }else{
      await client.query('begin');
      try{
        // Serializa somente o comando administrativo de abrir rodada.
        await client.query("select pg_advisory_xact_lock(hashtext('noto_piloto_rodada_ia'))");
        await client.query([
          "update public.noto_piloto_rodadas_ia set estado='encerrada',encerrada_em=now()",
          "where estado in ('ativa','pausada')"
        ].join('\n'));
        const novo=await client.query([
          'insert into public.noto_piloto_rodadas_ia(estado,limite_nano_usd)',
          "values('ativa',1000000000) returning id"
        ].join('\n'));
        await client.query('commit');
        console.info('RODADA_NOVA_INICIADA '+String(novo.rows[0].id));
        console.info('Teto: US$ 1,00. Os gastos antigos permanecem auditados, sem transportar saldo.');
      }catch(erro){
        await client.query('rollback').catch(()=>undefined);
        throw erro;
      }
    }
  }catch{
    console.error('NAO_FOI_POSSIVEL_CONSULTAR_OU_ABRIR_RODADA. Nada foi publicado/ativado.');
    process.exitCode=1;
  }finally{await client.end().catch(()=>undefined);}
}
