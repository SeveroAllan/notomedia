import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agendaSuportada, dominioAprovado } from '../src/agenda/agendas-suportadas.js';
import { CofreAmplimed } from '../src/cofre/amplimed-cofre.js';
import { PerfisTribemd } from '../src/desenvolvedor/tribemd-perfil.js';
import { normalizarAgenda } from '../src/onboarding/conversador-medico.js';

const chave = Buffer.alloc(32, 7).toString('base64');
const id = '11111111-1111-4111-8111-111111111111';

describe('Amplimed como agenda suportada', () => {
  it('reconhece Amplimed e TribeMD, recusa o resto', () => {
    expect(agendaSuportada('amplimed')).toBe('amplimed'); expect(agendaSuportada('tribemd')).toBe('tribemd');
    expect(agendaSuportada('feegow')).toBeNull(); expect(agendaSuportada('__proto__')).toBeNull();
    expect(normalizarAgenda('uso o Amplimed')).toBe('amplimed'); expect(normalizarAgenda('o tribe')).toBe('tribemd');
  });
  it('só domínios aprovados, em HTTPS', () => {
    expect(dominioAprovado('amplimed', 'https://app.amplimed.com.br/agenda')).toBe(true);
    expect(dominioAprovado('amplimed', 'http://app.amplimed.com.br/')).toBe(false);
    expect(dominioAprovado('amplimed', 'https://amplimed.com.br.evil.com/')).toBe(false);
    expect(dominioAprovado('amplimed', 'https://app.tribemd.com/')).toBe(false);
  });
  it('credencial do Amplimed fica separada da do TribeMD e não aparece em claro', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cofre-'));
    const amp = new CofreAmplimed({ diretorio: dir, chave });
    expect((await amp.status(id)).estado).toBe('vazio');
    const r = await amp.iniciar(id, { email: 'teste@exemplo.com', senha: 'segredo-123' });
    expect(r.estado).toBe('salvo'); expect(r.ativo).toBe(false);
    const tribe = new PerfisTribemd(dir, chave);
    expect(await tribe.ler(id)).toEqual({});
    for (const f of await readdir(dir)) expect(await readFile(join(dir, f), 'utf8')).not.toMatch(/segredo-123|teste@exemplo/);
    await expect(amp.iniciar(id)).rejects.toMatchObject({ codigo: 'CREDENCIAL_AUSENTE' });
  });
});

describe('verificação em segundo plano do Amplimed', () => {
  it.each([['CONECTADO', true, 'conectado'], ['SENHA_RECUSADA', false, 'atencao'], ['PRECISA_VERIFICACAO', false, 'atencao']] as const)('%s', async (codigo, conectado, estado) => {
    const dir = await mkdtemp(join(tmpdir(), 'cofre-'));
    let concluiu: boolean | undefined;
    const fim = new Promise<void>(r => { /* resolvido no aoConcluir */ (globalThis as any).__r = r; });
    const amp = new CofreAmplimed({ diretorio: dir, chave, verificar: async () => codigo, aoConcluir: async (_m, c) => { concluiu = c; (globalThis as any).__r(); } });
    await amp.iniciar(id, { email: 'a@b.com', senha: 'x' });
    await fim;
    const st = await amp.status(id);
    expect(concluiu).toBe(conectado); expect(st.estado).toBe(estado); expect(st.ativo).toBe(conectado);
    if (codigo === 'PRECISA_VERIFICACAO') expect(st.codigo).toBe('ACESSO_PRECISA_VERIFICACAO');
  });
});

it('reverificar usa a credencial guardada e não a devolve', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cofre-'));
  let recebido = '';
  const amp = new CofreAmplimed({ diretorio: dir, chave, verificar: async c => { recebido = c.email; return 'CONECTADO'; } });
  await expect(amp.reverificar(id)).rejects.toMatchObject({ codigo: 'CREDENCIAL_AUSENTE' });
  const sem = new CofreAmplimed({ diretorio: dir, chave });
  await sem.iniciar(id, { email: 'a@b.com', senha: 'x' });
  const r = await amp.reverificar(id);
  expect(recebido).toBe('a@b.com'); expect(r.estado).toBe('conectado'); expect(JSON.stringify(r)).not.toMatch(/a@b|"x"/);
});

it('serializa tentativas de acesso do mesmo médico (um desafio 2FA por vez)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cofre-'));
  let ativas = 0, pico = 0;
  const amp = new CofreAmplimed({ diretorio: dir, chave, verificar: async () => { ativas++; pico = Math.max(pico, ativas); await new Promise(r => setTimeout(r, 30)); ativas--; return 'CONECTADO'; } });
  await amp.iniciar(id, { email: 'a@b.com', senha: 'x' });
  await Promise.all([amp.reverificar(id), amp.reverificar(id), amp.reverificar(id)]);
  expect(pico).toBe(1);
});
