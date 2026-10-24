import { PerfisTribemd, type PerfilTribemd } from '../desenvolvedor/tribemd-perfil.js';
import { ErroCofre } from './tribemd-cofre.js';
import { diasAtrasAmplimed, montarLeituraAmplimed, type DetalheAmplimed } from '../agenda/amplimed-leitor.js';
import { separarElegiveis } from '../agenda/leitura-adaptativa.js';
import type { CodigoLoginAmplimed } from '../desenvolvedor/amplimed-navegador.js';
import type { EstadoNavegador } from '../desenvolvedor/tribemd-perfil.js';

/**
 * Cofre do Amplimed. Marco 1: guarda a credencial criptografada, separada da do TribeMD
 * (chave "amplimed-<id>"). Não faz login: a verificação em modo observação vem depois.
 */
export class CofreAmplimed {
    private perfis: PerfisTribemd;
    constructor(private opcoes: { diretorio: string; chave: string; aoAlterarAcesso?: (medicoId: string) => void;
        /** Login de observação; sem ele a credencial só é guardada. */
        verificar?: (credencial: { email: string; senha: string; estado?: EstadoNavegador; aoSalvarEstado?: (estado: EstadoNavegador) => void | Promise<void>; aoPedirCodigo2fa?: () => Promise<string | null> }) => Promise<CodigoLoginAmplimed>;
        /** Fallback assistido do desafio de 2FA (código transitório, vínculo à tentativa). Sem ele o desafio vira PRECISA_VERIFICACAO. */
        pedirCodigo2fa?: (medicoId: string) => Promise<string | null>;
        aoConcluir?: (medicoId: string, conectado: boolean) => Promise<void>;
        /** Leitura de observação da agenda do dia; sem ele a leitura fica indisponível. */
        lerEventos?: (credencial: { email: string; senha: string; estado?: EstadoNavegador; aoSalvarEstado?: (estado: EstadoNavegador) => void | Promise<void>; aoPedirCodigo2fa?: () => Promise<string | null> }, diasAtras: number, detalhes?: boolean) => Promise<{ codigo: CodigoLoginAmplimed; dias: { data: string; eventos: { texto: string; cor: string; detalhe?: DetalheAmplimed | null }[] }[]; profissional: string | null; completo: boolean }> }) {
        this.perfis = new PerfisTribemd(opcoes.diretorio, opcoes.chave);
    }
    private chave(id: string) { return 'amplimed-' + id; }
    private trancas = new Map<string, Promise<unknown>>();
    /** Uma tentativa de acesso por médico por vez neste processo: o desafio de 2FA consome um arquivo
     *  transitório único por médico; tentativas concorrentes disputariam o mesmo código. */
    private tranca<T>(id: string, fn: () => Promise<T>): Promise<T> {
        const anterior = this.trancas.get(id) ?? Promise.resolve();
        const atual = anterior.catch(() => {}).then(fn);
        this.trancas.set(id, atual);
        void atual.finally(() => { if (this.trancas.get(id) === atual) this.trancas.delete(id); });
        return atual;
    }
    /** Lê a sessão guardada e devolve os ganchos de sessão/2FA para uma tentativa de acesso. */
    private async ganchosSessao(id: string) {
        const p = await this.perfis.ler(this.chave(id));
        const estado = p.estado;
        p.email = ''; p.senha = '';
        const pedir = this.opcoes.pedirCodigo2fa;
        return { estado, aoPedirCodigo2fa: pedir ? () => pedir(id) : undefined,
            aoSalvarEstado: async (e: EstadoNavegador) => {
                const q = await this.perfis.ler(this.chave(id));
                try { if (q.senha) await this.perfis.salvar(this.chave(id), { ...q, estado: e }); }
                finally { q.email = ''; q.senha = ''; }
            } };
    }
    async status(id: string) {
        const p = await this.perfis.ler(this.chave(id));
        try {
            return { salvo: !!p.senha, estado: (p.cofre?.estado ?? (p.senha ? 'salvo' : 'vazio')) as NonNullable<PerfilTribemd['cofre']>['estado'] | 'vazio',
                ativo: p.cofre?.ativo ?? false, verificadoEm: p.cofre?.verificadoEm ?? null, codigo: p.cofre?.codigo ?? null, consentimentoEm: p.cofre?.consentimentoEm ?? null, consultasDisponiveis: null };
        } finally { p.email = ''; p.senha = ''; }
    }
    async iniciar(id: string, credencial?: { email: string; senha: string }) {
        if (!credencial) throw new ErroCofre('CREDENCIAL_AUSENTE');
        this.opcoes.aoAlterarAcesso?.(id);
        const agora = new Date().toISOString();
        await this.perfis.salvar(this.chave(id), { email: credencial.email, senha: credencial.senha,
            cofre: { ativo: false, estado: 'salvo', consentimentoEm: agora, consentimentoVersao: 'amplimed-leitura-v1', atualizadoEm: agora } });
        if (this.opcoes.verificar) void this.verificarEmSegundoPlano(id, { ...credencial });
        return this.status(id);
    }
    /** Repete a verificação com a credencial já guardada (sem pedir senha de novo). Devolve o estado, nunca a credencial. */
    async reverificar(id: string) {
        if (!this.opcoes.verificar) throw new ErroCofre('VERIFICACAO_INDISPONIVEL');
        const p = await this.perfis.ler(this.chave(id));
        if (!p.senha || !p.email) throw new ErroCofre('CREDENCIAL_AUSENTE');
        const credencial = { email: p.email, senha: p.senha };
        p.email = ''; p.senha = '';
        await this.verificarEmSegundoPlano(id, credencial);
        return this.status(id);
    }
    /** Lê a agenda de `desde` até hoje (teto 31 dias) em modo observação. Devolve só consultas já checadas; nunca a credencial. */
    async lerAgendaPeriodo(id: string, desde: string, hoje: string, comDetalhes = false) {
        if (!this.opcoes.lerEventos) return { ok: false as const, motivo: 'LEITURA_INDISPONIVEL' };
        const diasAtras = diasAtrasAmplimed(hoje, desde);
        if (diasAtras === null) return { ok: false as const, motivo: 'PERIODO_FORA_DO_LIMITE' };
        const p = await this.perfis.ler(this.chave(id));
        if (!p.senha || !p.email) return { ok: false as const, motivo: 'CREDENCIAL_AUSENTE' };
        const credencial = { email: p.email, senha: p.senha };
        p.email = ''; p.senha = '';
        let r: Awaited<ReturnType<NonNullable<typeof this.opcoes.lerEventos>>>;
        const ganchos = await this.ganchosSessao(id).catch(() => ({ estado: undefined, aoSalvarEstado: undefined, aoPedirCodigo2fa: undefined }));
        try { r = await this.tranca(id, () => this.opcoes.lerEventos!({ ...credencial, ...ganchos }, diasAtras, comDetalhes)); } catch { return { ok: false as const, motivo: 'INSTABILIDADE' }; }
        finally { credencial.email = ''; credencial.senha = ''; }
        if (r.codigo !== 'CONECTADO') return { ok: false as const, motivo: r.codigo === 'PRECISA_VERIFICACAO' || r.codigo === 'CAPTCHA' ? 'ACESSO_PRECISA_VERIFICACAO' : r.codigo === 'SENHA_RECUSADA' ? 'ACESSO_RECUSADO' : 'INSTABILIDADE' };
        if (!r.profissional) return { ok: false as const, motivo: 'PROFISSIONAL_NAO_IDENTIFICADO' };
        if (!r.completo || r.dias.length !== diasAtras + 1) return { ok: false as const, motivo: 'LEITURA_INCOMPLETA' };
        // Defesa em profundidade: o primeiro dia lido tem que ser o "hoje" pedido (a agenda pode reabrir em outra data).
        if (r.dias[0]?.data !== hoje) return { ok: false as const, motivo: 'LEITURA_INCOMPLETA' };
        const dias: { data: string; elegiveis: { paciente: string; dataHora: string; idExterno: string; valorCentavos: number; detalhe: DetalheAmplimed | null }[]; lidos: number }[] = [];
        for (const d of r.dias) {
            const leitura = montarLeituraAmplimed(d.eventos, { data: d.data, profissional: r.profissional });
            if (!leitura.confiavel) return { ok: false as const, motivo: 'LEITURA_NAO_CONFIAVEL', problemas: leitura.problemas.map(x => x.codigo), data: d.data };
            dias.push({ data: d.data, lidos: leitura.lidos, elegiveis: separarElegiveis(leitura.consultas).elegiveis.map(c => ({ paciente: c.pacienteNome, dataHora: c.dataHora, idExterno: c.idExterno, valorCentavos: c.valorCentavos ?? 0, detalhe: leitura.detalhes.get(c.idExterno) ?? null })) });
        }
        return { ok: true as const, dias };
    }
    /** Apaga a credencial e o estado do Amplimed deste médico. */
    async excluir(id: string) { this.opcoes.aoAlterarAcesso?.(id); await this.perfis.esquecer(this.chave(id)); return this.status(id); }
    private async verificarEmSegundoPlano(id: string, credencial: { email: string; senha: string }) {
        let codigo: CodigoLoginAmplimed = 'TEMPO_ESGOTADO';
        const ganchos = await this.ganchosSessao(id).catch(() => ({ estado: undefined, aoSalvarEstado: undefined, aoPedirCodigo2fa: undefined }));
        try { codigo = await this.tranca(id, () => this.opcoes.verificar!({ ...credencial, ...ganchos })); } catch { /* estado de instabilidade */ }
        finally { credencial.email = ''; credencial.senha = ''; }
        const conectado = codigo === 'CONECTADO';
        const p = await this.perfis.ler(this.chave(id));
        try {
            const agora = new Date().toISOString();
            const motivo = codigo === 'PRECISA_VERIFICACAO' || codigo === 'CAPTCHA' ? 'ACESSO_PRECISA_VERIFICACAO' : codigo === 'SENHA_RECUSADA' ? 'ACESSO_RECUSADO' : 'INSTABILIDADE';
            if (p.senha) await this.perfis.salvar(this.chave(id), { ...p, cofre: { ...(p.cofre ?? { consentimentoEm: agora, atualizadoEm: agora, ativo: false, estado: 'salvo' }),
                ativo: conectado, estado: conectado ? 'conectado' : 'atencao', verificadoEm: agora, atualizadoEm: agora, codigo: conectado ? undefined : motivo } });
        } finally { p.email = ''; p.senha = ''; }
        await this.opcoes.aoConcluir?.(id, conectado).catch(() => {});
    }
}
