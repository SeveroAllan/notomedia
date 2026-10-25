import {readFile} from 'node:fs/promises';
import {describe,expect,it} from 'vitest';

const migration=await readFile(
  new URL('../scripts/migrations/20261031-uso-mensal-medico-seguranca.sql',import.meta.url),
  'utf8'
);
const schema=await readFile(new URL('../schema_nf_saude.sql',import.meta.url),'utf8');
const fila=await readFile(
  new URL('../src/io/postgres/postgres-fila-repositorio.ts',import.meta.url),
  'utf8'
);
const runner=await readFile(
  new URL('../scripts/migrar-uso-mensal-medico-seguranca.mjs',import.meta.url),
  'utf8'
);

describe('migration de segurança de uso_mensal_medico',()=>{
  it('preserva o caminho real de escrita pelo trigger de notas autorizadas',()=>{
    expect(schema).toMatch(/create\s+or\s+replace\s+function\s+registrar_uso_mensal\(\)[\s\S]*insert\s+into\s+uso_mensal_medico[\s\S]*on\s+conflict[\s\S]*do\s+update/i);
    expect(schema).toMatch(/create\s+trigger\s+trg_notas_uso_mensal\s+after\s+insert\s+on\s+notas_fiscais[\s\S]*execute\s+function\s+registrar_uso_mensal\(\)/i);
    expect(fila).toMatch(/insert\s+into\s+notas_fiscais[\s\S]*'autorizada'/i);
    expect(fila).not.toMatch(/uso_mensal_medico/i);
  });

  it('habilita RLS e remove explicitamente acesso de anon/authenticated',()=>{
    expect(migration).toContain('alter table public.uso_mensal_medico enable row level security;');
    expect(migration).toMatch(/revoke\s+all\s+on\s+table\s+public\.uso_mensal_medico\s+from\s+anon,\s*authenticated;/i);
    expect(migration).not.toMatch(/grant[\s\S]{0,100}\b(?:anon|authenticated)\b/i);
    expect(migration).not.toMatch(/force\s+row\s+level\s+security/i);
  });

  it('confere privilégios efetivos do cliente antes do commit',()=>{
    for(const privilegio of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
      expect(migration).toContain(`has_table_privilege(papel, 'public.uso_mensal_medico', '${privilegio}')`);
    expect(migration).toContain("c.relrowsecurity");
    const bloco=migration.match(/do\s+(\$[a-z_]+\$)[\s\S]*?end\s*\1;/i);
    expect(bloco).not.toBeNull();
    expect(bloco?.index??Number.MAX_SAFE_INTEGER).toBeLessThan(migration.lastIndexOf('commit;'));
  });

  it('preserva o acesso necessário da role do backend sob RLS',()=>{
    for(const privilegio of ['SELECT','INSERT','UPDATE'])
      expect(migration).toContain(`has_table_privilege(current_user, 'public.uso_mensal_medico', '${privilegio}')`);
    expect(migration).toContain('c.relowner=atual.oid or atual.rolsuper or atual.rolbypassrls');
    expect(migration).not.toMatch(/revoke[\s\S]{0,100}\b(?:postgres|service_role)\b/i);
  });

  it('valida função e trigger sem recriá-los nem removê-los',()=>{
    expect(migration).toContain("to_regprocedure('public.registrar_uso_mensal()')");
    expect(migration).toContain("t.tgname='trg_notas_uso_mensal'");
    expect(migration).toContain("tabela.relname='notas_fiscais'");
    expect(migration).toContain("funcao.proname='registrar_uso_mensal'");
    expect(migration).not.toMatch(/drop\s+(?:function|trigger)/i);
    expect(migration).not.toMatch(/create\s+(?:or\s+replace\s+)?function\s+registrar_uso_mensal/i);
  });

  it('runner mantém a trava do projeto de homologação antes de abrir o pool',()=>{
    expect(runner).toContain("validarProjetoHomolog(process.env.DATABASE_URL);");
    expect(runner).toContain('20261031-uso-mensal-medico-seguranca.sql');
    expect(runner.indexOf('validarProjetoHomolog(process.env.DATABASE_URL);'))
      .toBeLessThan(runner.indexOf('new pg.Pool'));
  });
});
