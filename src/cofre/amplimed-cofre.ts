import { PerfisTribemd, type PerfilTribemd } from '../desenvolvedor/tribemd-perfil.js';
import { ErroCofre } from './tribemd-cofre.js';

/**
 * Cofre do Amplimed. Marco 1: guarda a credencial criptografada, separada da do TribeMD
 * (chave "amplimed-<id>"). Não faz login: a verificação em modo observação vem depois.
 */
export class CofreAmplimed {
    private perfis: PerfisTribemd;
    constructor(private opcoes: { diretorio: string; chave: string; aoAlterarAcesso?: (medicoId: string) => void }) {
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
        return this.status(id);
    }
}
