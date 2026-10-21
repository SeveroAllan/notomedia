import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CofreTribemd, consentimentoCofre } from '../src/cofre/tribemd-cofre.js';
import { PerfisTribemd, type PerfilTribemd } from '../src/desenvolvedor/tribemd-perfil.js';
import { NavegadorTribemd, ErroTribemd, type ResultadoLeituraTribemd } from '../src/desenvolvedor/tribemd-navegador.js';

let diretorio: string;
let cofre: CofreTribemd;
let perfis: PerfisTribemd;
const invalidarFrescor = vi.fn();
const credencial = { email: 'clinica@example.invalid', senha: 'senha-ficticia-de-conexao' };
const estado = { cookies: [], origins: [{ origin: 'https://app.tribemd.com', localStorage: [{ name: 'bipp-user-token', value: 'cookie-ficticio' }] }] };
const resultado: ResultadoLeituraTribemd = { consultas: [], cobertura: 'somente_linhas_visiveis', pagina: 'agenda', historicoCompleto: false, detalhe: 'Agenda fictícia vazia' };
const perfilSalvo = (): PerfilTribemd => ({ ...credencial, estado, cofre: { ativo: true, estado: 'conectado', consentimentoEm: '2026-10-17T12:00:00Z', consentimentoVersao: consentimentoCofre, atualizadoEm: '2026-10-17T12:00:00Z' } });

beforeEach(async () => {
  invalidarFrescor.mockClear();
  diretorio = await mkdtemp(join(tmpdir(), 'noto-cofre-conexao-')); const chave = randomBytes(32).toString('base64');
  perfis = new PerfisTribemd(diretorio, chave); cofre = new CofreTribemd({ aoAlterarAcesso: invalidarFrescor, diretorio, chave, chromium: '/nao-executar-navegador-real' });
});
afterEach(async () => { await cofre.encerrar(); vi.restoreAllMocks(); await rm(diretorio, { recursive: true, force: true }); });

// Fake somente na borda de automação do portal; criptografia e orquestração são reais.
function portalFicticio(opcoes: { expirar?: boolean; falharLeitura?: boolean; falharLogin?: boolean } = {}) {
  const logins: Array<{ email: string; senha: string }> = [];
  const criacoes: boolean[] = [];
  vi.spyOn(NavegadorTribemd, 'criar').mockImplementation(async opcoesNavegador => {
    const reutilizado = !!opcoesNavegador.estado; criacoes.push(reutilizado); let autenticado = reutilizado;
    return {
      async abrir() { return reutilizado ? 'perfil_reutilizado' : 'aguardando_credenciais'; },
      async entrar(email: string, senha: string) { logins.push({ email, senha }); if (opcoes.falharLogin) throw new ErroTribemd('LOGIN_NAO_CONFIRMADO'); autenticado = true; },
      async ler() {
        if (opcoes.expirar && reutilizado) { autenticado = false; throw new ErroTribemd('SESSAO_EXPIRADA'); }
        if (opcoes.falharLeitura) throw new ErroTribemd('LEITURA_LAYOUT_NAO_RECONHECIDO');
        return resultado;
      },
      async perfil() { return estado; }, estaAutenticado() { return autenticado; }, async encerrar() { autenticado = false; }
    } as unknown as NavegadorTribemd;
  });
  return { logins, criacoes };
}

describe('cofre real por conta, portal substituído na borda', () => {
  it('salva consentimento e credenciais criptografadas; status não expõe segredos', async () => {
    const portal = portalFicticio(); const logs: unknown[] = [];
    for (const metodo of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, metodo).mockImplementation((...args) => { logs.push(args); });
    expect(await cofre.iniciar('conta-a', { ...credencial })).toMatchObject({ salvo: true, ativo: true, estado: 'conectando' });
    await vi.waitFor(async () => expect((await cofre.status('conta-a')).estado).toBe('conectado'));
    const salvo = await perfis.ler('conta-a');
    expect(salvo).toMatchObject({ ...credencial, estado, cofre: { consentimentoVersao: consentimentoCofre, ativo: true } });
    expect(Number.isFinite(Date.parse(salvo.cofre!.consentimentoEm))).toBe(true);
    expect(portal.logins).toEqual([credencial]); expect(cofre.resultado('conta-a')).toEqual(resultado); expect(cofre.resultado('conta-b')).toBeNull();
    expect(Object.keys(await cofre.status('conta-a')).sort()).toEqual(['ativo', 'codigo', 'consultasDisponiveis', 'estado', 'salvo', 'verificadoEm']);
    expect(logs).toEqual([]);
  });

  it('reutiliza cookies válidos sem novo envio da senha', async () => {
    await perfis.salvar('conta-a', perfilSalvo()); const portal = portalFicticio();
    await cofre.consultar('conta-a');
    await vi.waitFor(async () => expect((await cofre.status('conta-a')).estado).toBe('conectado'));
    expect(portal.criacoes).toEqual([true]); expect(portal.logins).toEqual([]);
  });

  it('reconecta sessão expirada uma vez com a credencial da própria conta', async () => {
    await perfis.salvar('conta-a', perfilSalvo()); const portal = portalFicticio({ expirar: true });
    await cofre.consultar('conta-a');
    await vi.waitFor(async () => expect((await cofre.status('conta-a')).estado).toBe('conectado'));
    expect(portal.criacoes).toEqual([true, false]); expect(portal.logins).toEqual([credencial]);
    expect(cofre.resultado('conta-a')).toEqual(resultado);
  });

  it('preserva login bem-sucedido quando a leitura da agenda falha', async () => {
    portalFicticio({ falharLeitura: true }); await cofre.iniciar('conta-a', { ...credencial });
    await vi.waitFor(async () => expect(await cofre.status('conta-a')).toMatchObject({ estado: 'conectado', codigo: 'LEITURA_NAO_CONCLUIDA' }));
    expect((await perfis.ler('conta-a')).estado).toEqual(estado); expect(cofre.resultado('conta-a')).toBeNull();
  });

  it('login não confirmado exige atenção e não publica dados do paciente', async () => {
    portalFicticio({ falharLogin: true }); await cofre.iniciar('conta-a', { ...credencial });
    await vi.waitFor(async () => expect(await cofre.status('conta-a')).toMatchObject({ estado: 'atencao', codigo: 'ACESSO_PRECISA_VERIFICACAO' }));
    expect(cofre.resultado('conta-a')).toBeNull();
  });

  it('desconectar apaga sessão, mantém credencial, bloqueia leitura; excluir afeta só a conta', async () => {
    await perfis.salvar('conta-a', perfilSalvo()); await perfis.salvar('conta-b', perfilSalvo());
    await cofre.desconectar('conta-a');
    expect(await perfis.ler('conta-a')).toMatchObject({ ...credencial, cofre: { ativo: false, estado: 'desconectado' } });
    expect((await perfis.ler('conta-a')).estado).toBeUndefined();
    await expect(cofre.consultar('conta-a')).rejects.toMatchObject({ codigo: 'COFRE_DESCONECTADO' });
    await cofre.excluir('conta-a');
    expect(await cofre.status('conta-a')).toMatchObject({ salvo: false, ativo: false, estado: 'vazio' });
    expect(await perfis.ler('conta-b')).toEqual(perfilSalvo());
  });

  it('não reconecta sem consentimento da versão atual', async () => {
    const salvo = perfilSalvo(); salvo.cofre!.consentimentoVersao = 'versao-antiga'; await perfis.salvar('conta-a', salvo);
    await expect(cofre.iniciar('conta-a')).rejects.toMatchObject({ codigo: 'CONSENTIMENTO_NECESSARIO' });
  });

  it('desconectar cancela trabalho em curso; uma conta não pode ter dois trabalhos', async () => {
    let avisar!: () => void; const lendo = new Promise<void>(resolver => { avisar = resolver; }); let fechado = false;
    vi.spyOn(NavegadorTribemd, 'criar').mockImplementation(async (_opcoes, sinal) => ({
      async abrir() { return 'aguardando_credenciais'; }, async entrar() {},
      async ler() { avisar(); return new Promise((_resolver, rejeitar) => sinal.addEventListener('abort', () => rejeitar(new Error('CANCELADO')), { once: true })); },
      async encerrar() { fechado = true; }, estaAutenticado() { return true; }
    } as unknown as NavegadorTribemd));
    await cofre.iniciar('conta-a', { ...credencial }); await lendo;
    await expect(cofre.iniciar('conta-a')).rejects.toMatchObject({ codigo: 'COFRE_OCUPADO' });
    await cofre.desconectar('conta-a');
    expect(fechado).toBe(true); expect(await cofre.status('conta-a')).toMatchObject({ estado: 'desconectado', ativo: false });
    expect(cofre.resultado('conta-a')).toBeNull();
  });
});

it('invalida frescor ao salvar outro acesso, reconectar e desconectar, sem invalidar leitura comum',async()=>{
 portalFicticio();await perfis.salvar('conta-a',perfilSalvo());
 await cofre.consultar('conta-a');await vi.waitFor(async()=>expect((await cofre.status('conta-a')).estado).toBe('conectado'));
 expect(invalidarFrescor).not.toHaveBeenCalled();
 await cofre.iniciar('conta-a',{...credencial});await vi.waitFor(async()=>expect((await cofre.status('conta-a')).estado).toBe('conectado'));
 expect(invalidarFrescor).toHaveBeenCalledExactlyOnceWith('conta-a');
 await cofre.iniciar('conta-a');await vi.waitFor(async()=>expect((await cofre.status('conta-a')).estado).toBe('conectado'));
 expect(invalidarFrescor).toHaveBeenCalledTimes(2);
 await cofre.desconectar('conta-a');expect(invalidarFrescor).toHaveBeenCalledTimes(3);
});
