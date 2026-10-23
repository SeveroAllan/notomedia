import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

// Permissões do Noto: escolhas do operador do WhatsApp conectado, feitas por link com botões.
// Regra central: AUSÊNCIA de escolha NUNCA autoriza. "autonomo"/"paciente" só valem se gravados.
export const PERMISSOES = ['emitir_autonomo', 'entregar_paciente'] as const;
export type Permissao = typeof PERMISSOES[number];
export const VALORES: Record<Permissao, readonly string[]> = {
    emitir_autonomo: ['autonomo', 'sempre_perguntar'],
    entregar_paciente: ['paciente', 'so_medico'],
};
export const ROTULOS: Record<Permissao, { titulo: string; descricao: string; botoes: Record<string, string>; valorQueLibera: string }> = {
    emitir_autonomo: {
        titulo: 'Emissão das notas',
        descricao: 'Quando um comprovante bate com uma consulta da agenda, o Noto pode:',
        botoes: { autonomo: 'Emitir sozinho e me avisar a cada nota', sempre_perguntar: 'Perguntar antes de cada nota' },
        valorQueLibera: 'autonomo',
    },
    entregar_paciente: {
        titulo: 'Entrega da nota',
        descricao: 'Depois de emitida, a nota pode ser entregue:',
        botoes: { paciente: 'Direto ao paciente pelo meu WhatsApp', so_medico: 'Só para mim; eu repasso' },
        valorQueLibera: 'paciente',
    },
};
const TOKEN_FORMATO = /^[A-Za-z0-9_-]{43}$/;

export interface Escolha { valor: string; escolhido_por: string | null; atualizado_em: string }

export class Permissoes {
    constructor(private deps: { pool: pg.Pool; origem: string }) {}

    private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }

    /** Conta (WhatsApp conectado) de um médico, via vínculo conta↔médicos. Provisiona 1 médico = 1 conta
     * na primeira passagem; contas com vários médicos entram por vínculo explícito. A escolha é da conta:
     * vale para todos os médicos dela e nunca atravessa para outra conta. */
    private async contaDo(medicoId: string): Promise<{ id: string; numero_whatsapp: string; operador: string | null } | null> {
        const porVinculo = `select c.id, c.numero_whatsapp, c.operador
            from noto_whatsapps_medicos m join noto_whatsapps_conectados c on c.id=m.whatsapp_conectado_id
            where m.medico_id=$1`;
        const existente = (await this.deps.pool.query(porVinculo, [medicoId])).rows[0];
        if (existente) return existente;
        const medico = (await this.deps.pool.query(
            'select u.telefone from medicos m join usuarios u on u.id=m.usuario_id where m.id=$1 and u.ativo=true and u.telefone is not null', [medicoId])).rows[0];
        if (!medico?.telefone?.trim()) return null;
        const numero = medico.telefone.replace(/\D/g, '');
        const conta = (await this.deps.pool.query(
            `insert into noto_whatsapps_conectados (numero_whatsapp) values ($1)
             on conflict (numero_whatsapp) do update set numero_whatsapp=excluded.numero_whatsapp
             returning id, numero_whatsapp, operador`, [numero])).rows[0];
        if (!conta) return null;
        // do nothing: se outra transação vinculou este médico a outra conta, o vínculo existente vence.
        await this.deps.pool.query(
            'insert into noto_whatsapps_medicos (whatsapp_conectado_id, medico_id) values ($1,$2) on conflict (medico_id) do nothing',
            [conta.id, medicoId]);
        // Re-resolve pelo vínculo: a conta autoritativa é a do vínculo, não a recém-criada.
        return (await this.deps.pool.query(porVinculo, [medicoId])).rows[0] ?? null;
    }

    /** Escolha vigente. null = nunca escolhida (bloqueia autonomia/envio). */
    async ler(medicoId: string, permissao: Permissao): Promise<Escolha | null> {
        const conta = await this.contaDo(medicoId);
        if (!conta) return null;
        return (await this.deps.pool.query(
            'select valor, escolhido_por, atualizado_em::text from noto_permissoes where whatsapp_conectado_id=$1 and permissao=$2',
            [conta.id, permissao])).rows[0] ?? null;
    }

    /** A ação só é livre com a escolha que a libera gravada. */
    async permite(medicoId: string, permissao: Permissao): Promise<boolean> {
        const escolha = await this.ler(medicoId, permissao);
        return escolha?.valor === ROTULOS[permissao].valorQueLibera;
    }

    async faltantes(medicoId: string): Promise<Permissao[]> {
        const faltantes: Permissao[] = [];
        for (const p of PERMISSOES) if (!(await this.ler(medicoId, p))) faltantes.push(p);
        return faltantes;
    }

    /** Cria um link de escolha (uso único, 15 min), invalidando os anteriores da mesma permissão. */
    async criarLink(medicoId: string, permissao: Permissao): Promise<{ url: string } | { erro: 'SEM_CONTA' }> {
        if (!PERMISSOES.includes(permissao)) throw new Error('PERMISSAO_DESCONHECIDA');
        const conta = await this.contaDo(medicoId);
        if (!conta) return { erro: 'SEM_CONTA' };
        const cliente = await this.deps.pool.connect();
        let token = '';
        try {
            await cliente.query('begin');
            await cliente.query('select id from noto_whatsapps_conectados where id=$1 for update', [conta.id]);
            await cliente.query(
                `with expirados as (update noto_permissoes_links set expira_em=least(expira_em, clock_timestamp())
                    where whatsapp_conectado_id=$1 and permissao=$2 and usado_em is null and expira_em>clock_timestamp() returning id)
                 insert into noto_permissoes_links_auditoria (link_id, evento) select id, 'expirado' from expirados on conflict do nothing`,
                [conta.id, permissao]);
            token = randomBytes(32).toString('base64url');
            const link = (await cliente.query(
                `insert into noto_permissoes_links (whatsapp_conectado_id, permissao, criado_por_medico_id, token_hash, expira_em, criado_em)
                 values ($1,$2,$3,$4, clock_timestamp()+interval '15 minutes', clock_timestamp()) returning id`,
                [conta.id, permissao, medicoId, this.hash(token)])).rows[0];
            await cliente.query(`insert into noto_permissoes_links_auditoria (link_id, evento) values ($1,'criado') on conflict do nothing`, [link.id]);
            await cliente.query('commit');
        } catch (e) {
            try { await cliente.query('rollback'); } finally { cliente.release(); }
            throw e;
        }
        cliente.release();
        const url = `${this.deps.origem}/p/${token}`;
        token = '';
        return { url };
    }

    private async auditarLink(cliente: pg.PoolClient, id: string, evento: string) {
        await cliente.query('insert into noto_permissoes_links_auditoria (link_id, evento) values ($1,$2) on conflict do nothing', [id, evento]);
    }

    /** Já houve link desta permissão? Evita reenvio automático repetido. */
    async linkJaCriado(medicoId: string, permissao: Permissao): Promise<boolean> {
        const conta = await this.contaDo(medicoId);
        if (!conta) return false;
        return !!(await this.deps.pool.query(
            'select 1 from noto_permissoes_links where whatsapp_conectado_id=$1 and permissao=$2 limit 1',
            [conta.id, permissao])).rows.length;
    }

    /** GET: o link é válido e ainda não usado? Registra abertura. */
    async abrir(token: string): Promise<{ permissao: Permissao } | null> {
        if (!TOKEN_FORMATO.test(token)) return null;
        const link = (await this.deps.pool.query(
            `select id, permissao, usado_em, expira_em<=now() as expirado from noto_permissoes_links where token_hash=$1`,
            [this.hash(token)])).rows[0];
        if (!link) return null;
        if (link.expirado && !link.usado_em) await this.deps.pool.query(
            `insert into noto_permissoes_links_auditoria (link_id, evento) values ($1,'expirado') on conflict do nothing`, [link.id]).catch(() => {});
        if (link.expirado || link.usado_em) return null;
        await this.deps.pool.query(`insert into noto_permissoes_links_auditoria (link_id, evento) values ($1,'aberto') on conflict do nothing`, [link.id]).catch(() => {});
        return { permissao: link.permissao };
    }

    /** POST: grava a escolha de forma atômica (uso único) e auditável. Valor fora do conjunto = recusado. */
    async escolher(token: string, valor: string): Promise<{ ok: true; permissao: Permissao; valor: string; medicoId: string; linkId: string } | { ok: false; motivo: 'INVALIDO' | 'VALOR' }> {
        if (!TOKEN_FORMATO.test(token)) return { ok: false, motivo: 'INVALIDO' };
        const cliente = await this.deps.pool.connect();
        try {
            await cliente.query('begin');
            const link = (await cliente.query(
                `update noto_permissoes_links set usado_em=clock_timestamp()
                 where token_hash=$1 and usado_em is null and expira_em>clock_timestamp()
                 returning id, whatsapp_conectado_id, permissao, criado_por_medico_id`, [this.hash(token)])).rows[0];
            if (!link) { await cliente.query('rollback'); return { ok: false, motivo: 'INVALIDO' }; }
            const permissao = link.permissao as Permissao;
            if (!PERMISSOES.includes(permissao) || !VALORES[permissao].includes(valor)) {
                // Link queimado por tentativa inválida: valor fora do conjunto nunca grava.
                await this.auditarLink(cliente, link.id, 'usado');
                await cliente.query('commit');
                return { ok: false, motivo: 'VALOR' };
            }
            const conta = (await cliente.query('select operador from noto_whatsapps_conectados where id=$1', [link.whatsapp_conectado_id])).rows[0];
            await cliente.query(
                `insert into noto_permissoes (whatsapp_conectado_id, permissao, valor, escolhido_por, link_id, atualizado_em)
                 values ($1,$2,$3,$4,$5,clock_timestamp())
                 on conflict (whatsapp_conectado_id, permissao)
                 do update set valor=excluded.valor, escolhido_por=excluded.escolhido_por, link_id=excluded.link_id, atualizado_em=excluded.atualizado_em`,
                [link.whatsapp_conectado_id, permissao, valor, conta?.operador ?? null, link.id]);
            await cliente.query(
                `insert into noto_permissoes_auditoria (whatsapp_conectado_id, permissao, valor, escolhido_por, link_id)
                 values ($1,$2,$3,$4,$5)`, [link.whatsapp_conectado_id, permissao, valor, conta?.operador ?? null, link.id]);
            await this.auditarLink(cliente, link.id, 'usado');
            await cliente.query('commit');
            // Confirmação vai para a conversa de quem pediu o link, mesmo em conta com vários médicos.
            return { ok: true, permissao, valor, medicoId: link.criado_por_medico_id ?? '', linkId: link.id };
        } catch (e) {
            try { await cliente.query('rollback'); } finally { cliente.release(); }
            throw e;
        }
        cliente.release();
    }
}
