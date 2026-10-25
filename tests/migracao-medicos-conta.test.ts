import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';

const sql=await readFile(new URL('../scripts/migrations/20261101-medicos-por-conta.sql',import.meta.url),'utf8');
const runner=await readFile(new URL('../scripts/migrar-medicos-por-conta.mjs',import.meta.url),'utf8');

it('migration permite médico da conta sem usuário sem remover a conta obrigatória',()=>{
  expect(sql).toMatch(/alter\s+table\s+public\.medicos[\s\S]*alter\s+column\s+usuario_id\s+drop\s+not\s+null/i);
  expect(sql).toContain("a.attname='usuario_id'");
  expect(sql).toContain("a.attname='conta_id'");
  expect(sql).toContain('a.attnotnull');
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
