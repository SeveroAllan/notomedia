import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { consultarStatusAgendasInterno } from '../src/cofre/status-interno.js';
import { criarCofreContas } from '../src/cofre/router.js';
import { PerfisTribemd } from '../src/desenvolvedor/tribemd-perfil.js';

describe('status interno do Cofre separado dos links e URLs públicas', () => {
  const recursos: Array<{ pasta: string; encerrar: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const r of recursos.splice(0)) {
      await r.encerrar();
      await rm(r.pasta, { recursive: true, force: true });
    }
  });

  it('lê o estado criptografado sem COFRE_ORIGEM e sem criar links', async () => {
    const pasta = await mkdtemp(join(tmpdir(), 'noto-status-interno-'));
    const chave = randomBytes(32).toString('base64');
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as pg.Pool;
    const enviarCofre = vi.fn();
    const servico = criarCofreContas({
      pool, autenticar: async () => null, enviarCofre,
      env: { COFRE_DIRETORIO: pasta, COFRE_CHAVE: chave }
    });
    recursos.push({ pasta, encerrar: servico.encerrar });
    const perfis = new PerfisTribemd(join(pasta, 'cofres-contas-v1'), chave);
    await perfis.salvar('medico-teste', {
      email: 'teste@example.invalid', senha: 'segredo-que-nao-pode-ser-exposto',
      cofre: { ativo: true, estado: 'conectado', consentimentoEm: '2026-10-10T10:00:00Z',
        consentimentoVersao: 'tribemd-leitura-v1', atualizadoEm: '2026-10-10T10:00:00Z' }
    });
    const status = await servico.statusAgendas('medico-teste');
    expect(status.tribemd).toMatchObject({ salvo: true, conectada: true });
    expect(status.amplimed).toMatchObject({ salvo: false, conectada: false });
    expect(servico.links).toBeUndefined();
    expect(enviarCofre).not.toHaveBeenCalled();
    expect(JSON.stringify(status)).not.toContain('segredo-que-nao-pode-ser-exposto');
  });

  it('falha em TribeMD não se disfarça de desconexão nem impede status Amplimed', async () => {
    const resultado = await consultarStatusAgendasInterno({
      medicoId: 'a',
      resolver: async (_, agenda) => agenda + '-a',
      cofreTribemd: {
        status: vi.fn().mockRejectedValue(new Error('segredo de teste')),
        consentimentoEm: vi.fn().mockResolvedValue(null)
      },
      cofreAmplimed: {
        status: vi.fn().mockResolvedValue({
          salvo: true, ativo: true, estado: 'conectado', consentimentoEm: null,
          verificadoEm: null, codigo: null, consultasDisponiveis: null
        })
      }
    });
    expect(resultado.tribemd).toMatchObject({ indisponivel: true });
    expect(resultado.amplimed).toMatchObject({ salvo: true, conectada: true });
    expect(JSON.stringify(resultado)).not.toContain('segredo de teste');
  });
});
