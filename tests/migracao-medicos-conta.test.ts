import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';

const sql=await readFile(new URL('../scripts/migrations/20261101-medicos-por-conta.sql',import.meta.url),'utf8');
const runner=await readFile(new URL('../scripts/migrar-medicos-por-conta.mjs',import.meta.url),'utf8');

it('migration permite médico da conta sem usuário sem remover a conta obrigatória',()=>{
  expect(sql).toMatch(/alter\s+table\s+public\.medicos[\s\S]*alter\s+column\s+usuario_id\s+drop\s+not\s+null/i);
  expect(sql).toContain("a.attname='usuario_id'");
  expect(sql).toContain("a.attname='conta_id'");
  expect(sql).toContain('a.attnotnull');
  expect(sql).toMatch(/foreign key \(usuario_id\) references public\.usuarios\(id\) on delete set null/i);
  expect(sql).toContain("con.confdeltype='n'");
});

it('migration verifica acesso necessário do backend antes do commit',()=>{
  for(const privilegio of ['SELECT','INSERT','UPDATE'])
    expect(sql).toContain(`has_table_privilege(current_user,'public.medicos','${privilegio}')`);
  const bloco=sql.match(/do\s+(\$[a-z_]+\$)[\s\S]*?end\s*\1;/i);
  expect(bloco).not.toBeNull();
  expect(bloco?.index??Number.MAX_SAFE_INTEGER).toBeLessThan(sql.lastIndexOf('commit;'));
});

it('runner usa a trava do projeto homolog antes de abrir conexão',()=>{
  expect(runner).toContain("validarProjetoHomolog(process.env.DATABASE_URL);");
  expect(runner.indexOf("validarProjetoHomolog(process.env.DATABASE_URL);")).toBeLessThan(runner.indexOf('new pg.Pool'));
  expect(runner).toContain('20261101-medicos-por-conta.sql');
});

it('visibilidade RLS de médicos segue a conta, não o papel do usuário',()=>{
  expect(sql).toMatch(/create\s+or\s+replace\s+function\s+public\.medicos_visiveis_para[\s\S]*join\s+public\.medicos\s+m\s+on\s+m\.conta_id=i\.conta_id/i);
  expect(sql).toMatch(/revoke\s+execute\s+on\s+function\s+public\.medicos_visiveis_para\(uuid\)\s+from\s+public,\s*anon/i);
  expect(sql).toMatch(/grant\s+execute[\s\S]*to\s+authenticated,\s*service_role/i);
  expect(sql).toContain('p_auth_user_id=auth.uid()');
  expect(sql).toContain('join public.contador_medico cm');
  expect(sql).toContain('join public.secretaria_medico sm');
});

it('referência de agenda é interna e protegida por RLS e revoke',()=>{
  expect(sql).toContain('create table if not exists public.noto_medico_agenda_referencias');
  expect(sql).toContain('alter table public.noto_medico_agenda_referencias enable row level security;');
  expect(sql).toMatch(/revoke\s+all\s+on\s+table\s+public\.noto_medico_agenda_referencias\s+from\s+anon,\s*authenticated/i);
  expect(sql).toContain("has_table_privilege('anon','public.noto_medico_agenda_referencias','SELECT')");
  expect(sql).toContain("has_table_privilege(current_user,'public.noto_medico_agenda_referencias','INSERT')");
});
