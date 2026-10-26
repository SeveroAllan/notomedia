import { describe, expect, it } from 'vitest';
import { filtrarEventosPorCodigoProfissional } from '../src/desenvolvedor/amplimed-navegador.js';
import { descobrirProfissionaisDoFiltroAmplimed } from '../src/agenda/profissionais-agenda.js';

describe('filtrarEventosPorCodigoProfissional', () => {
  const ev = (codigoProfissional: string | null | undefined) => ({ texto: 't', cor: '', codigoProfissional });

  it('sem código de vínculo, devolve todos os eventos sem filtrar', () => {
    const r = filtrarEventosPorCodigoProfissional([ev('1'), ev(null)], '');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.eventos).toHaveLength(2);
  });

  it('com código, mantém só eventos do profissional vinculado', () => {
    const r = filtrarEventosPorCodigoProfissional([ev('1121812'), ev('999'), ev('1121812')], '1121812');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.eventos.map(e => e.codigoProfissional)).toEqual(['1121812', '1121812']);
  });

  it('fail-closed: evento sem código de profissional torna a leitura não identificada', () => {
    const r = filtrarEventosPorCodigoProfissional([ev('1121812'), ev(null)], '1121812');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe('PROFISSIONAL_NAO_IDENTIFICADO');
  });

  it('fail-closed: evento sem a chave também bloqueia', () => {
    const r = filtrarEventosPorCodigoProfissional([ev(undefined)], '1121812');
    expect(r.ok).toBe(false);
  });
});

describe('descobrirProfissionaisDoFiltroAmplimed', () => {
  it('deduplica por código e preserva nomes exibidos', () => {
    const r = descobrirProfissionaisDoFiltroAmplimed([
      { codigo: '1121812', nome: 'Ana Lima' },
      { codigo: '1121812', nome: 'Ana Lima' },
      { codigo: '55', nome: 'Bruno Souza' },
    ]);
    expect(r).toEqual({ tipo: 'profissionais', nomes: ['Ana Lima', 'Bruno Souza'] });
  });

  it('ignora entradas sem código ou sem nome e bloqueia quando nada legível resta', () => {
    expect(descobrirProfissionaisDoFiltroAmplimed([{ codigo: '', nome: 'Ana' }, { codigo: '1', nome: '' }]))
      .toEqual({ tipo: 'bloqueada', motivo: 'PROFISSIONAL_NAO_IDENTIFICADO' });
    expect(descobrirProfissionaisDoFiltroAmplimed([]))
      .toEqual({ tipo: 'bloqueada', motivo: 'PROFISSIONAL_NAO_IDENTIFICADO' });
  });
});
