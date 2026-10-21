import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { FALA_PEDIDO_CONEXAO_AGENDA, FALA_SEGURANCA_LINK_AGENDA, FALA_PROTECAO_CREDENCIAL_AGENDA,
  ERRO_CONVERSA } from '../src/onboarding/falas.js';

it('as cinco falas principais não têm cópia literal fora do módulo de falas', () => {
  const raiz = fileURLToPath(new URL('../src/', import.meta.url));
  const modulo = join(raiz, 'onboarding', 'falas.ts');
  const arquivos = (diretorio: string): string[] => readdirSync(diretorio, { withFileTypes: true }).flatMap(entrada => {
    const caminho = join(diretorio, entrada.name);
    return entrada.isDirectory() ? arquivos(caminho) : caminho.endsWith('.ts') ? [caminho] : [];
  });
  const principais = { FALA_PEDIDO_CONEXAO_AGENDA, FALA_SEGURANCA_LINK_AGENDA, FALA_PROTECAO_CREDENCIAL_AGENDA,
    ERRO_CONVERSA };
  const duplicadas = arquivos(raiz).filter(caminho => caminho !== modulo).flatMap(caminho => {
    const fonte = readFileSync(caminho, 'utf8');
    return Object.entries(principais).filter(([, texto]) => fonte.includes(texto)).map(([nome]) => `${relative(raiz, caminho)}: ${nome}`);
  });
  expect(duplicadas).toEqual([]);
});
