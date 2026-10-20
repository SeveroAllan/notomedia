import type { FonteAgenda, ResultadoFonteAgenda } from '../agenda/fonte-agenda.js';
import { PerfisTribemd, type PerfilTribemd } from '../desenvolvedor/tribemd-perfil.js';
import { NavegadorTribemd, ErroTribemd, type ResultadoLeituraTribemd } from '../desenvolvedor/tribemd-navegador.js';
export class ErroCofre extends Error {
    constructor(public codigo: string) { super(codigo); }
}
interface Trabalho {
    janela?: { janelaDias: number; agora: Date };
    controller: AbortController;
    finalizada: Promise<void>;
    concluir: () => void;
}
export interface OpcoesCofre {
    diretorio: string;
    chave: string;
    chromium: string;
    xvfb?: string;
    simultaneos?: number;
    aoConcluir?: (medicoId: string, conectado: boolean) => Promise<void>;
}
export const consentimentoCofre = 'tribemd-leitura-v1';
/** Credencial e cookies só no envelope; resultados transitórios não entram no banco, log ou IA. */
export class CofreTribemd {
    private perfis: PerfisTribemd;
    private trabalhos = new Map<string, Trabalho>();
    private parando = false;
    private alterando = new Set<string>();
    private resultados = new Map<string, {
        resultado: ResultadoLeituraTribemd;
        timer: NodeJS.Timeout;
    }>();
    constructor(private opcoes: OpcoesCofre) { this.perfis = new PerfisTribemd(opcoes.diretorio, opcoes.chave); }
    private limparCredencial(p: PerfilTribemd) { p.email = ''; p.senha = ''; }
    private limparResultado(id: string) { const anterior = this.resultados.get(id); if (anterior)
        clearTimeout(anterior.timer); this.resultados.delete(id); }
    async status(id: string) {
        const p = await this.perfis.ler(id);
        try {
            const estado: NonNullable<PerfilTribemd['cofre']>['estado'] | 'conectando' | 'vazio' = this.trabalhos.has(id) ? 'conectando' : p.cofre?.estado ?? (p.senha ? 'salvo' : 'vazio');
            return { salvo: !!p.senha, estado,
                ativo: p.cofre?.ativo ?? false, verificadoEm: p.cofre?.verificadoEm ?? null, codigo: p.cofre?.codigo ?? null,
                consultasDisponiveis: this.resultados.get(id)?.resultado.consultas.length ?? null };
        }
        finally {
            this.limparCredencial(p);
        }
    }
    async iniciar(id: string, credencial?: {
        email: string;
        senha: string;
    }, exigirAtivo = false, janela?: { janelaDias: number; agora: Date }) {
        if (this.parando)
            throw new ErroCofre('COFRE_ENCERRANDO');
        if (this.trabalhos.has(id) || this.alterando.has(id))
            throw new ErroCofre('COFRE_OCUPADO');
        if (this.trabalhos.size >= (this.opcoes.simultaneos ?? 2))
            throw new ErroCofre('NAVEGADORES_OCUPADOS');
        let concluir!: () => void;
        const trabalho: Trabalho = { janela, controller: new AbortController(), finalizada: new Promise<void>(r => { concluir = r; }), concluir: () => concluir() };
        this.trabalhos.set(id, trabalho);
        let liberar: (() => Promise<void>) | undefined, p: PerfilTribemd = {};
        try {
            liberar = await this.perfis.bloquear(id);
            trabalho.controller.signal.throwIfAborted();
            p = await this.perfis.ler(id);
            if (credencial)
                p = { email: credencial.email, senha: credencial.senha };
            else if (!p.email || !p.senha)
                throw new ErroCofre('CREDENCIAL_AUSENTE');
            if (!credencial && (!p.cofre?.consentimentoEm || p.cofre.consentimentoVersao !== consentimentoCofre))
                throw new ErroCofre('CONSENTIMENTO_NECESSARIO');
            if (exigirAtivo && !p.cofre?.ativo)
                throw new ErroCofre('COFRE_DESCONECTADO');
            const agora = new Date().toISOString();
            p.cofre = { ativo: true, estado: 'salvo', consentimentoEm: credencial ? agora : p.cofre!.consentimentoEm, consentimentoVersao: consentimentoCofre, atualizadoEm: agora };
            trabalho.controller.signal.throwIfAborted();
            await this.perfis.salvar(id, p);
            this.limparResultado(id);
            trabalho.controller.signal.throwIfAborted();
            const soltar = liberar;
            liberar = undefined;
            void this.executar(id, trabalho, p, soltar);
            return { salvo: true, estado: 'conectando', ativo: true, verificadoEm: null, codigo: null, consultasDisponiveis: null };
        }
        catch (e) {
            this.limparCredencial(p);
            await liberar?.().catch(() => { });
            if (this.trabalhos.get(id) === trabalho)
                this.trabalhos.delete(id);
            trabalho.concluir();
            throw e instanceof ErroCofre ? e : new ErroCofre('COFRE_INDISPONIVEL');
        }
    }
    private async executar(id: string, t: Trabalho, p: PerfilTribemd, liberar: () => Promise<void>) {
        let navegador: NavegadorTribemd | undefined, entrouComSenha = false, tempoEsgotado = false;
        const limite = setTimeout(() => { tempoEsgotado = true; t.controller.abort(); }, 120000);
        limite.unref();
        const autenticar = async (usarCookies: boolean) => {
            t.controller.signal.throwIfAborted();
            navegador = await NavegadorTribemd.criar({ executavel: this.opcoes.chromium, xvfb: this.opcoes.xvfb, estado: usarCookies ? p.estado : undefined }, t.controller.signal);
            const estado = await navegador.abrir();
            if (estado !== 'perfil_reutilizado') {
                entrouComSenha = true;
                await navegador.entrar(p.email!, p.senha!);
            }
        };
        try {
            let resultado: ResultadoLeituraTribemd;
            try {
                await autenticar(true);
                resultado = t.janela ? await navegador!.ler('agenda', true, t.janela) : await navegador!.ler('agenda', true);
            }
            catch (e) {
                const expirou = e instanceof ErroTribemd && (e.codigo === 'SESSAO_EXPIRADA' || !entrouComSenha && e.diagnostico?.rede?.chamadas.some(c => c.statusHttp === 401 && c.rota !== '/api/usuarios/login'));
                if (!expirou)
                    throw e;
                await navegador?.encerrar();
                await autenticar(false);
                resultado = t.janela ? await navegador!.ler('agenda', true, t.janela) : await navegador!.ler('agenda', true);
            }
            t.controller.signal.throwIfAborted();
            p.estado = await navegador!.perfil();
            const agora = new Date().toISOString();
            p.cofre = { ...p.cofre!, estado: 'conectado', verificadoEm: agora, atualizadoEm: agora };
            await this.perfis.salvar(id, p);
            t.controller.signal.throwIfAborted();
            const timer = setTimeout(() => this.limparResultado(id), 5 * 60000);
            timer.unref();
            this.resultados.set(id, { resultado, timer });
        }
        catch (e) {
            if (!t.controller.signal.aborted || tempoEsgotado) {
                const autenticado = !tempoEsgotado && navegador?.estaAutenticado();
                if (autenticado)
                    p.estado = await navegador!.perfil().catch(() => undefined);
                const codigo = tempoEsgotado ? 'TEMPO_ESGOTADO' : e instanceof ErroTribemd && ['LOGIN_NAO_CONFIRMADO', 'LOGIN_LAYOUT_NAO_RECONHECIDO', 'SESSAO_EXPIRADA'].includes(e.codigo) ? 'ACESSO_PRECISA_VERIFICACAO' : 'LEITURA_NAO_CONCLUIDA';
                const agora = new Date().toISOString();
                p.cofre = { ...p.cofre!, estado: autenticado ? 'conectado' : 'atencao', codigo, atualizadoEm: agora, ...(autenticado ? { verificadoEm: agora } : {}) };
                await this.perfis.salvar(id, p).catch(() => { });
            }
        }
        finally {
            clearTimeout(limite);
            this.limparCredencial(p);
            await navegador?.encerrar().catch(() => { });
            await liberar().catch(() => { });
            if (this.trabalhos.get(id) === t)
                this.trabalhos.delete(id);
            t.concluir();
            await this.opcoes.aoConcluir?.(id, p.cofre?.estado === 'conectado').catch(() => {});
        }
    }
    private async interromper(id: string) { const t = this.trabalhos.get(id); if (t) {
        t.controller.abort();
        await t.finalizada;
    } this.limparResultado(id); }
    private async alterar(id: string, apagar: boolean) {
        if (this.alterando.has(id))
            throw new ErroCofre('COFRE_OCUPADO');
        this.alterando.add(id);
        let liberar: (() => Promise<void>) | undefined, p: PerfilTribemd = {};
        try {
            await this.interromper(id);
            liberar = await this.perfis.bloquear(id);
            if (apagar) {
                await this.perfis.esquecer(id);
                return;
            }
            p = await this.perfis.ler(id);
            if (p.senha) {
                p.estado = undefined;
                p.cofre = { ...p.cofre!, ativo: false, estado: 'desconectado', atualizadoEm: new Date().toISOString() };
                await this.perfis.salvar(id, p);
            }
        }
        finally {
            this.limparCredencial(p);
            await liberar?.().catch(() => { });
            this.alterando.delete(id);
        }
    }
    async desconectar(id: string) { await this.alterar(id, false); }
    async excluir(id: string) { await this.alterar(id, true); }
    async consultar(id: string, janelaDias = 90, agora = new Date()) { return this.iniciar(id, undefined, true, { janelaDias, agora }); }
    readonly fonteAgenda: FonteAgenda = { consultar: async ({ medicoId, janelaDias = 90, agora = new Date() }): Promise<ResultadoFonteAgenda> => {
        try {
            const status = await this.status(medicoId);
            if (!status.salvo || !status.ativo) return { tipo: 'erro', codigo: 'SEM_AGENDA_CONECTADA' };
            await this.consultar(medicoId, janelaDias, agora);
            await this.trabalhos.get(medicoId)?.finalizada;
            const resultado = this.resultado(medicoId);
            if (!resultado) return { tipo: 'erro', codigo: (await this.status(medicoId)).codigo === 'ACESSO_PRECISA_VERIFICACAO' ? 'ACESSO_EXPIRADO' : 'FONTE_INDISPONIVEL' };
            const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora);
            const inicio = new Date(hoje + 'T12:00:00Z'); inicio.setUTCDate(inicio.getUTCDate() - janelaDias);
            if (resultado.cobertura !== 'intervalo_carregado_pelo_portal' || !resultado.agenda?.intervalo.fim ||
                resultado.agenda.intervalo.fim < hoje || !resultado.agenda.intervalo.inicio || resultado.agenda.intervalo.inicio > inicio.toISOString().slice(0, 10) || resultado.agenda.limitado || !resultado.detalhes || resultado.detalhes.pendentes) {
                return { tipo: 'erro', codigo: 'FONTE_INDISPONIVEL' };
            }
            return { tipo: 'consultas', fonte: 'tribemd', consultas: resultado.consultas.map(c => {
                if (!c.pacienteId || !c.atendimentoId || !c.dataConsultaObservada || c.dados?.codigo) throw new ErroCofre('LEITURA_INCOMPLETA');
                const valor = c.dados?.valorConsulta;
                return { pacienteId: c.pacienteId, idExterno: c.atendimentoId, dataHora: c.dataConsultaObservada,
                    telefonePaciente: c.dados?.contato.celular ?? c.dados?.contato.telefone ?? undefined,
                    status: 'realizada' as const, valorConsultaCentavos: valor && /^\d+\.\d{2}$/.test(valor) ? Number(valor.replace('.', '')) : null };
            }) };
        } catch { return { tipo: 'erro', codigo: 'FONTE_INDISPONIVEL' }; }
        finally { this.limparResultado(medicoId); }
    } };
    resultado(id: string) { return this.resultados.get(id)?.resultado ?? null; }
    async encerrar() { this.parando = true; await Promise.all([...this.trabalhos.keys()].map(id => this.interromper(id))); for (const id of this.resultados.keys())
        this.limparResultado(id); }
}
