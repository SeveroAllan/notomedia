import { PerfisTribemd, type PerfilTribemd } from '../desenvolvedor/tribemd-perfil.js';
import { ErroCofre } from './tribemd-cofre.js';
import { diasAtrasAmplimed, montarLeituraAmplimed } from '../agenda/amplimed-leitor.js';
import { separarElegiveis } from '../agenda/leitura-adaptativa.js';
import type { CodigoLoginAmplimed } from '../desenvolvedor/amplimed-navegador.js';

/**
 * Cofre do Amplimed. Marco 1: guarda a credencial criptografada, separada da do TribeMD
 * (chave "amplimed-<id>"). Não faz login: a verificação em modo observação vem depois.
 */
export class CofreAmplimed {
    private perfis: PerfisTribemd;
    constructor(private opcoes: { diretorio: string; chave: string; aoAlterarAcesso?: (medicoId: string) => void;
        /** Login de observação; sem ele a credencial só é guardada. */
        verificar?: (credencial: { email: string; senha: string }) => Promise<CodigoLoginAmplimed>;
        aoConcluir?: (medicoId: string, conectado: boolean) => Promise<void>;
        /** Leitura de observação da agenda do dia; sem ele a leitura fica indisponível. */
        lerEventos?: (credencial: { email: string; senha: string }, diasAtras: number) => Promise<{ codigo: CodigoLoginAmplimed; dias: { data: string; eventos: { texto: string; cor: string }[] }[]; profissional: string | null; completo: boolean }> }) {
        this.perfis = new PerfisTribemd(opcoes.diretorio, opcoes.chave);
    }
    private chave(id: string) { return 'amplimed-' + id; }
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
    async lerAgendaPeriodo(id: string, desde: string, hoje: string) {
        if (!this.opcoes.lerEventos) return { ok: false as const, motivo: 'LEITURA_INDISPONIVEL' };
        const diasAtras = diasAtrasAmplimed(hoje, desde);
        if (diasAtras === null) return { ok: false as const, motivo: 'PERIODO_FORA_DO_LIMITE' };
        const p = await this.perfis.ler(this.chave(id));
        if (!p.senha || !p.email) return { ok: false as const, motivo: 'CREDENCIAL_AUSENTE' };
        const credencial = { email: p.email, senha: p.senha };
        p.email = ''; p.senha = '';
        let r: Awaited<ReturnType<NonNullable<typeof this.opcoes.lerEventos>>>;
        try { r = await this.opcoes.lerEventos(credencial, diasAtras); } catch { return { ok: false as const, motivo: 'INSTABILIDADE' }; }
        finally { credencial.email = ''; credencial.senha = ''; }
        if (r.codigo !== 'CONECTADO') return { ok: false as const, motivo: r.codigo === 'PRECISA_VERIFICACAO' || r.codigo === 'CAPTCHA' ? 'ACESSO_PRECISA_VERIFICACAO' : r.codigo === 'SENHA_RECUSADA' ? 'ACESSO_RECUSADO' : 'INSTABILIDADE' };
        if (!r.profissional) return { ok: false as const, motivo: 'PROFISSIONAL_NAO_IDENTIFICADO' };
        if (!r.completo || r.dias.length !== diasAtras + 1) return { ok: false as const, motivo: 'LEITURA_INCOMPLETA' };
        const dias: { data: string; elegiveis: { paciente: string; dataHora: string }[]; lidos: number }[] = [];
        for (const d of r.dias) {
            const leitura = montarLeituraAmplimed(d.eventos, { data: d.data, profissional: r.profissional });
            if (!leitura.confiavel) return { ok: false as const, motivo: 'LEITURA_NAO_CONFIAVEL', problemas: leitura.problemas.map(x => x.codigo), data: d.data };
            dias.push({ data: d.data, lidos: leitura.lidos, elegiveis: separarElegiveis(leitura.consultas).elegiveis.map(c => ({ paciente: c.pacienteNome, dataHora: c.dataHora })) });
        }
        return { ok: true as const, dias };
    }
    /** Apaga a credencial e o estado do Amplimed deste médico. */
    async excluir(id: string) { this.opcoes.aoAlterarAcesso?.(id); await this.perfis.esquecer(this.chave(id)); return this.status(id); }
    private async verificarEmSegundoPlano(id: string, credencial: { email: string; senha: string }) {
        let codigo: CodigoLoginAmplimed = 'TEMPO_ESGOTADO';
        try { codigo = await this.opcoes.verificar!(credencial); } catch { /* estado de instabilidade */ }
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
