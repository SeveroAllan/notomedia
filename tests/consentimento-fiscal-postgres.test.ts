import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { expect, it, vi } from 'vitest';
import { adotarReferenciaConsentida, registrarConsentimentoFiscal } from '../src/onboarding/fluxos/consentimento-fiscal.js';

const url=process.env['NOTO_SCHEMA_TEST_DATABASE_URL'];
it.skipIf(!url)('grava e lê o consentimento no schema fiscal vigente, restrito ao médico e certificado ativo',async()=>{
  const destino=new URL(url!);
  if(!['localhost','127.0.0.1'].includes(destino.hostname))throw Error('POSTGRES_DESCARTAVEL_EXIGIDO');
  const nome='noto_consentimento_'+randomUUID().replace(/-/g,'');
  const admin=new pg.Client({connectionString:url});
  await admin.connect();
  await admin.query('create database '+nome);
  destino.pathname='/'+nome;
  const pool=new pg.Pool({connectionString:destino.toString()});
  try {
    await pool.query(`create table contas(id uuid primary key);
      create table usuarios(id uuid primary key);
      create table medicos(id uuid primary key, conta_id uuid references contas(id));`);
    const schema=readFileSync('scripts/migrations/noto-intelligence-02-fiscal-protegido.sql','utf8');
    await pool.query(schema.slice(schema.indexOf('CREATE TABLE public.medico_certificados'),schema.indexOf('CREATE INDEX auditoria_conta')));
    const [conta,usuario,medico,certificado]=Array.from({length:4},()=>randomUUID());
    await pool.query('insert into contas values ($1)',[conta]);
    await pool.query('insert into usuarios values ($1)',[usuario]);
    await pool.query('insert into medicos values ($1,$2)',[medico,conta]);
    await pool.query(`insert into medico_certificados (id, medico_id, arquivo_storage_path, senha_secret_id, valido_de, valido_ate)
      values ($1,$2,'sintetico',$3,current_date-1,current_date+1)`,[certificado,medico,randomUUID()]);
    const confirmar=vi.fn();
    const adotar=()=>adotarReferenciaConsentida({pool,preparacaoFiscalAtiva:true,confirmar},medico,'a'.repeat(64));
    await registrarConsentimentoFiscal(pool,medico,certificado,usuario);
    await registrarConsentimentoFiscal(pool,medico,certificado,usuario);
    expect((await pool.query('select conta_id,usuario_id,evento,dados from auditoria')).rows).toMatchObject([
      {conta_id:conta,usuario_id:usuario,evento:'consentimento_parametros_fiscais',
        dados:{medicoId:medico,certificadoId:certificado,versao:'continuar-a1-v1'}}
    ]);
    expect(await adotar()).toMatchObject({ok:false,codigo:'CONSENTIMENTO_NAO_REGISTRADO'});
    expect(confirmar).not.toHaveBeenCalled();
    await pool.query("update medico_certificados set status='ativo',valido_de=current_date+1");
    expect(await adotar()).toMatchObject({ok:false,codigo:'CONSENTIMENTO_NAO_REGISTRADO'});
    await pool.query('update medico_certificados set valido_de=current_date-1');
    expect(await adotar()).toEqual({ok:true});
    expect(confirmar).toHaveBeenCalledOnce();
  } finally {
    await pool.end();
    await admin.query('drop database '+nome);
    await admin.end();
  }
});
