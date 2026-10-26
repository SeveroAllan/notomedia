import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';

const origem=await readFile(new URL('../scripts/migrations/20261102-origem-operador-conta.sql',import.meta.url),'utf8');
const memoria=await readFile(new URL('../scripts/migrations/20261103-memoria-conta-e-visibilidade.sql',import.meta.url),'utf8');
const runner=await readFile(new URL('../scripts/migrar-compatibilidade-conta.mjs',import.meta.url),'utf8');

it('migration específica amplia origem_operador no banco já migrado',()=>{
  expect(origem).toContain("add column if not exists origem_operador text");
  expect(origem).toContain("pg_get_constraintdef(con.oid) ilike '%origem_operador%'");
  expect(origem).toMatch(/drop constraint %I/);
  expect(origem).toContain("origem_operador in ('medico','secretaria','conta')");
  expect(origem).toContain("conversa_mensagens_origem_operador_check");
});

it('memória durável separa escopo médico e conta com unicidade própria',()=>{
  expect(memoria).toContain("add column if not exists escopo text");
  expect(memoria).toContain("add column if not exists conta_id uuid");
  expect(memoria).toContain("where escopo='medico'");
  expect(memoria).toContain("on public.conversa_memorias_semanticas (conta_id,chave)");
  expect(memoria).toContain("where escopo='conta'");
  expect(memoria).toContain("alter column conta_id set not null");
});

it('visibilidade preserva conta e delegações explícitas cross-account',()=>{
  expect(memoria).toMatch(/join public\.medicos m on m\.conta_id=i\.conta_id/);
  expect(memoria).toContain('join public.secretaria_medico sm');
  expect(memoria).toContain('join public.contador_medico cm');
});

it('função recusa identidade arbitrária e não fica disponível ao anon',()=>{
  expect(memoria).toContain('p_auth_user_id=auth.uid()');
  expect(memoria).toMatch(/revoke execute on function public\.medicos_visiveis_para\(uuid\) from public, anon/i);
  expect(memoria).toMatch(/grant execute on function public\.medicos_visiveis_para\(uuid\) to authenticated, service_role/i);
});

it('runner protegido aplica as duas correções em ordem',()=>{
  expect(runner).toContain("validarProjetoHomolog(process.env.DATABASE_URL);");
  expect(runner.indexOf("validarProjetoHomolog(process.env.DATABASE_URL);")).toBeLessThan(runner.indexOf('new pg.Pool'));
  const pre=runner.indexOf('20261031-contadores-delegacoes.sql');
  const a=runner.indexOf('20261102-origem-operador-conta.sql');
  const b=runner.indexOf('20261103-memoria-conta-e-visibilidade.sql');
  expect(pre).toBeGreaterThan(0);
  expect(a).toBeGreaterThan(pre);
  expect(b).toBeGreaterThan(a);
});
