import { readFileSync } from 'node:fs';

/** agent.md é a fonte de comunicação/decisão; AGENTS.md continua exclusivo para regras de código. */
const fonte = readFileSync(new URL('../../agent.md', import.meta.url), 'utf8').trim();
const mapa = readFileSync(new URL('../../onboarding-noto.md', import.meta.url), 'utf8').trim();
const skillAgenda = readFileSync(new URL('../../.agents/skills/noto-acesso-agendas/SKILL.md',import.meta.url),'utf8').trim();
const ferramentas = readFileSync(new URL('../../bloco-ferramentas.md', import.meta.url), 'utf8').trim();
export const CONTRATO_CONTINUAR_ONBOARDING = readFileSync(
  new URL('../../contrato-continuar-onboarding.md', import.meta.url), 'utf8'
).trim();

if (!skillAgenda.startsWith('# Conectar a agenda e descobrir os médicos') || !skillAgenda.includes('## Registro')) {
  throw new Error('NOTO_AGENDA_SKILL_INVALIDA');
}
if (!fonte.startsWith('# Noto — como você se comporta') ||
    !fonte.includes('## Como você decide') || !fonte.includes('## Segurança')) {
  throw new Error('NOTO_AGENT_MD_INVALIDO');
}
if (!ferramentas.startsWith('# Ferramentas') || !ferramentas.includes('## Limites')) {
  throw new Error('NOTO_BLOCO_FERRAMENTAS_INVALIDO');
}
if (!CONTRATO_CONTINUAR_ONBOARDING.startsWith('# Resposta da ferramenta continuar_onboarding') ||
    !CONTRATO_CONTINUAR_ONBOARDING.includes('## Formato')) {
  throw new Error('NOTO_CONTRATO_CONTINUAR_ONBOARDING_INVALIDO');
}

/** Restrições de capacidades são fatos do runtime, não instruções concorrentes de personalidade. */
export const INSTRUCOES_NOTO = [
  fonte,
  '',
  '### Mapa da jornada: contexto, não roteiro fixo',
  mapa,
  '',
  '### Skill operacional carregada — conexão e leitura de agendas',
  skillAgenda,
  '',
  '### Ferramentas efetivamente disponíveis neste processo',
  ferramentas,
].join('\n');
