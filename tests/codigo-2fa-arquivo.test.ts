import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pedirCodigo2faPorArquivo } from '../src/cofre/codigo-2fa-arquivo.js';

const caminhoPara = (dir: string, id: string) => join(dir, createHash('sha256').update('2fa-' + id).digest('hex').slice(0, 16) + '.txt');

describe('pedirCodigo2faPorArquivo', () => {
  it('devolve o código quando o arquivo aparece durante a espera e o apaga ao ler', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noto-2fa-'));
    const alvo = caminhoPara(dir, 'medico-1');
    setTimeout(() => void writeFile(alvo, '123456\n'), 300);
    const codigo = await pedirCodigo2faPorArquivo(dir, 'medico-1', 5000);
    expect(codigo).toBe('123456');
    await expect(readFile(alvo, 'utf8')).rejects.toThrow();
  });
  it('ignora arquivo anterior à espera (vínculo à tentativa) e desiste no prazo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noto-2fa-'));
    const alvo = caminhoPara(dir, 'medico-1');
    await writeFile(alvo, '654321');
    const antigo = new Date(Date.now() - 60_000);
    await utimes(alvo, antigo, antigo);
    expect(await pedirCodigo2faPorArquivo(dir, 'medico-1', 2500)).toBe(null);
  });
  it('descarta conteúdo fora do formato e encerra a tentativa', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noto-2fa-'));
    const alvo = caminhoPara(dir, 'medico-1');
    setTimeout(() => void writeFile(alvo, 'abcdef'), 300);
    expect(await pedirCodigo2faPorArquivo(dir, 'medico-1', 5000)).toBe(null);
  });
  it('sem arquivo dentro do prazo devolve null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noto-2fa-'));
    expect(await pedirCodigo2faPorArquivo(dir, 'medico-1', 2500)).toBe(null);
  });
});
