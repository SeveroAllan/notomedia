import { readFileSync } from 'node:fs';

/** agent.md é a fonte de comunicação/decisão; AGENTS.md continua exclusivo para regras de código. */
const fonte = readFileSync(new URL('../../agent.md', import.meta.url), 'utf8').trim();
const vozHumana = readFileSync(new URL('../../voz-humana-whatsapp.md', import.meta.url), 'utf8').trim();
const experienciaProfissional = readFileSync(new URL('../../experiencia-profissional-noto.md', import.meta.url), 'utf8').trim();
const mapa = readFileSync(new URL('../../onboarding-noto.md', import.meta.url), 'utf8').trim();
const funcionamento = readFileSync(new URL('../../como-noto-funciona.md', import.meta.url), 'utf8').trim();
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
if (!funcionamento.startsWith('# Como o Noto funciona por dentro')) {
  throw new Error('NOTO_FUNCIONAMENTO_MD_INVALIDO');
}
if (!vozHumana.startsWith('# Voz Humana no WhatsApp')) {
  throw new Error('NOTO_VOZ_HUMANA_MD_INVALIDA');
}
if (!experienciaProfissional.startsWith('# 30 Anos de Experiência')) {
  throw new Error('NOTO_EXPERIENCIA_PROFISSIONAL_MD_INVALIDA');
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
  '### Naturalidade e proatividade no WhatsApp (perfil PT-BR)',
  vozHumana,
  '',
  '### Bagagem profissional e postura de especialista sênior',
  experienciaProfissional,
  '',
  '### Como o Noto funciona na prática (use para tirar dúvidas e antecipar contexto ao médico)',
  funcionamento,
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
