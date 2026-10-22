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
