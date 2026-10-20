import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { CofreTribemd } from './tribemd-cofre.js';

export interface ConclusaoAgenda { agenda: 'tribemd'; conectado: boolean; falhaAcesso?: boolean; chave: string }

export class LinksCofre {
    private aguardando = new Map<string, { id: string; agenda: string }>();
    constructor(private deps: {
        pool: pg.Pool;
        origem: string;
        cofre: Pick<CofreTribemd, 'status' | 'iniciar'>;
        aoConcluir?: (medicoId: string, evento: ConclusaoAgenda) => Promise<void>;
        enviar: (medicoId: string, texto: string) => Promise<'simulado' | 'enviado' | 'erro'>;
    }) {}

    async solicitarLinkCofre(medicoId: string, agenda: string) {
        if (agenda !== 'tribemd') return { ok: false, motivo: 'AGENDA_NAO_SUPORTADA' };
        const cliente = await this.deps.pool.connect();
        let link: { id: string };
        let token = '', confirmado = false;
        try {
            await cliente.query('begin');
            // A linha do médico serializa limite e invalidação, inclusive entre réplicas.
            const medico = (await cliente.query(`select u.ativo, u.telefone from medicos m
                join usuarios u on u.id=m.usuario_id where m.id=$1 for update of m, u`, [medicoId])).rows[0];
            if (!medico) return { ok: false, motivo: 'MEDICO_INEXISTENTE' };
            if (!medico.ativo) return { ok: false, motivo: 'MEDICO_INATIVO' };
            if (!medico.telefone?.trim()) return { ok: false, motivo: 'SEM_TELEFONE' };
            const status = await this.deps.cofre.status(medicoId);
            if (!['vazio', 'desconectado'].includes(status.estado)) return { ok: false, motivo: 'COFRE_NAO_DISPONIVEL' };
            const limite = (await cliente.query(`select count(*)::int as total from cofre_links
                where medico_id=$1 and criado_em>now()-interval '1 hour'`, [medicoId])).rows[0];
            if (limite.total >= 3) return { ok: false, motivo: 'LIMITE_PEDIDOS' };
            await cliente.query(`with expirados as (
                update cofre_links set expira_em=least(expira_em,now())
                where medico_id=$1 and agenda=$2 and usado_em is null returning id
            ) insert into cofre_links_auditoria (link_id, evento)
                select id, 'expirado' from expirados on conflict do nothing`, [medicoId, agenda]);
            token = randomBytes(32).toString('base64url');
            link = (await cliente.query(`insert into cofre_links (medico_id, agenda, token_hash, expira_em)
                values ($1,$2,$3,now()+interval '15 minutes') returning id`, [medicoId, agenda, this.hash(token)])).rows[0];
            await cliente.query('insert into cofre_links_auditoria (link_id, evento) values ($1,$2)', [link.id, 'criado']);
            await cliente.query('commit');
            confirmado = true;
        } finally {
            try { if (!confirmado) await cliente.query('rollback'); } finally { cliente.release(); }
        }
        try {
            const envio = await this.deps.enviar(medicoId,
                `Para conseguir emitir suas notas, preciso que você conecte sua agenda para cruzar consultas e pagamentos. Use este link seguro para colocar seu login e senha da agenda: ${this.deps.origem}/c/${token}\nEu não recebo senha pela conversa, só por esse link seguro. Vale por 15 minutos e só pode ser usado uma vez.`);
            if (envio === 'enviado') await this.auditar(link.id, 'enviado');
            return { ok: envio !== 'erro', motivo: envio };
        } finally { token = ''; }
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
            where token_hash=$1 and usado_em is null and expira_em>now() returning medico_id, id, agenda`, [this.hash(token)])).rows[0];
        if (!link) { await this.validar(token); return false; }
        this.aguardando.set(link.medico_id, { id: link.id, agenda: link.agenda });
        try { await this.deps.cofre.iniciar(link.medico_id, dados); }
        catch { await this.concluir(link.medico_id, false); throw Error('COFRE_INDISPONIVEL'); }
        return true;
    }
    async concluir(medicoId: string, conectado: boolean) {
        const link = this.aguardando.get(medicoId);
        if (!link || link.agenda !== 'tribemd') return;
        this.aguardando.delete(medicoId);
        const falhaAcesso = !conectado && (await this.deps.cofre.status(medicoId).catch(() => null))?.codigo === 'ACESSO_PRECISA_VERIFICACAO';
        if (this.deps.aoConcluir) { await this.deps.aoConcluir(medicoId, { agenda: link.agenda, conectado, chave: link.id, ...(!conectado ? { falhaAcesso } : {}) }); return; }
        await this.deps.enviar(medicoId, conectado ? 'Já recebi o seu acesso ao TribeMD.' : falhaAcesso ? 'Não consegui conectar sua agenda TribeMD. Confira seu login, senha e permissão de acesso na área segura da sua conta.' : 'Não consegui conectar sua agenda agora. Estamos com uma instabilidade no sistema; já vou verificar e te retorno.');
    }
    async tratarMensagem(medicoId: string, texto: string, classificar: (texto: string) => Promise<string | null>) {
        const credencial = /\b(senha|password|token|secret|segredo|api[_ -]?key)\b/i.test(texto) || /\/c\/[A-Za-z0-9_-]{43}/.test(texto);
        // Enquanto há link pendente, nem uma senha sem rótulo segue para memória ou IA.
        const pendente = (await this.deps.pool.query(`select id from cofre_links where medico_id=$1
            and usado_em is null and expira_em>now() limit 1`, [medicoId])).rows[0];
        if (credencial || pendente) {
            await this.solicitarLinkCofre(medicoId, 'tribemd');
            return true;
        }
        const agenda = await classificar(texto);
        if (!agenda) return false;
        await this.solicitarLinkCofre(medicoId, agenda);
        return true;
    }
}
