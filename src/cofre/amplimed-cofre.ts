import { PerfisTribemd, type PerfilTribemd } from '../desenvolvedor/tribemd-perfil.js';
import { ErroCofre } from './tribemd-cofre.js';
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
        aoConcluir?: (medicoId: string, conectado: boolean) => Promise<void> }) {
        this.perfis = new PerfisTribemd(opcoes.diretorio, opcoes.chave);
    }
    private chave(id: string) { return 'amplimed-' + id; }
    async status(id: string) {
        const p = await this.perfis.ler(this.chave(id));
        try {
            return { salvo: !!p.senha, estado: (p.cofre?.estado ?? (p.senha ? 'salvo' : 'vazio')) as NonNullable<PerfilTribemd['cofre']>['estado'] | 'vazio',
                ativo: p.cofre?.ativo ?? false, verificadoEm: p.cofre?.verificadoEm ?? null, codigo: p.cofre?.codigo ?? null, consultasDisponiveis: null };
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
