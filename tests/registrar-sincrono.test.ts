import {expect,it,vi} from 'vitest';
import {registrarLinhaSincrona,registrarLinhaSincronaConsoleAviso} from '../src/observabilidade/registrar-sincrono.js';

it('escreve a linha no descritor com quebra de linha garantida', () => {
  const escritas: string[] = [];
  registrarLinhaSincrona('NOTO_ERRO {"codigo":"X"}', { escrever: (_fd, dados) => { escritas.push(String(dados)); } });
  expect(escritas).toEqual(['NOTO_ERRO {"codigo":"X"}\n']);
});

it('não duplica quebra de linha já presente', () => {
  const escritas: string[] = [];
  registrarLinhaSincrona('linha\n', { escrever: (_fd, dados) => { escritas.push(String(dados)); } });
  expect(escritas).toEqual(['linha\n']);
});

it('cai para console.error quando a escrita síncrona falha', () => {
  const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
  registrarLinhaSincrona('linha critica', { escrever: () => { throw new Error('EPIPE'); } });
  expect(erro).toHaveBeenCalledWith('linha critica');
  erro.mockRestore();
});

it('engole falha dupla (sem canal restante) sem derrubar o processo', () => {
  const erro = vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('sem canal'); });
  expect(() => registrarLinhaSincrona('x', { escrever: () => { throw new Error('EPIPE'); } })).not.toThrow();
  erro.mockRestore();
});

it('em teste sem escritor injetado usa console.error por padrão', () => {
  const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
  registrarLinhaSincrona('linha erro');
  expect(erro).toHaveBeenCalledWith('linha erro');
  erro.mockRestore();
});

it('variante de aviso usa console.warn em teste', () => {
  const aviso = vi.spyOn(console, 'warn').mockImplementation(() => {});
  registrarLinhaSincronaConsoleAviso('linha aviso');
  expect(aviso).toHaveBeenCalledWith('linha aviso');
  aviso.mockRestore();
});
