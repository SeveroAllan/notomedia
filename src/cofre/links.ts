import { FALA_PEDIDO_CONEXAO_AGENDA, FALA_SEGURANCA_LINK_AGENDA, FALA_NOVO_LINK_AGENDA } from '../onboarding/falas.js';
import { createHash, randomBytes } from 'node:crypto';
import { nomeProfissionalValido, normalizarCrm } from '../conta/validar-dados-emissao.js';
import type pg from 'pg';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';
import { AGENDAS_SUPORTADAS, agendaSuportada, type AgendaSuportada } from '../agenda/agendas-suportadas.js';
import { cofreIdDaConta, contaDoCofreId } from './identidade-conta.js';

export interface ContextoConexaoAgenda {
    aguardandoConexao: boolean;
    agendaConectada: boolean;
    link: { agenda: string; enviado: boolean; minutosDesdeEnvio: number | null; usado: boolean; expirado: boolean; rejeitado: boolean | null } | null;
}

// Protege credenciais antes de qualquer classificação, memória ou log do texto.
export function contemCredencialAgenda(texto: string): boolean {
    return /\b(senha|password|token|secret|segredo|api[_ -]?key)\b/i.test(texto) ||
        /\/c\/[A-Za-z0-9_-]{43}|Bearer\s+\S+/i.test(texto) ||
        /^\S{12,}$/.test(texto.trim()) && /[0-9@#$_-]/.test(texto);
}

export interface CofreAgenda { status(id: string): Promise<{ estado: string; ativo?: boolean; codigo?: string | null }>; iniciar(id: string, credencial?: { email: string; senha: string }): Promise<unknown> }
export interface ConclusaoAgenda { agenda: AgendaSuportada; conectado: boolean; falhaAcesso?: boolean; chave: string; contatoTelefone?:string }

export interface TextoLinkAgendaEnviado { medicoId: string; telefoneMedico: string; linkId: string; indice: number; texto: string }

export class LinksCofre {
    private aguardando = new Map<string, { id: string; agenda: string; contatoTelefone?:string }>();
    constructor(private deps: {
        pool: pg.Pool;
        origem: string;
        cofre: CofreAgenda;
        /** Cofres de outras agendas; a chave é a agenda do link. */
        cofres?: Partial<Record<AgendaSuportada, CofreAgenda>>;
        aoConcluir?: (medicoId: string, evento: ConclusaoAgenda) => Promise<void>;
        aoConcluirConta?: (contaId: string, evento: ConclusaoAgenda) => Promise<void>;
        registrarTextoEnviado?: (entrada: TextoLinkAgendaEnviado) => Promise<void>;
        enviar: (medicoId: string, texto: string, contatoTelefone?:string) => Promise<'simulado' | 'enviado' | 'erro'>;
        /** SÓ a URL sensível: aceita na Evolution, guarda ID sem guardar conteúdo.
         * A ausência de ACK não permite repetir a URL automaticamente.
         */
        enviarUrlComRecibo?: (entrada: {referenciaCofre:string; url:string; linkId:string; telefone:string}) =>
            Promise<'enviado' | 'erro'>;
    }) {}

    private cofreDe(agenda: string): CofreAgenda | null {
        const a = agendaSuportada(agenda);
        if (!a) return null;
        return a === 'tribemd' ? this.deps.cofre : this.deps.cofres?.[a] ?? null;
    }
    async agendaDoLink(token: string): Promise<AgendaSuportada | null> {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
        const l = (await this.deps.pool.query('select agenda from cofre_links where token_hash=$1', [this.hash(token)])).rows[0];
        return agendaSuportada(l?.agenda);
    }

    async solicitarLinkCofre(medicoId: string, agenda: string, opcoes: { reenvio?: boolean; fala?: readonly string[]; contatoTelefone?:string } = {}) {
        const cofreAgenda = this.cofreDe(agenda);
        if (!cofreAgenda) return { ok: false, motivo: 'AGENDA_NAO_SUPORTADA' };
        const cliente = await this.deps.pool.connect();
        let link: { id: string };
        let token = '', telefoneMedico = '', confirmado = false;
        try {
            await cliente.query('begin');
            // A linha do médico serializa limite e invalidação, inclusive entre réplicas.
            let medico = (await cliente.query(`select u.ativo, u.telefone from medicos m
                left join usuarios u on u.id=m.usuario_id where m.id=$1 for update of m`, [medicoId])).rows[0];
            if (!medico) return { ok: false, motivo: 'MEDICO_INEXISTENTE' };
            // Médico da conta pode não ter usuário próprio. Só o operador ativo
            // da mesma conta, identificado pelo contato recebido, pode pedir seu link.
            if(medico.ativo==null && opcoes.contatoTelefone) {
                const operadores=(await cliente.query(`select u.ativo, u.telefone from usuarios u
                    join medicos m on m.conta_id=u.conta_id where m.id=$1 and u.ativo=true`,[medicoId])).rows;
                const variantes=gerarVariantesTelefoneBrasileiro(opcoes.contatoTelefone);
                medico=operadores.find(u=>gerarVariantesTelefoneBrasileiro(u.telefone??'').some(t=>variantes.includes(t)));
                if(!medico)return {ok:false,motivo:'OPERADOR_NAO_AUTORIZADO'};
            }
            if (!medico.ativo) return { ok: false, motivo: 'MEDICO_INATIVO' };
            if (!medico.telefone?.trim()) return { ok: false, motivo: 'SEM_TELEFONE' };
            telefoneMedico = opcoes.contatoTelefone?.trim() || medico.telefone;
            const status = await cofreAgenda.status(medicoId);
            if (!['vazio', 'desconectado', 'atencao'].includes(status.estado)) return { ok: false, motivo: 'COFRE_NAO_DISPONIVEL' };
            const limite = (await cliente.query(`with referencia as (select clock_timestamp() as agora), pedidos_contados as (
                select pedido.criado_em from cofre_links pedido cross join referencia
                join lateral (select anterior.expira_em, anterior.usado_em from cofre_links anterior
                    where anterior.medico_id=pedido.medico_id and (anterior.criado_em, anterior.id)<(pedido.criado_em, pedido.id)
                    order by anterior.criado_em desc, anterior.id desc limit 1) anterior
                    on anterior.usado_em is null and anterior.expira_em>pedido.criado_em
                where pedido.medico_id=$1 and pedido.criado_em>referencia.agora-interval '1 hour'
            ), contagem as (select count(*)::int as total, min(criado_em) as mais_antigo from pedidos_contados)
            select contagem.total, referencia.agora::text as instante,
                coalesce((select usado_em is null and expira_em>referencia.agora from cofre_links where medico_id=$1
                    order by criado_em desc, id desc limit 1), false) as substitui_valido,
                greatest(1, ceil(extract(epoch from (contagem.mais_antigo+interval '1 hour'-referencia.agora))/60))::int as aguardar_minutos
            from contagem cross join referencia`, [medicoId])).rows[0];
            // Duas substituições anteriores mais o pedido atual com link vivo bloqueiam a quarta criação.
            if (limite.substitui_valido && limite.total >= 2) return { ok: false, motivo: 'LIMITE_PEDIDOS', aguardarMinutos: limite.aguardar_minutos };
            // O instante do pedido precede a invalidação: o self-join preserva se o anterior estava vivo.
            await cliente.query(`with expirados as (
                update cofre_links set expira_em=least(expira_em,clock_timestamp())
                where medico_id=$1 and agenda=$2 and usado_em is null returning id
            ) insert into cofre_links_auditoria (link_id, evento)
                select id, 'expirado' from expirados on conflict do nothing`, [medicoId, agenda]);
            token = randomBytes(32).toString('base64url');
            link = (await cliente.query(`insert into cofre_links (medico_id, agenda, token_hash, expira_em, criado_em, destino_telefone)
                values ($1,$2,$3,$4::timestamptz+interval '15 minutes',$4::timestamptz,$5) returning id`, [medicoId, agenda, this.hash(token), limite.instante, telefoneMedico])).rows[0];
            await cliente.query('insert into cofre_links_auditoria (link_id, evento) values ($1,$2)', [link.id, 'criado']);
            await cliente.query('commit');
            confirmado = true;
        } finally {
            try { if (!confirmado) await cliente.query('rollback'); } finally { cliente.release(); }
        }
        try {
            const url = `${this.deps.origem}/c/${token}`;
            const baloes = opcoes.fala ? [...opcoes.fala, url] : opcoes.reenvio ? [FALA_NOVO_LINK_AGENDA, url] : [
                FALA_PEDIDO_CONEXAO_AGENDA,
                FALA_SEGURANCA_LINK_AGENDA,
                url
            ];
            let motivo: 'simulado' | 'enviado' | undefined;
            for (const [indice, texto] of baloes.entries()) {
                const envio = texto === url && this.deps.enviarUrlComRecibo
                    ? await this.deps.enviarUrlComRecibo({referenciaCofre:medicoId,url,linkId:link.id,telefone:telefoneMedico})
                    : await this.deps.enviar(medicoId, texto, telefoneMedico);
                if (envio === 'erro' || motivo && motivo !== envio) return { ok: false, motivo: 'erro' };
                motivo = envio;
                if (envio === 'enviado') {
                    try { await this.deps.registrarTextoEnviado?.({ medicoId, telefoneMedico, linkId: link.id, indice,
                        texto: texto === url ? `${this.deps.origem}/c/[LINK_SEGURO]` : texto }); }
                    catch { console.warn('COFRE_MEMORIA_FALHOU'); }
                }
            }
            if (motivo === 'enviado') await this.auditar(link.id, 'enviado');
            return { ok: true, motivo: motivo! };
        } catch { return { ok: false, motivo: 'erro' };
        } finally { token = ''; }
    }

    /** Novo vínculo: conta autenticada -> Cofre. Não requer nem cria medicos.
     * A FK de conta_id e a chave de envelope permanecem independentes de identidade clínica.
     */
    async solicitarLinkConta(contaId: string, agenda: string, contatoTelefone: string) {
        const cofreAgenda = this.cofreDe(agenda);
        if (!cofreAgenda) return { ok: false, motivo: 'AGENDA_NAO_SUPORTADA' };
        const chaveCofre = cofreIdDaConta(contaId);
        const variantes = gerarVariantesTelefoneBrasileiro(contatoTelefone);
        if (!variantes.length) return { ok: false, motivo: 'OPERADOR_NAO_AUTORIZADO' };
        const cliente = await this.deps.pool.connect();
        let link: { id: string };
        let token = '', confirmou = false;
        try {
            await cliente.query('begin');
            // Serialização da própria conta (não da linha de médico).
            const titular = await cliente.query('select id from contas where id=$1 for update',[contaId]);
            if (titular.rows.length !== 1) return { ok: false, motivo: 'CONTA_INDISPONIVEL' };
            const operadores = await cliente.query(`
              select telefone from usuarios
              where conta_id=$1 and ativo=true and auth_user_id is not null
            `,[contaId]);
            if (!operadores.rows.some(u => gerarVariantesTelefoneBrasileiro(String(u.telefone ?? ''))
                  .some(v => variantes.includes(v)))) {
                return { ok: false, motivo: 'OPERADOR_NAO_AUTORIZADO' };
            }
            const status = await cofreAgenda.status(chaveCofre);
            if (!['vazio','desconectado','atencao'].includes(status.estado)) {
                return { ok: false, motivo: 'COFRE_NAO_DISPONIVEL' };
            }
            const limite = await cliente.query(`
                select count(*)::int as total from cofre_links
                where conta_id=$1 and criado_em>clock_timestamp()-interval '1 hour'
            `,[contaId]);
            if (Number(limite.rows[0]?.total ?? 0) >= 3) {
                return { ok: false, motivo: 'LIMITE_PEDIDOS' };
            }
            await cliente.query(`with expirados as (
              update cofre_links set expira_em=least(expira_em,clock_timestamp())
              where conta_id=$1 and agenda=$2 and usado_em is null returning id
            ) insert into cofre_links_auditoria(link_id,evento)
              select id,'expirado' from expirados on conflict do nothing`,[contaId,agenda]);
            token = randomBytes(32).toString('base64url');
            link = (await cliente.query(`insert into cofre_links
              (conta_id,medico_id,agenda,token_hash,expira_em,criado_em,destino_telefone)
              values ($1,null,$2,$3,clock_timestamp()+interval '15 minutes',clock_timestamp(),$4)
              returning id`,[contaId,agenda,this.hash(token),contatoTelefone])).rows[0];
            await cliente.query('insert into cofre_links_auditoria(link_id,evento) values ($1,$2)',[link.id,'criado']);
            await cliente.query('commit');
            confirmou = true;
        } finally {
            try { if (!confirmou) await cliente.query('rollback'); } finally { cliente.release(); }
        }
        try {
            const url = `${this.deps.origem}/c/${token}`;
            const textos = [FALA_PEDIDO_CONEXAO_AGENDA,FALA_SEGURANCA_LINK_AGENDA,url];
            for (const texto of textos) {
                const envio = texto === url && this.deps.enviarUrlComRecibo
                    ? await this.deps.enviarUrlComRecibo({referenciaCofre:chaveCofre,url,linkId:link!.id,telefone:contatoTelefone})
                    : await this.deps.enviar(chaveCofre,texto,contatoTelefone);
                if (envio !== 'enviado') return {ok:false,motivo:envio==='simulado'?'simulado':'erro'};
            }
            await this.auditar(link!.id,'enviado');
            return {ok:true,motivo:'enviado'};
        } catch { return {ok:false,motivo:'erro'}; }
        finally { token=''; }
    }

    async lerContextoConexao(medicoId: string, agora: Date): Promise<ContextoConexaoAgenda> {
        // O link mais recente define a agenda do contexto: renovação preserva a agenda já escolhida pelo médico.
        const link = (await this.deps.pool.query(`select l.agenda, l.usado_em, l.expira_em,
            (select a.criado_em from cofre_links_auditoria a where a.link_id=l.id and a.evento='enviado' limit 1) as enviado_em
            from cofre_links l where l.medico_id=$1 and l.agenda in ('tribemd','amplimed') order by l.criado_em desc limit 1`, [medicoId])).rows[0];
        const cofreDoContexto = link ? this.cofreDe(link.agenda) ?? this.deps.cofre : this.deps.cofre;
        const status = await cofreDoContexto.status(medicoId);
        const agendaConectada = status.estado === 'conectado' && !!status.ativo;
        return { agendaConectada, aguardandoConexao: !agendaConectada && !!link, link: link ? {
            agenda: link.agenda,
            enviado: !!link.enviado_em,
            minutosDesdeEnvio: link.enviado_em ? Math.max(0, Math.floor((agora.getTime() - new Date(link.enviado_em).getTime()) / 60000)) : null,
            usado: !!link.usado_em, expirado: new Date(link.expira_em).getTime() <= agora.getTime(),
            rejeitado: status.estado === 'atencao' ? true : null
        } : null };
    }

    /** Cofre de dados profissionais: usa a MESMA tabela de links efêmeros,
     * o mesmo mecanismo de recibo e a mesma proteção de origem. Finalidade
     * isolada de credenciais das agendas. O link não confirma nem salva CRM.
     */
    /** Estado do link seguro baseado em transporte e recibo, nunca em timeout. */
    async solicitarLinkRegistro(
        contaId:string,medicoId:string,telefone:string,
        acao:'solicitar'|'consultar'|'substituir'='solicitar',mensagemId?:string
    ):Promise<{ok:boolean;motivo:string}>{
        const variantes=gerarVariantesTelefoneBrasileiro(telefone);
        if(!variantes.length||!['solicitar','consultar','substituir'].includes(acao))
            return {ok:false,motivo:'OPERADOR_NAO_AUTORIZADO'};
        if(mensagemId!==undefined&&!/^[A-Za-z0-9_-]{5,150}$/.test(mensagemId))
            return {ok:false,motivo:'PEDIDO_INVALIDO'};
        const client=await this.deps.pool.connect();
        let token='',linkId='',confirmado=false;
        try{
            await client.query('begin');
            const registro=(await client.query([
              'select m.nome_completo,c.estado',
              'from public.medicos m join public.noto_agent_conversas c on c.conta_id=m.conta_id',
              'where m.id=$1::uuid and m.conta_id=$2 for update of c'
            ].join('\n'),[medicoId,contaId])).rows[0];
            const dados=registro?.estado?.pesquisasRegistro?.[medicoId];
            if(!dados||!nomeProfissionalValido(registro.nome_completo)||
                registro.nome_completo!==dados.nome||
                registro.estado.profissionalConfirmadoId!==medicoId||
                !['manual_pendente','aguardando_confirmacao','aguardando_preenchimento',
                  'link_manual_reservado'].includes(dados.estado))
                return {ok:false,motivo:'REVISAO_NAO_AUTORIZADA'};
            const operadores=(await client.query(
              'select telefone from public.usuarios where conta_id=$1 and ativo=true and auth_user_id is not null',
              [contaId])).rows;
            if(!operadores.some(u=>gerarVariantesTelefoneBrasileiro(String(u.telefone??'')).some(v=>variantes.includes(v))))
                return {ok:false,motivo:'OPERADOR_NAO_AUTORIZADO'};
            const ultimo=(await client.query([
              'select l.id,l.usado_em,l.expira_em,e.estado,',
              "exists(select 1 from public.cofre_links_auditoria a where a.link_id=l.id and a.evento='enviado') as aceite_audit,",
              "exists(select 1 from public.cofre_links_auditoria a where a.link_id=l.id and a.evento='falha_comprovada') as falha_audit",
              'from public.cofre_links l',
              'left join public.cofre_links_entregas e on e.link_id=l.id',
              "where l.medico_id=$1::uuid and l.agenda='registro_profissional'",
              'order by l.criado_em desc,l.id desc limit 1'
            ].join('\n'),[medicoId])).rows[0];
            const vivo=ultimo&&!ultimo.usado_em&&new Date(ultimo.expira_em).getTime()>Date.now();
            const situacao=ultimo?.estado==='READ'?'LIDO':
              ultimo?.estado==='DELIVERY_ACK'?'ENTREGUE':
              ultimo?.estado==='ERROR'||ultimo?.falha_audit?'FALHA_COMPROVADA':
              ['ACEITO_API','PENDING','SERVER_ACK'].includes(ultimo?.estado)||
                ultimo?.aceite_audit?'ACEITO_SEM_ENTREGA':'ENVIO_INCERTO';
            if(acao==='consultar')return vivo
              ? {ok:situacao!=='FALHA_COMPROVADA',motivo:situacao}
              : {ok:false,motivo:'SEM_LINK_ATIVO'};
            // Reserva por ID da mensagem antes do I/O: crash/replay não reenvia.
            if(mensagemId&&dados.solicitacaoLinkMensagemId===mensagemId)
                return {ok:false,motivo:'PEDIDO_JA_PROCESSADO'};
            if(vivo&&situacao!=='FALHA_COMPROVADA'){
                if(acao!=='substituir')return {ok:false,motivo:situacao};
                if(!['ENVIO_INCERTO','ACEITO_SEM_ENTREGA'].includes(situacao))
                    return {ok:false,motivo:'LINK_ENTREGUE'};
            }else if(acao==='substituir')return {ok:false,motivo:'SEM_LINK_ATIVO'};
            const limite=(await client.query([
              'select count(*)::int as total from public.cofre_links',
              "where medico_id=$1::uuid and criado_em>now()-interval '1 hour'"
            ].join('\n'),[medicoId])).rows[0];
            if(Number(limite?.total??0)>=3)return {ok:false,motivo:'LIMITE_LINKS'};
            // Antigo revogado + novo inserido na MESMA transação e só nesta finalidade.
            await client.query([
              'with antigos as (update public.cofre_links',
              'set expira_em=least(expira_em,clock_timestamp())',
              "where medico_id=$1::uuid and agenda='registro_profissional'",
              'and usado_em is null and expira_em>clock_timestamp() returning id)',
              'insert into public.cofre_links_auditoria(link_id,evento)',
              "select id,'expirado' from antigos on conflict do nothing"
            ].join('\n'),[medicoId]);
            token=randomBytes(32).toString('base64url');
            const criadoLink=await client.query([
              'insert into public.cofre_links',
              '(medico_id,agenda,token_hash,expira_em,criado_em,destino_telefone)',
              "values ($1::uuid,'registro_profissional',$2,now()+interval '15 minutes',now(),$3)",
              'returning id'
            ].join('\n'),[medicoId,this.hash(token),telefone]);
            linkId=criadoLink.rows[0].id;
            await client.query("insert into public.cofre_links_auditoria(link_id,evento) values($1,'criado') on conflict do nothing",[linkId]);
            await client.query([
              'update public.noto_agent_conversas c set',
              "estado=jsonb_set(c.estado,array['pesquisasRegistro',$2::text],",
              "c.estado#>array['pesquisasRegistro',$2::text]||",
              "jsonb_build_object('estado','link_manual_reservado',",
              "'solicitacaoLinkMensagemId',$3::text),false),atualizado_em=now()",
              'where c.conta_id=$1'
            ].join('\n'),[contaId,medicoId,mensagemId??'']);
            await client.query('commit');
            confirmado=true;
        }catch{return {ok:false,motivo:'LINK_INDISPONIVEL'};}
        finally{
            if(!confirmado)await client.query('rollback').catch(()=>undefined);
            client.release();
        }
        // Erro ou crash após COMMIT não permite repetir URL automaticamente.
        try{
            const url=this.deps.origem+'/c/registro/'+token;
            const envio=this.deps.enviarUrlComRecibo
                ? await this.deps.enviarUrlComRecibo({referenciaCofre:medicoId,url,linkId,telefone})
                : await this.deps.enviar(medicoId,url,telefone);
            if(envio==='erro'&&this.deps.enviarUrlComRecibo){
                // Rejeição explícita. Se já houve ACK, não podemos revogar
                // sob uma falsa certeza de falha.
                const c=await this.deps.pool.connect();let concluiu=false;
                try{
                    await c.query('begin');
                    const falha=await c.query([
                      'update public.cofre_links l',
                      'set expira_em=least(l.expira_em,clock_timestamp())',
                      'where l.id=$1 and l.usado_em is null',
                      'and not exists(select 1 from public.cofre_links_entregas e',
                      "where e.link_id=l.id and e.estado in ('ACEITO_API','PENDING','SERVER_ACK','DELIVERY_ACK','READ'))",
                      'returning l.id'
                    ].join('\n'),[linkId]);
                    if(falha.rows.length){
                        await c.query([
                          'insert into public.cofre_links_auditoria(link_id,evento)',
                          "values($1,'falha_comprovada') on conflict do nothing"
                        ].join('\n'),[linkId]);
                        await c.query([
                          'update public.noto_agent_conversas c set',
                          "estado=jsonb_set(c.estado,array['pesquisasRegistro',$2::text,'estado'],",
                          "'\"manual_pendente\"'::jsonb,false),atualizado_em=now()",
                          'where c.conta_id=$1 and',
                          "c.estado#>>array['pesquisasRegistro',$2::text,'estado']='link_manual_reservado'"
                        ].join('\n'),[contaId,medicoId]);
                    }
                    await c.query('commit');concluiu=true;
                    if(falha.rows.length)return {ok:false,motivo:'FALHA_COMPROVADA'};
                }finally{
                    if(!concluiu)await c.query('rollback').catch(()=>undefined);
                    c.release();
                }
                return {ok:false,motivo:'ENVIO_INCERTO'};
            }
            if(envio!=='enviado')return {ok:false,motivo:'ENVIO_INCERTO'};
            await this.auditar(linkId,'enviado');
            await this.deps.pool.query([
              'update public.noto_agent_conversas c set',
              "estado=jsonb_set(c.estado,array['pesquisasRegistro',$2::text,'estado'],",
              "'\"aguardando_preenchimento\"'::jsonb,false),atualizado_em=now()",
              'where c.conta_id=$1 and',
              "c.estado#>>array['pesquisasRegistro',$2::text,'estado']='link_manual_reservado'"
            ].join('\n'),[contaId,medicoId]);
            return {ok:true,motivo:'ACEITO_API'};
        }catch{return {ok:false,motivo:'ENVIO_INCERTO'};}
        finally{token='';}
    }

    async validarLinkRegistro(token:string):Promise<{nome:string}|null>{
        if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
        const r=await this.deps.pool.query([
          'select m.nome_completo',
          'from public.cofre_links l join public.medicos m on m.id=l.medico_id',
          'join public.noto_agent_conversas c on c.conta_id=m.conta_id',
          "where l.token_hash=$1 and l.agenda='registro_profissional'",
          'and l.usado_em is null and l.expira_em>now()',
          "and c.estado#>>array['pesquisasRegistro',m.id::text,'nome']=m.nome_completo",
          "and c.estado#>>array['pesquisasRegistro',m.id::text,'estado']",
          "in ('link_manual_reservado','aguardando_preenchimento') limit 1"
        ].join('\n'),[this.hash(token)]);
        return nomeProfissionalValido(r.rows[0]?.nome_completo)?{nome:r.rows[0].nome_completo}:null;
    }
    async enviarRegistroManual(token:string,dados:{crm:string;rqe?:string}):Promise<boolean>{
        if(!/^[A-Za-z0-9_-]{43}$/.test(token))return false;
        const crm=normalizarCrm(dados.crm);
        const rqe=dados.rqe?.trim()??'';
        if(!crm?.includes('/')||(rqe&&!/^[1-9]\d{0,11}$/.test(rqe)))return false;
        const client=await this.deps.pool.connect();
        let confirmado=false;
        try{
            await client.query('begin');
            const r=await client.query([
              'select l.id,m.id as medico_id,m.conta_id,m.nome_completo',
              'from public.cofre_links l join public.medicos m on m.id=l.medico_id',
              "where l.token_hash=$1 and l.agenda='registro_profissional'",
              'and l.usado_em is null and l.expira_em>now() for update of l'
            ].join('\n'),[this.hash(token)]);
            const registro=r.rows[0];
            if(!registro)return false;
            const proposta={crm,...(rqe?{rqe}:{}),origem:'manual'};
            const state=await client.query([
              'update public.noto_agent_conversas c',
              "set estado=jsonb_set(c.estado,array['pesquisasRegistro',$2::text],",
              "c.estado#>array['pesquisasRegistro',$2::text]||",
              "jsonb_build_object('estado','resultado_pronto','razao','MANUAL_INFORMADO',",
              "'proposta',$3::jsonb,'candidatos','[]'::jsonb),false),atualizado_em=now()",
              'where c.conta_id=$1',
              "and c.estado#>>array['pesquisasRegistro',$2::text,'nome']=$4",
              "and c.estado#>>array['pesquisasRegistro',$2::text,'estado']",
              "in ('link_manual_reservado','aguardando_preenchimento')",
              'returning conta_id'
            ].join('\n'),[registro.conta_id,registro.medico_id,JSON.stringify(proposta),registro.nome_completo]);
            if(state.rows.length!==1)return false;
            await client.query('update public.cofre_links set usado_em=now() where id=$1 and usado_em is null',[registro.id]);
            await client.query('commit');
            confirmado=true;
            return true;
        }catch{return false;}
        finally{
            if(!confirmado)await client.query('rollback').catch(()=>undefined);
            client.release();
        }
    }

    private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }
    private async auditar(id: string, evento: string) {
        await this.deps.pool.query('insert into cofre_links_auditoria (link_id, evento) values ($1,$2) on conflict do nothing', [id, evento]);
    }
    async validar(token: string) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
        const link = (await this.deps.pool.query(`select id, usado_em, expira_em<=now() as expirado
            from cofre_links where token_hash=$1 and agenda in ('tribemd','amplimed')`, [this.hash(token)])).rows[0];
        if (!link) return false;
        if (link.expirado && !link.usado_em) await this.auditar(link.id, 'expirado');
        if (link.expirado || link.usado_em) return false;
        await this.auditar(link.id, 'aberto');
        return true;
    }
    async enviarCredencial(token: string, dados: { email: string; senha: string; consentimento: string }) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
        const link = (await this.deps.pool.query(`update cofre_links set usado_em=now()
            where token_hash=$1 and usado_em is null and expira_em>now() and agenda in ('tribemd','amplimed') returning medico_id, conta_id, id, agenda, destino_telefone`, [this.hash(token)])).rows[0];
        if (!link) { await this.validar(token); return false; }
        const chaveCofre = link.conta_id ? cofreIdDaConta(link.conta_id) : link.medico_id;
        if (!chaveCofre) throw Error('COFRE_TITULAR_INVALIDO');
        this.aguardando.set(chaveCofre, { id: link.id, agenda: link.agenda, ...(link.destino_telefone?{contatoTelefone:link.destino_telefone}:{}) });
        try {
            const c = this.cofreDe(link.agenda);
            if (!c || dados.consentimento !== AGENDAS_SUPORTADAS[link.agenda as AgendaSuportada].consentimento) throw Error();
            await c.iniciar(chaveCofre, dados);
        }
        catch { await this.concluir(chaveCofre, false); throw Error('COFRE_INDISPONIVEL'); }
        return true;
    }
    async concluir(medicoId: string, conectado: boolean) {
        const link = this.aguardando.get(medicoId);
        if (!link || !agendaSuportada(link.agenda)) return;
        this.aguardando.delete(medicoId);
        const { rows } = await this.deps.pool.query(`insert into cofre_links_auditoria (link_id, evento) values ($1, 'concluido') on conflict do nothing returning link_id`, [link.id]);
        if (!rows.length) return;
        const falhaAcesso = !conectado && (await (this.cofreDe(link.agenda) ?? this.deps.cofre).status(medicoId).catch(() => null))?.codigo === 'ACESSO_PRECISA_VERIFICACAO';
        // O sucesso da conta é um evento de onboarding, não de médico/emissão.
        const contaId = contaDoCofreId(medicoId);
        if (contaId && this.deps.aoConcluirConta) {
            await this.deps.aoConcluirConta(contaId, {
                agenda: link.agenda as AgendaSuportada, conectado, chave: link.id,
                ...(link.contatoTelefone?{contatoTelefone:link.contatoTelefone}:{}),
                ...(!conectado?{falhaAcesso}:{})
            });
            return;
        }
        // Notificações fiscais/por médico não recebem o ID da conta.
        if (this.deps.aoConcluir && !contaId) { await this.deps.aoConcluir(medicoId, { agenda: link.agenda as AgendaSuportada, conectado, chave: link.id, ...(link.contatoTelefone?{contatoTelefone:link.contatoTelefone}:{}), ...(!conectado ? { falhaAcesso } : {}) }); return; }
        await this.deps.enviar(medicoId, conectado ? `Já recebi o seu acesso ao ${AGENDAS_SUPORTADAS[link.agenda as AgendaSuportada].nome}.` : falhaAcesso ? `Não consegui conectar sua agenda ${AGENDAS_SUPORTADAS[link.agenda as AgendaSuportada].nome}: o serviço está exigindo uma etapa de verificação a mais na sua conta (como a verificação em duas etapas, 2FA). Sem concluir essa etapa na área segura da sua conta, não consigo acessar.` : 'Não consegui conectar sua agenda agora. Tive uma instabilidade e não consegui concluir agora.', link.contatoTelefone);
    }
    async tratarMensagem(medicoId: string, texto: string, classificar: (texto: string) => Promise<string | null>, contatoTelefone?:string) {
        const credencial = contemCredencialAgenda(texto);
        // Enquanto há link pendente, nem uma senha sem rótulo segue para memória ou IA.
        const pendente = (await this.deps.pool.query(`select id, agenda from cofre_links where medico_id=$1
            and agenda in ('tribemd','amplimed') and usado_em is null and expira_em>now() order by criado_em desc limit 1`, [medicoId])).rows[0];
        if (credencial || pendente) {
            const agendaPendente=agendaSuportada(pendente?.agenda);
            if(agendaPendente)await this.solicitarLinkCofre(medicoId, agendaPendente,{contatoTelefone});
            return true;
        }
        const agenda = await classificar(texto);
        if (!agenda) return false;
        await this.solicitarLinkCofre(medicoId, agenda,{contatoTelefone});
        return true;
    }
}
