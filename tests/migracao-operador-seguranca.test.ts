import {readFile} from 'node:fs/promises';
import {describe,expect,it} from 'vitest';

const sql=await readFile(new URL('../scripts/migrations/20261025-operador-foco.sql',import.meta.url),'utf8');

describe('migration operador-foco protege tabelas internas no Supabase',()=>{
  const tabelas=['secretarias','secretaria_medico','noto_operador_foco'] as const;

  it('habilita RLS nas três tabelas internas',()=>{
    for(const tabela of tabelas)
      expect(sql).toContain(`alter table public.${tabela} enable row level security;`);
    expect(sql).not.toMatch(/force\s+row\s+level\s+security/i);
  });

  it('remove explicitamente todo acesso de anon e authenticated',()=>{
    expect(sql).toMatch(/revoke\s+all\s+on\s+table[\s\S]*public\.secretarias,[\s\S]*public\.secretaria_medico,[\s\S]*public\.noto_operador_foco[\s\S]*from\s+anon,\s*authenticated;/i);
    expect(sql).not.toMatch(/grant[\s\S]{0,120}\b(?:anon|authenticated)\b/i);
  });

  it('valida privilégios efetivos antes do commit',()=>{
    expect(sql).toContain("if to_regrole(papel) is null then");
    expect(sql).toContain("has_table_privilege(papel, format('public.%I', tabela), 'SELECT')");
    for(const privilegio of ['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
      expect(sql).toContain(`has_table_privilege(papel, format('public.%I', tabela), '${privilegio}')`);
    expect(sql).toContain("c.relrowsecurity");
    expect(sql.indexOf('do $$')).toBeLessThan(sql.lastIndexOf('commit;'));
  });

  it('não revoga o caminho privilegiado do backend',()=>{
    const revoke=sql.match(/revoke\s+all\s+on\s+table[\s\S]*?from\s+([^;]+);/i)?.[1]??'';
    expect(revoke).toMatch(/anon/);
    expect(revoke).toMatch(/authenticated/);
    expect(revoke).not.toMatch(/service_role|postgres/i);
  });
});
