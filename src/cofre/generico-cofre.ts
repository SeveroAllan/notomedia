/**
 * Cofre criptografado AES-256-GCM para agendas pré-definidas adaptativas e
 * agendas personalizadas descobertas online. Guarda credenciais, URL aprovada
 * e estado do navegador por conta, validando o login com o subagente genérico.
 */

import {
  AGENDAS_SUPORTADAS,
  type AgendaSuportada,
  type DefinicaoAgendaSuportada
} from '../agenda/agendas-suportadas.js';
import { PerfisTribemd, type EstadoNavegador, type PerfilTribemd } from '../desenvolvedor/tribemd-perfil.js';
import type { CodigoLoginPortalGenerico } from '../desenvolvedor/portal-generico-navegador.js';
import { ErroCofre } from './tribemd-cofre.js';

export interface CredencialAgendaGenerica {
  email: string;
  senha: string;
  provedor: AgendaSuportada;
  nomeAgenda?: string;
  urlPortal?: string;
}

export interface StatusAgendaGenerica {
  salvo: boolean;
  estado: NonNullable<PerfilTribemd['cofre']>['estado'] | 'vazio';
  ativo: boolean;
  provedor: AgendaSuportada | null;
  nomeAgenda: string | null;
  urlPortal: string | null;
  verificadoEm: string | null;
  codigo: string | null;
  consentimentoEm: string | null;
}

export class CofreAgendaGenerico {
  private perfis: PerfisTribemd;
  private trancas = new Map<string, Promise<unknown>>();

  constructor(private opcoes: {
    diretorio: string;
    chave: string;
    verificar?: (entrada: {
      provedor: AgendaSuportada;
      urlPortal?: string;
      email: string;
      senha: string;
      estado?: EstadoNavegador;
      aoSalvarEstado?: (estado: EstadoNavegador) => Promise<void>;
    }) => Promise<{ codigo: CodigoLoginPortalGenerico }>;
    aoConcluir?: (id: string, conectado: boolean, info: { provedor: AgendaSuportada; nomeAgenda: string }) => Promise<void>;
  }) {
    this.perfis = new PerfisTribemd(opcoes.diretorio, opcoes.chave);
  }

  private chave(id: string): string {
    return `generico-${id}`;
  }

  private tranca<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const anterior = this.trancas.get(id) ?? Promise.resolve();
    const atual = anterior.catch(() => {}).then(fn);
    this.trancas.set(id, atual);
    void atual.finally(() => { if (this.trancas.get(id) === atual) this.trancas.delete(id); });
    return atual;
  }

  async status(id: string): Promise<StatusAgendaGenerica> {
    const p = await this.perfis.ler(this.chave(id));
    try {
      const prov = (p.provedor && Object.hasOwn(AGENDAS_SUPORTADAS, p.provedor)
        ? p.provedor
        : null) as AgendaSuportada | null;
      return {
        salvo: Boolean(p.senha),
        estado: (p.cofre?.estado ?? (p.senha ? 'salvo' : 'vazio')) as StatusAgendaGenerica['estado'],
        ativo: p.cofre?.ativo ?? false,
        provedor: prov,
        nomeAgenda: p.nomeAgenda ?? (prov ? AGENDAS_SUPORTADAS[prov].nome : null),
        urlPortal: p.urlPortal ?? null,
        verificadoEm: p.cofre?.verificadoEm ?? null,
        codigo: p.cofre?.codigo ?? null,
        consentimentoEm: p.cofre?.consentimentoEm ?? null
      };
    } finally {
      p.email = '';
      p.senha = '';
    }
  }

  async iniciar(id: string, credencial: CredencialAgendaGenerica): Promise<StatusAgendaGenerica> {
    if (!credencial.email || !credencial.senha) throw new ErroCofre('CREDENCIAL_AUSENTE');
    const cfg = AGENDAS_SUPORTADAS[credencial.provedor] as DefinicaoAgendaSuportada;
    const nomeAgenda = credencial.nomeAgenda?.trim() || cfg.nome;
    const urlPortal = credencial.urlPortal?.trim() || cfg.urlLoginPadrao;
    const agora = new Date().toISOString();

    await this.perfis.salvar(this.chave(id), {
      email: credencial.email,
      senha: credencial.senha,
      provedor: credencial.provedor,
      nomeAgenda,
      urlPortal,
      cofre: {
        ativo: false,
        estado: 'salvo',
        consentimentoEm: agora,
        consentimentoVersao: cfg.consentimento,
        atualizadoEm: agora
      }
    });

    if (this.opcoes.verificar) {
      void this.verificarEmSegundoPlano(id, {
        provedor: credencial.provedor,
        nomeAgenda,
        urlPortal,
        email: credencial.email,
        senha: credencial.senha
      });
    }
    return this.status(id);
  }

  private async verificarEmSegundoPlano(
    id: string,
    entrada: { provedor: AgendaSuportada; nomeAgenda: string; urlPortal: string; email: string; senha: string }
  ): Promise<void> {
    let codigo: CodigoLoginPortalGenerico = 'TEMPO_ESGOTADO';
    const salvo = await this.perfis.ler(this.chave(id)).catch(() => ({} as PerfilTribemd));
    const estadoInicial = salvo.estado;
    salvo.email = '';
    salvo.senha = '';
    try {
      const res = await this.tranca(id, () =>
        this.opcoes.verificar!({
          provedor: entrada.provedor,
          urlPortal: entrada.urlPortal,
          email: entrada.email,
          senha: entrada.senha,
          estado: estadoInicial,
          aoSalvarEstado: async novoEstado => {
            const atual = await this.perfis.ler(this.chave(id));
            try {
              if (atual.senha) await this.perfis.salvar(this.chave(id), { ...atual, estado: novoEstado });
            } finally {
              atual.email = '';
              atual.senha = '';
            }
          }
        })
      );
      codigo = res.codigo;
    } catch {
      codigo = 'INSTABILIDADE';
    } finally {
      entrada.email = '';
      entrada.senha = '';
    }

    const conectado = codigo === 'CONECTADO';
    const motivo =
      codigo === 'CAPTCHA' ? 'ACESSO_CAPTCHA'
        : codigo === 'PRECISA_VERIFICACAO' ? 'ACESSO_PRECISA_VERIFICACAO'
          : codigo === 'SENHA_RECUSADA' ? 'ACESSO_RECUSADO'
            : codigo === 'URL_INVALIDA' ? 'URL_INVALIDA'
              : 'INSTABILIDADE';

    const atual = await this.perfis.ler(this.chave(id));
    try {
      const agora = new Date().toISOString();
      if (atual.senha) {
        await this.perfis.salvar(this.chave(id), {
          ...atual,
          cofre: {
            ...(atual.cofre ?? { consentimentoEm: agora, atualizadoEm: agora, ativo: false, estado: 'salvo' }),
            ativo: conectado,
            estado: conectado ? 'conectado' : 'atencao',
            verificadoEm: agora,
            atualizadoEm: agora,
            codigo: conectado ? undefined : motivo
          }
        });
      }
    } finally {
      atual.email = '';
      atual.senha = '';
    }

    await this.opcoes.aoConcluir?.(id, conectado, {
      provedor: entrada.provedor,
      nomeAgenda: entrada.nomeAgenda
    }).catch(() => {});
  }
}
