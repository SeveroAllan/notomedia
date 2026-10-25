import {describe,expect,it} from 'vitest';
import {NOTO_HOMOLOG_PROJECT_REF,extrairProjectRefSupabase,validarProjetoHomolog} from '../scripts/validar-projeto-homolog.mjs';

describe('trava de projeto das migrations do PR #10',()=>{
  it('aceita URL direta somente do noto-homolog',()=>{
    const url=`postgresql://postgres:senha@db.${NOTO_HOMOLOG_PROJECT_REF}.supabase.co:5432/postgres`;
    expect(extrairProjectRefSupabase(url)).toBe(NOTO_HOMOLOG_PROJECT_REF);
    expect(validarProjetoHomolog(url)).toBe(NOTO_HOMOLOG_PROJECT_REF);
  });

  it('aceita pooler quando o project ref está no usuário',()=>{
    const url=`postgresql://postgres.${NOTO_HOMOLOG_PROJECT_REF}:senha@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`;
    expect(extrairProjectRefSupabase(url)).toBe(NOTO_HOMOLOG_PROJECT_REF);
    expect(validarProjetoHomolog(url)).toBe(NOTO_HOMOLOG_PROJECT_REF);
  });

  it('recusa projeto diferente mesmo com DATABASE_URL válida',()=>{
    expect(()=>validarProjetoHomolog('postgresql://postgres:senha@db.projetoerrado.supabase.co:5432/postgres'))
      .toThrow(/SUPABASE_PROJECT_REF_INCORRETO/);
  });

  it('recusa conexão não identificável mesmo com ref explícito correto',()=>{
    expect(()=>validarProjetoHomolog('postgresql://usuario:senha@proxy.interno:5432/postgres',undefined))
      .toThrow(/SUPABASE_PROJECT_REF_NAO_CONFIRMADO/);
    expect(()=>validarProjetoHomolog('postgresql://usuario:senha@proxy.interno:5432/postgres',NOTO_HOMOLOG_PROJECT_REF))
      .toThrow(/SUPABASE_PROJECT_REF_NAO_CONFIRMADO/);
  });

  it('recusa divergência entre URL e project ref explícito',()=>{
    const url=`postgresql://postgres.${NOTO_HOMOLOG_PROJECT_REF}:senha@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`;
    expect(()=>validarProjetoHomolog(url,'outroprojeto')).toThrow(/SUPABASE_PROJECT_REF_INCONSISTENTE/);
  });
});
