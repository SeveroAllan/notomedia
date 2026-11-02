import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validarCofreHomologacao } from '../src/cofre/configuracao-homologacao.js';
import { criarCofreContas } from '../src/cofre/router.js';
import { PerfisTribemd } from '../src/desenvolvedor/tribemd-perfil.js';

const recursos: Array<{ pasta: string; encerrar: () => Promise<void> }> = [];
afterEach(async () => {
  for (const r of recursos.splice(0)) {
    await r.encerrar();
    await rm(r.pasta, { recursive: true, force: true });
  }
});
const origem = 'https://homologacao.example.test';
const chave = () => randomBytes(32).toString('base64');
const configurada = (pasta: string, chaveCofre: string): NodeJS.ProcessEnv => ({
  NOTO_PILOTO_RESTRITO: 'true',
  APP_PUBLIC_ORIGIN: origem, COFRE_ORIGEM: origem,
  COFRE_DIRETORIO: pasta, COFRE_CHAVE: chaveCofre
});
const semBanco = { query: vi.fn().mockRejectedValue(new Error('sem banco neste teste')) } as unknown as pg.Pool;
const perfilTeste = {
  email: 'conta@example.invalid', senha: 'senha-nunca-no-log',
  cofre: {
    ativo: true, estado: 'conectado' as const, consentimentoEm: '2026-10-10T10:00:00Z',
    consentimentoVersao: 'tribemd-leitura-v1', atualizadoEm: '2026-10-10T10:00:00Z'
  }
};

describe('homologação tem cofre próprio, nunca recupera estado do piloto', () => {
  it('exige diretório, chave base64 de 32 bytes e origem HTTPS idêntica à pública', async () => {
    const p = await mkdtemp(join(tmpdir(), 'noto-homolog-config-'));
    recursos.push({pasta:p,encerrar:async()=>{}});
    const ok = configurada(p, chave());
    expect(validarCofreHomologacao(ok)).toBe(true);
    for(const sobrescrever of [
      { COFRE_DIRETORIO: '' }, { COFRE_CHAVE: '' }, { COFRE_ORIGEM: '' },
      { COFRE_CHAVE: Buffer.from('senha-curta').toString('base64') },
      { COFRE_ORIGEM: 'https://outro.example.test' },
      { COFRE_ORIGEM: 'http://homologacao.example.test' },
      { COFRE_DIRETORIO: '/dados/tribemd' }, { COFRE_DIRETORIO: '/dados/tribemd/perfis' },
      { COFRE_DIRETORIO: './relativo' },
      { TRIBEMD_TESTE_DIRETORIO: p },
      { TRIBEMD_TESTE_CHAVE: ok.COFRE_CHAVE }
    ]) expect(validarCofreHomologacao({...ok,...sobrescrever})).toBe(false);
  });

  it('aliases antigos isolados não habilitam a homologação e não revelam o perfil piloto', async () => {
    const antigo=await mkdtemp(join(tmpdir(),'noto-piloto-antigo-'));
    const chaveAntiga=chave();
    const perfis=new PerfisTribemd(join(antigo,'cofres-contas-v1'),chaveAntiga);
    await perfis.salvar('conta-exemplo',perfilTeste);
    const servico=criarCofreContas({
      pool:semBanco,autenticar:async()=>null,enviarCofre:vi.fn(),
      env:{NOTO_PILOTO_RESTRITO:'true',APP_PUBLIC_ORIGIN:origem,TRIBEMD_TESTE_ORIGEM:origem,
        TRIBEMD_TESTE_DIRETORIO:antigo,TRIBEMD_TESTE_CHAVE:chaveAntiga}
    });
    recursos.push({pasta:antigo,encerrar:servico.encerrar});
    expect(servico.links).toBeUndefined();
    expect(servico.configuracaoOk).toBe(false);
    const estado=await servico.statusAgendas('conta-exemplo');
    expect(estado.tribemd).toMatchObject({indisponivel:true,motivo:'INTEGRACAO_NAO_CONFIGURADA',salvo:false});
    expect(estado.amplimed).toMatchObject({indisponivel:true,motivo:'INTEGRACAO_NAO_CONFIGURADA'});
    expect(JSON.stringify(estado)).not.toContain(perfilTeste.senha);
  });

  it('pode persistir envelope criptografado em volume novo sem compartilhar a chave antiga', async () => {
    const antigo=await mkdtemp(join(tmpdir(),'noto-piloto-vol-'));
    const novo=await mkdtemp(join(tmpdir(),'noto-homolog-vol-'));
    const antiga=chave(), nova=chave();
    await new PerfisTribemd(join(antigo,'cofres-contas-v1'),antiga).salvar('medico-teste',perfilTeste);
    const servico=criarCofreContas({
      pool:semBanco,autenticar:async()=>null,enviarCofre:vi.fn(),
      env:{...configurada(novo,nova),TRIBEMD_TESTE_DIRETORIO:antigo,TRIBEMD_TESTE_CHAVE:antiga}
    });
    recursos.push({pasta:novo,encerrar:servico.encerrar});
    recursos.push({pasta:antigo,encerrar:async()=>{}});
    expect(servico.configuracaoOk).toBe(true);
    expect(servico.links).toBeDefined();
    // Sem cópia dos envelopes: não existe acesso inicial na nova instância.
    expect((await servico.statusAgendas('medico-teste')).tribemd.salvo).toBe(false);
    const novoPerfil=new PerfisTribemd(join(novo,'cofres-contas-v1'),nova);
    await novoPerfil.salvar('medico-teste',perfilTeste);
    const estado=await servico.statusAgendas('medico-teste');
    expect(estado.tribemd).toMatchObject({salvo:true,conectada:true});
    const arquivos=await import('node:fs/promises').then(fs=>fs.readdir(join(novo,'cofres-contas-v1')));
    const bytes=await readFile(join(novo,'cofres-contas-v1',arquivos[0]!),'utf8');
    expect(bytes).not.toContain(perfilTeste.senha);
    expect(bytes).not.toContain(perfilTeste.email);
    // Simula nova publicação mantendo SOMENTE volume/chave: o status reaparece.
    const reinstalado=criarCofreContas({
      pool:semBanco,autenticar:async()=>null,enviarCofre:vi.fn(),
      env:configurada(novo,nova)
    });
    recursos.push({pasta:novo,encerrar:reinstalado.encerrar});
    expect((await reinstalado.statusAgendas('medico-teste')).tribemd.conectada).toBe(true);
    expect((await new PerfisTribemd(join(antigo,'cofres-contas-v1'),antiga).ler('medico-teste')).senha).toBe(perfilTeste.senha);
  });

  it('status com cofre existente mas falha de consulta é diferente da falta de configuração', async () => {
    const { consultarStatusAgendasInterno }=await import('../src/cofre/status-interno.js');
    const r=await consultarStatusAgendasInterno({
      medicoId:'m',resolver:async()=>{throw Error('falha no resolver');},
      cofreTribemd:{status:vi.fn(),consentimentoEm:vi.fn()}
    });
    expect(r.tribemd.motivo).toBe('FALHA_CONSULTA_INTEGRACAO');
    expect(r.amplimed.motivo).toBe('INTEGRACAO_NAO_CONFIGURADA');
  });
});
