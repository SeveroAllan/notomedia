import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {expect,it,vi} from 'vitest';
import {LinksCofre} from '../src/cofre/links.js';
import {registrarAceiteLink,diagnosticarRegistroEstadoEvolution} from '../src/whatsapp/repositorio-entrega-link.js';

const testar=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']?it:it.skip;
const CONTA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUTRA='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ANA='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BRUNO='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOME='Dra. Ana Souza';
const TEL='5551999998888';
const tokenDe=(url:string)=>url.split('/').at(-1)!;

testar('link CRM/RQE: falha comprovada, incerteza, reinício, reposição explícita e recibos sem links simultâneos',async()=>{
  const url=process.env['NOTO_SCHEMA_TEST_DATABASE_URL']!;
  if(!/127\.0\.0\.1|localhost/.test(url))throw Error('TESTE_EXIGE_BANCO_DESCARTAVEL');
  const name='noto_link_falha_'+randomUUID().replace(/-/g,'').slice(0,16);
  const admin=new pg.Client({connectionString:url});await admin.connect();
  const temp=new URL(url);temp.pathname='/'+name;
  let pool:pg.Pool|undefined;
  try{
    await admin.query('create database '+name);
    pool=new pg.Pool({connectionString:temp.toString(),max:8});
    await pool.query([
      'create table public.contas(id uuid primary key);',
      'create table public.medicos(id uuid primary key, conta_id uuid references public.contas(id),nome_completo text not null);',
      'create table public.usuarios(id uuid primary key,conta_id uuid,auth_user_id uuid,telefone text,ativo boolean);',
      "create table public.noto_agent_conversas(conta_id uuid primary key,estado jsonb not null default '{}'::jsonb,atualizado_em timestamptz default now());",
      'create table public.cofre_links(id uuid primary key default gen_random_uuid(), medico_id uuid references public.medicos(id),agenda text not null, token_hash text unique not null, expira_em timestamptz not null, usado_em timestamptz, criado_em timestamptz not null default now(), destino_telefone text);',
      "create table public.cofre_links_auditoria(link_id uuid references public.cofre_links(id),evento text check(evento in ('criado','aberto','enviado','expirado','concluido')),primary key(link_id,evento));",
      'create table public.cofre_links_entregas(link_id uuid primary key references public.cofre_links(id),instancia text,mensagem_id text,destino_hash text,estado text,aceito_em timestamptz default now(),atualizado_em timestamptz default now());',
      "insert into public.contas(id) values('"+CONTA+"'),('"+OUTRA+"');",
      "insert into public.medicos(id,conta_id,nome_completo) values('"+ANA+"','"+CONTA+"','"+NOME+"'),('"+BRUNO+"','"+OUTRA+"','Dr. Bruno Lima');",
      "insert into public.usuarios(id,conta_id,auth_user_id,telefone,ativo) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','"+CONTA+"','ffffffff-ffff-4fff-8fff-ffffffffffff','"+TEL+"',true);",
      "insert into public.noto_agent_conversas(conta_id,estado) values('"+CONTA+"',jsonb_build_object('profissionalConfirmadoId','"+ANA+"','pesquisasRegistro',jsonb_build_object('"+ANA+"',jsonb_build_object('nome','"+NOME+"','estado','manual_pendente','razao','LIMITE_TENTATIVAS','tentativas',4))));"
    ].join('\n'));
    // Esta finalidade já existe; recuperar não pode apagar um link de agenda.
    await pool.query([
      "insert into public.cofre_links(medico_id,agenda,token_hash,expira_em,criado_em)",
      "values($1,'tribemd','token_agenda',now()+interval '15 minutes',now()-interval '2 hours')"
    ].join('\n'),[ANA]);

    const enviados:string[]=[];
    const respostas:('enviado'|'erro'|'incerto'|'lancar')[]=[];
    const transporte=vi.fn(async({url}:{url:string})=>{
      enviados.push(url);
      const r=respostas.shift()??'enviado';
      if(r==='lancar')throw Error('TIMEOUT_SEM_RESPOSTA');
      return r;
    });
    const deps={pool,origem:'https://cofre.example.test',
      cofre:{status:async()=>({estado:'vazio'}),iniciar:async()=>null},
      enviar:async()=> 'enviado' as const,enviarUrlComRecibo:transporte};
    const links=new LinksCofre(deps);
    const ativos=async()=>Number((await pool!.query([
      'select count(*)::int as total from public.cofre_links',
      "where medico_id=$1 and agenda='registro_profissional'",
      'and usado_em is null and expira_em>now()'
    ].join('\n'),[ANA])).rows[0].total);
    const linksRegistro=async()=> (await pool!.query([
      'select id,token_hash,expira_em,usado_em,criado_em',
      'from public.cofre_links',
      "where medico_id=$1 and agenda='registro_profissional'",
      'order by criado_em desc,id desc'
    ].join('\n'),[ANA])).rows;
    const liberarCotaAnterior=async()=>pool!.query([
      'update public.cofre_links set criado_em=now()-interval \'2 hours\'',
      "where medico_id=$1 and agenda='registro_profissional' and expira_em<=now()"
    ].join('\n'),[ANA]);

    // O HTTP 4xx inequívoco rejeitou antes de enviar; token não fica preso 15 min.
    respostas.push('erro','enviado');
    expect(await links.solicitarLinkRegistro(CONTA,ANA,TEL,'solicitar','msg_00001'))
      .toMatchObject({ok:false,motivo:'FALHA_COMPROVADA'});
    expect(await ativos()).toBe(0);
    const primeiroEstado=(await pool.query('select estado from public.noto_agent_conversas where conta_id=$1',[CONTA])).rows[0].estado;
    expect(primeiroEstado.pesquisasRegistro[ANA].resultadoEnvioLink).toBe('falha_comprovada');
    expect((await pool.query(
      "select evento from public.cofre_links_auditoria where evento not in ('criado','aberto','enviado','expirado','concluido')"
    )).rows).toHaveLength(0);
    expect(await links.solicitarLinkRegistro(CONTA,ANA,TEL,'solicitar','msg_00001'))
      .toMatchObject({ok:false,motivo:'PEDIDO_JA_PROCESSADO'});
    expect(enviados).toHaveLength(1);
    expect(await links.solicitarLinkRegistro(CONTA,ANA,TEL,'solicitar','msg_00002'))
      .toMatchObject({ok:true,motivo:'ACEITO_API'});
    expect(enviados).toHaveLength(2);
    expect(await ativos()).toBe(1);
    expect(await links.validarLinkRegistro(tokenDe(enviados[0]!))).toBeNull();
    expect(await links.validarLinkRegistro(tokenDe(enviados[1]!))).toMatchObject({nome:NOME});

    // HTTP aceito, mas nenhum DELIVERY_ACK: ausência de recibo não é erro.
    expect(await links.solicitarLinkRegistro(CONTA,ANA,TEL,'consultar','msg_00003'))
      .toMatchObject({ok:true,motivo:'ACEITO_SEM_ENTREGA'});
    expect(await links.solicitarLinkRegistro(CONTA,ANA,TEL,'solicitar','msg_00004'))
      .toMatchObject({ok:false,motivo:'ACEITO_SEM_ENTREGA'});
    expect(enviados).toHaveLength(2);
    expect(await ativos()).toBe(1);

    // Consentimento NOVO substitui o anterior atomicamente; resultado incerto.
    respostas.push('incerto');
    expect(await links.solicitarLinkRegistro(CONTA,ANA,TEL,'substituir','msg_00005'))
      .toMatchObject({ok:false,motivo:'ENVIO_INCERTO'});
    expect(enviados).toHaveLength(3);
    expect(await ativos()).toBe(1);
    expect(await links.validarLinkRegistro(tokenDe(enviados[1]!))).toBeNull();
    expect(await links.validarLinkRegistro(tokenDe(enviados[2]!))).toMatchObject({nome:NOME});
    expect(await links.solicitarLinkRegistro(CONTA,ANA,TEL,'substituir','msg_00005'))
      .toMatchObject({ok:false,motivo:'PEDIDO_JA_PROCESSADO'});
    expect(enviados).toHaveLength(3);

    // Após reinício não existe URL em memória; nem consultar nem pedir de novo reenvia.
    const reiniciado=new LinksCofre(deps);
    expect(await reiniciado.solicitarLinkRegistro(CONTA,ANA,TEL,'consultar','msg_00006'))
      .toMatchObject({ok:true,motivo:'ENVIO_INCERTO'});
    expect(await reiniciado.solicitarLinkRegistro(CONTA,ANA,TEL,'solicitar','msg_00007'))
      .toMatchObject({ok:false,motivo:'ENVIO_INCERTO'});
    expect(enviados).toHaveLength(3);
    // O limite real de segurança é respeitado mesmo em falhas repetidas.
    expect(await reiniciado.solicitarLinkRegistro(CONTA,ANA,TEL,'substituir','msg_00008'))
      .toMatchObject({ok:false,motivo:'LIMITE_LINKS'});
    await liberarCotaAnterior();

    // Interrupção DEPOIS da criação: a chamada pode ter saído, então não há reenvio cego.
    respostas.push('lancar');
    expect(await reiniciado.solicitarLinkRegistro(CONTA,ANA,TEL,'substituir','msg_00009'))
      .toMatchObject({ok:false,motivo:'ENVIO_INCERTO'});
    expect(await ativos()).toBe(1);
    expect(enviados).toHaveLength(4);
    expect(await reiniciado.solicitarLinkRegistro(CONTA,ANA,TEL,'solicitar','msg_00010'))
      .toMatchObject({ok:false,motivo:'ENVIO_INCERTO'});
    expect(enviados).toHaveLength(4);
    await liberarCotaAnterior();

    // Webhook ERROR correlacionado ao último link torna a falha comprovada.
    const ultimo=(await linksRegistro())[0]!;
    await registrarAceiteLink(pool,{
      linkId:ultimo.id,instancia:'noto',mensagemId:'MSG_001',telefone:TEL,segredo:'test-secret'
    });
    const eventoErro={event:'messages.update',instance:'noto',
      data:{keyId:'MSG_001',fromMe:true,status:'ERROR',remoteJid:TEL+'@s.whatsapp.net'}};
    expect(await diagnosticarRegistroEstadoEvolution(pool,eventoErro,'noto','test-secret'))
      .toBe('ATUALIZADO');
    expect(await diagnosticarRegistroEstadoEvolution(pool,eventoErro,'noto','test-secret'))
      .toBe('DUPLICADO_OU_SEM_AVANCO');
    expect(await reiniciado.solicitarLinkRegistro(CONTA,ANA,TEL,'consultar','msg_00011'))
      .toMatchObject({ok:false,motivo:'FALHA_COMPROVADA'});
    // Dois eventos/turnos em paralelo após erro: apenas UM novo token e envio.
    respostas.push('enviado');
    const antes=enviados.length;
    const concorrentes=await Promise.all([
      reiniciado.solicitarLinkRegistro(CONTA,ANA,TEL,'solicitar','msg_00012'),
      reiniciado.solicitarLinkRegistro(CONTA,ANA,TEL,'solicitar','msg_00013')
    ]);
    expect(concorrentes.filter(r=>r.ok&&r.motivo==='ACEITO_API')).toHaveLength(1);
    expect(enviados).toHaveLength(antes+1);
    expect(await ativos()).toBe(1);
    expect(await links.validarLinkRegistro(tokenDe(enviados[3]!))).toBeNull();
    expect((await pool.query([
      "select count(*)::int as total from public.cofre_links where agenda='tribemd'",
      'and medico_id=$1 and expira_em>now() and usado_em is null'
    ].join('\n'),[ANA])).rows[0].total).toBe(1);

    // DELIVERY_ACK é prova positiva; substituição não prossegue, nem com consentimento.
    const atual=(await linksRegistro())[0]!;
    await registrarAceiteLink(pool,{
      linkId:atual.id,instancia:'noto',mensagemId:'MSG_002',telefone:TEL,segredo:'test-secret'
    });
    const eventoEntregue={event:'messages.update',instance:'noto',
      data:{keyId:'MSG_002',fromMe:true,status:'DELIVERY_ACK',remoteJid:TEL+'@s.whatsapp.net'}};
    expect(await diagnosticarRegistroEstadoEvolution(pool,eventoEntregue,'noto','test-secret'))
      .toBe('ATUALIZADO');
    expect(await diagnosticarRegistroEstadoEvolution(pool,eventoEntregue,'noto','test-secret'))
      .toBe('DUPLICADO_OU_SEM_AVANCO');
    expect(await reiniciado.solicitarLinkRegistro(CONTA,ANA,TEL,'consultar','msg_00014'))
      .toMatchObject({ok:true,motivo:'ENTREGUE'});
    expect(await reiniciado.solicitarLinkRegistro(CONTA,ANA,TEL,'substituir','msg_00015'))
      .toMatchObject({ok:false,motivo:'LINK_ENTREGUE'});
    expect(enviados).toHaveLength(antes+1);
    expect(await ativos()).toBe(1);

    // Outro operador/conta ou médico não confirmado: NENHUM efeito.
    expect(await reiniciado.solicitarLinkRegistro(OUTRA,ANA,TEL,'substituir','msg_00016'))
      .toMatchObject({ok:false});
    expect(await reiniciado.solicitarLinkRegistro(CONTA,BRUNO,TEL,'substituir','msg_00017'))
      .toMatchObject({ok:false});
    expect(await reiniciado.solicitarLinkRegistro(CONTA,ANA,'5511999990000','substituir','msg_00018'))
      .toMatchObject({ok:false,motivo:'OPERADOR_NAO_AUTORIZADO'});
    expect(enviados).toHaveLength(antes+1);
    expect(await ativos()).toBe(1);
  }finally{
    await pool?.end().catch(()=>undefined);
    await admin.query('drop database if exists '+name).catch(()=>undefined);
    await admin.end();
  }
});
