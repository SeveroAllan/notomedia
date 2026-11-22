import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
import { INSTRUCOES_NOTO } from '../src/agente/instrucoes.js';
describe('skill de agendas efetivamente consumida pela IA',()=>{
  it('carrega arquivo operacional do repositorio na mesma instrucao de runtime',()=>{
    const conteudo=readFileSync(new URL('../.agents/skills/noto-acesso-agendas/SKILL.md',import.meta.url),'utf8').trim();
    expect(INSTRUCOES_NOTO).toContain('### Skill operacional carregada — conexão e leitura de agendas');
    expect(INSTRUCOES_NOTO).toContain(conteudo);
    expect(INSTRUCOES_NOTO).toContain('## Registro');
    expect(INSTRUCOES_NOTO).toContain('Acesso salvo não é conexão ativa');
    expect(INSTRUCOES_NOTO).toContain('Uma ideia por mensagem');
    expect(INSTRUCOES_NOTO).toContain('O que ainda não existe');
    const ferramentas=readFileSync(new URL('../bloco-ferramentas.md',import.meta.url),'utf8').trim();
    expect(INSTRUCOES_NOTO).toContain(ferramentas);
    expect(INSTRUCOES_NOTO).not.toContain('https://homologacao.example.test/c/');
  });
  it('tres imagens Docker recebem a mesma skill, nao um documento isolado',()=>{
    for(const docker of ['Dockerfile','Dockerfile.homologacao','Dockerfile.piloto-agente']){
      const texto=readFileSync(new URL('../'+docker,import.meta.url),'utf8');
      expect(texto).toContain('COPY bloco-ferramentas.md ./bloco-ferramentas.md');
      expect(texto).toContain('COPY contrato-continuar-onboarding.md ./contrato-continuar-onboarding.md');
      expect(texto).toContain('COPY .agents/skills/noto-acesso-agendas/SKILL.md ./.agents/skills/noto-acesso-agendas/SKILL.md');
    }
  });
});
