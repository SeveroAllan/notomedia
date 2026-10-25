import { FALA_PEDIDO_CONEXAO_AGENDA, FALA_SEGURANCA_LINK_AGENDA, FALA_NOVO_LINK_AGENDA } from '../onboarding/falas.js';
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { AGENDAS_SUPORTADAS, agendaSuportada, type AgendaSuportada } from '../agenda/agendas-suportadas.js';

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
        registrarTextoEnviado?: (entrada: TextoLinkAgendaEnviado) => Promise<void>;
        enviar: (medicoId: string, texto: string, contatoTelefone?:string) => Promise<'simulado' | 'enviado' | 'erro'>;
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
            const medico = (await cliente.query(`select u.ativo, u.telefone from medicos m
                join usuarios u on u.id=m.usuario_id where m.id=$1 for update of m, u`, [medicoId])).rows[0];
            if (!medico) return { ok: false, motivo: 'MEDICO_INEXISTENTE' };
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
                const envio = await this.deps.enviar(medicoId, texto, telefoneMedico);
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

    async lerContextoConexao(medicoId: string, agora: Date): Promise<ContextoConexaoAgenda> {
        // O link mais recente define a agenda do contexto: renovação preserva a agenda já escolhida pelo médico.
        const link = (await this.deps.pool.query(`select l.agenda, l.usado_em, l.expira_em,
            (select a.criado_em from cofre_links_auditoria a where a.link_id=l.id and a.evento='enviado' limit 1) as enviado_em
            from cofre_links l where l.medico_id=$1 order by l.criado_em desc limit 1`, [medicoId])).rows[0];
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

    private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }
    private async auditar(id: string, evento: string) {
        await this.deps.pool.query('insert into cofre_links_auditoria (link_id, evento) values ($1,$2) on conflict do nothing', [id, evento]);
    }
    async validar(token: string) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
        const link = (await this.deps.pool.query(`select id, usado_em, expira_em<=now() as expirado
            from cofre_links where token_hash=$1`, [this.hash(token)])).rows[0];
        if (!link) return false;
        if (link.expirado && !link.usado_em) await this.auditar(link.id, 'expirado');
        if (link.expirado || link.usado_em) return false;
        await this.auditar(link.id, 'aberto');
        return true;
    }
    async enviarCredencial(token: string, dados: { email: string; senha: string; consentimento: string }) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
        const link = (await this.deps.pool.query(`update cofre_links set usado_em=now()
            where token_hash=$1 and usado_em is null and expira_em>now() returning medico_id, id, agenda, destino_telefone`, [this.hash(token)])).rows[0];
        if (!link) { await this.validar(token); return false; }
        this.aguardando.set(link.medico_id, { id: link.id, agenda: link.agenda, ...(link.destino_telefone?{contatoTelefone:link.destino_telefone}:{}) });
        try {
            const c = this.cofreDe(link.agenda);
            if (!c || dados.consentimento !== AGENDAS_SUPORTADAS[link.agenda as AgendaSuportada].consentimento) throw Error();
            await c.iniciar(link.medico_id, dados);
        }
        catch { await this.concluir(link.medico_id, false); throw Error('COFRE_INDISPONIVEL'); }
        return true;
    }
    async concluir(medicoId: string, conectado: boolean) {
        const link = this.aguardando.get(medicoId);
        if (!link || !agendaSuportada(link.agenda)) return;
        this.aguardando.delete(medicoId);
        const { rows } = await this.deps.pool.query(`insert into cofre_links_auditoria (link_id, evento) values ($1, 'concluido') on conflict do nothing returning link_id`, [link.id]);
        if (!rows.length) return;
        const falhaAcesso = !conectado && (await (this.cofreDe(link.agenda) ?? this.deps.cofre).status(medicoId).catch(() => null))?.codigo === 'ACESSO_PRECISA_VERIFICACAO';
        if (this.deps.aoConcluir) { await this.deps.aoConcluir(medicoId, { agenda: link.agenda as AgendaSuportada, conectado, chave: link.id, ...(link.contatoTelefone?{contatoTelefone:link.contatoTelefone}:{}), ...(!conectado ? { falhaAcesso } : {}) }); return; }
        await this.deps.enviar(medicoId, conectado ? `Já recebi o seu acesso ao ${AGENDAS_SUPORTADAS[link.agenda as AgendaSuportada].nome}.` : falhaAcesso ? `Não consegui conectar sua agenda ${AGENDAS_SUPORTADAS[link.agenda as AgendaSuportada].nome}: o serviço está exigindo uma etapa de verificação a mais na sua conta (como a verificação em duas etapas, 2FA). Sem concluir essa etapa na área segura da sua conta, não consigo acessar.` : 'Não consegui conectar sua agenda agora. Tive uma instabilidade e não consegui concluir agora.', link.contatoTelefone);
    }
    async tratarMensagem(medicoId: string, texto: string, classificar: (texto: string) => Promise<string | null>, contatoTelefone?:string) {
        const credencial = contemCredencialAgenda(texto);
        // Enquanto há link pendente, nem uma senha sem rótulo segue para memória ou IA.
        const pendente = (await this.deps.pool.query(`select id, agenda from cofre_links where medico_id=$1
            and usado_em is null and expira_em>now() order by criado_em desc limit 1`, [medicoId])).rows[0];
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
