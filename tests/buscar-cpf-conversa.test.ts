import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buscarCpfConversa } from '../src/permissoes/buscar-cpf-conversa.js';

// CPFs válidos de teste (dígitos verificadores corretos)
const CPF_A = '52998224725';
const CPF_B = '11144477735';

function poolFalso(conversas: number, mensagens: string[]): pg.Pool {
    let chamada = 0;
    return { query: async () => {
        chamada++;
        if (chamada === 1) return { rows: Array.from({ length: conversas }, (_, i) => ({ id: `conv-${i}` })) };
        return { rows: mensagens.map(conteudo => ({ conteudo })) };
    } } as unknown as pg.Pool;
}

describe('buscarCpfConversa', () => {
    it('sem conversa vinculada ao paciente: sem_conversa, sem ler mensagens', async () => {
        expect(await buscarCpfConversa(poolFalso(0, []), 'm1', 'p1')).toEqual({ tipo: 'sem_conversa' });
    });
    it('conversa sem CPF válido: sem_cpf (máscara [OCULTO] e lixo não casam)', async () => {
        const r = await buscarCpfConversa(poolFalso(1, ['meu cpf é [OCULTO]', '12345678900 não é válido', 'oi']), 'm1', 'p1');
        expect(r).toEqual({ tipo: 'sem_cpf' });
    });
    it('um único CPF válido distinto, mesmo repetido e formatado: candidato', async () => {
        const r = await buscarCpfConversa(poolFalso(1, ['segue 529.982.247-25', 'é isso, 52998224725']), 'm1', 'p1');
        expect(r).toEqual({ tipo: 'cpf', cpf: CPF_A });
    });
    it('dois CPFs válidos distintos: ambíguo, nunca chuta', async () => {
        const r = await buscarCpfConversa(poolFalso(1, [`o meu é ${CPF_A}`, `o da minha mãe é ${CPF_B}`]), 'm1', 'p1');
        expect(r).toEqual({ tipo: 'ambiguos' });
    });
});
