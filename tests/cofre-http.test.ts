import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarCofreContas } from '../src/cofre/router.js';
import { PerfisTribemd, type PerfilTribemd } from '../src/desenvolvedor/tribemd-perfil.js';

const medicoA = '11111111-1111-4111-8111-111111111111';
const contaA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const contaB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const contaNova = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
let novoMedicoId: string | null = null;
const medicoB = '22222222-2222-4222-8222-222222222222';
let servidor: Server;
let servico: ReturnType<typeof criarCofreContas>;
let diretorio: string;
let base: string;
let perfis: PerfisTribemd;
const perfil = (ativo: boolean): PerfilTribemd => ({ email: 'usuario@example.invalid', senha: 'senha-ficticia-http',
  cofre: { ativo, estado: ativo ? 'conectado' : 'desconectado', consentimentoEm: '2026-10-17T12:00:00Z', consentimentoVersao: 'tribemd-leitura-v1', atualizadoEm: '2026-10-17T12:00:00Z' } });

beforeAll(async () => {
  diretorio = await mkdtemp(join(tmpdir(), 'noto-cofre-http-')); const chave = randomBytes(32).toString('base64');
  servidor = createServer(); await new Promise<void>(resolver => servidor.listen(0, '127.0.0.1', resolver));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  const pool = { async query(_sql: string, valores: string[]) { return { rows: valores[0] === 'auth-a' ? [{ conta_id: contaA, medico_id: medicoA }] : valores[0] === 'auth-b' ? [{ conta_id: contaB, medico_id: medicoB }] : valores[0] === 'auth-novo' ? [{ conta_id: contaNova, medico_id: novoMedicoId }] : [] }; } } as unknown as pg.Pool;
  servico = criarCofreContas({ pool, autenticar: async token => ({ 'sessao-a': 'auth-a', 'sessao-b': 'auth-b', 'sessao-sem-conta': 'auth-inativo', 'sessao-nova': 'auth-novo' })[token] ?? null,
    env: { COFRE_ORIGEM: base, COFRE_DIRETORIO: diretorio, COFRE_CHAVE: chave } });
  servidor.on('request', servico.app); perfis = new PerfisTribemd(join(diretorio, 'cofres-contas-v1'), chave);
});
beforeEach(async () => { novoMedicoId=null; await perfis.esquecer('conta_'+contaNova); await perfis.salvar(medicoA, perfil(true)); await perfis.salvar(medicoB, perfil(false)); });
afterAll(async () => {
  await servico.encerrar(); await new Promise<void>((resolver, rejeitar) => servidor.close(erro => erro ? rejeitar(erro) : resolver()));
  await rm(diretorio, { recursive: true, force: true });
});

describe('cofre HTTP real com identidade e banco fake na borda', () => {
  it.each(['', 'Bearer invalido', `Bearer ${medicoA}`])('rejeita autenticação %s, sem fallback para UUID', async Authorization => {
    const resposta = await fetch(base + '/tribemd', { headers: { Authorization } });
    expect(resposta.status).toBe(401); expect(await resposta.json()).toEqual({ ok: false, codigo: 'SESSAO_INVALIDA' });
  });
  it('exige conta ativa vinculada à identidade autenticada', async () => {
    const resposta = await fetch(base + '/tribemd', { headers: { Authorization: 'Bearer sessao-sem-conta' } });
    expect(resposta.status).toBe(403); expect(await resposta.json()).toEqual({ ok: false, codigo: 'CONTA_INDISPONIVEL' });
  });
  it('consulta usa dono resolvido no servidor, ignorando outro medicoId na query', async () => {
    const resposta = await fetch(base + '/tribemd?medicoId=' + medicoB, { headers: { Authorization: 'Bearer sessao-a' } });
    expect(resposta.status).toBe(200); expect(resposta.headers.get('cache-control')).toBe('no-store');
    expect(await resposta.json()).toEqual({ ok: true, cofre: { salvo: true, estado: 'conectado', ativo: true, verificadoEm: null, codigo: null, consultasDisponiveis: null } });
  });

  it('conta com zero medicos acessa Cofre por sessão OTP, nunca pelo ID medico',async()=>{
    const resposta=await fetch(base+'/tribemd',{headers:{Authorization:'Bearer sessao-nova'}});
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ok:true,cofre:{salvo:false,estado:'vazio'}});
  });

  it('perfil da conta permanece válido após confirmação posterior de um médico',async()=>{
    const chave='conta_'+contaNova;
    await perfis.salvar(chave,perfil(true));
    const antes=await fetch(base+'/tribemd',{headers:{Authorization:'Bearer sessao-nova'}});
    expect(await antes.json()).toMatchObject({cofre:{salvo:true,estado:'conectado'}});
    // Simula efeito da confirmação posterior no SELECT de usuário: novo
    // médico existe, mas o Cofre continua sendo o da conta.
    novoMedicoId='33333333-3333-4333-8333-333333333333';
    const depois=await fetch(base+'/tribemd',{headers:{Authorization:'Bearer sessao-nova'}});
    expect(await depois.json()).toMatchObject({cofre:{salvo:true,estado:'conectado'}});
    const vizinho=await fetch(base+'/tribemd',{headers:{Authorization:'Bearer sessao-b'}});
    expect(await vizinho.json()).toMatchObject({cofre:{salvo:true,estado:'desconectado'}});
  });
  it('uma conta nova não pode ler envelopes de conta antiga ou outra conta',async()=>{
    const a=await fetch(base+'/tribemd?medicoId='+medicoA,{headers:{Authorization:'Bearer sessao-nova'}});
    expect(a.status).toBe(200);
    expect(await a.json()).toMatchObject({cofre:{salvo:false}});
    expect((await perfis.ler(medicoA)).cofre?.ativo).toBe(true);
  });
  it('não aceita mutação sem origem e cabeçalho próprios', async () => {
    const resposta = await fetch(base + '/tribemd/desconectar', { method: 'POST', headers: { Authorization: 'Bearer sessao-a', 'Content-Type': 'application/json' }, body: '{}' });
    expect(resposta.status).toBe(403); expect(await resposta.json()).toEqual({ ok: false, codigo: 'ORIGEM_INVALIDA' });
    expect((await perfis.ler(medicoA)).cofre!.ativo).toBe(true);
  });
  it('rejeita tentativa de injetar dono no corpo da operação', async () => {
    const resposta = await fetch(base + '/tribemd/desconectar', { method: 'POST', headers: { Authorization: 'Bearer sessao-a', Origin: base, 'X-Noto-Cofre': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ medicoId: medicoB }) });
    expect(resposta.status).toBe(400); expect(await resposta.json()).toEqual({ ok: false, codigo: 'ENTRADA_INVALIDA' });
    expect((await perfis.ler(medicoA)).cofre!.ativo).toBe(true);
  });
  it('exclusão autenticada remove só a credencial da própria conta', async () => {
    const resposta = await fetch(base + '/tribemd', { method: 'DELETE', headers: { Authorization: 'Bearer sessao-a', Origin: base, 'X-Noto-Cofre': '1', 'Content-Type': 'application/json' }, body: '{}' });
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ ok: true, cofre: { salvo: false, estado: 'vazio' } });
    expect(await perfis.ler(medicoA)).toEqual({}); expect(await perfis.ler(medicoB)).toEqual(perfil(false));
  });
});

it('status interno da agenda devolve só nome/conexão do dono, sem expor envelope', async () => {
  expect(await (servico as any).statusAgenda(medicoA)).toEqual({ nome: 'tribemd', conectada: true });
  expect(await (servico as any).statusAgenda(medicoB)).toEqual({ nome: 'tribemd', conectada: false });
});
it('perfil ausente não é tratado como agenda conectada', async () => {
  await perfis.esquecer(medicoA);
  expect(await (servico as any).statusAgenda(medicoA)).toEqual({ nome: null, conectada: false });
});
